// SPDX-License-Identifier: GPL-2.0-or-later
//
// ug-harness.mjs - hardware-only Sprinter harness for executing real DSS
// EXE images on the pinned Z80 core against the UgCard model.
//
// Modelled hardware (no host-side shortcuts):
//   * flat 64 KiB RAM, seeded-random filled at power-up
//   * Sprinter platform ports via full 16-bit IO addresses:
//       00E2h PAGE3 (read/write), 1FFDh PORT_SYSTEM (readable shadow),
//       9FBDh PORT_ISA (A19..A14/AEN/RESET - readable shadow)
//   * ISA-8 window in WIN3 (0C000h..0FFFFh): active iff
//       (system & 10h) != 0  &&  (page3 & F1h) == D0h
//     i.e. the D4h+slot*2 control byte the platform documents for the ISA
//     ports map. While open, memory accesses at 0C000h+ hit the ISA bus:
//       isa_addr = (addr - 0C000h) | ((port_isa & 3Fh) << 14)
//   * DSS entry at PC==0010h (RST 10h): EXIT(41h), PCHARS(5Ch),
//     PUTCHAR(5Bh), SYSTIME(21h), SCANKEY(31h). The handler models the
//     48-byte caller-stack budget; IX/IY may be clobbered by real DSS so
//     the harness does not promise to preserve them (it does not touch
//     them either).
//   * discipline checks while the window is open: PC and SP must stay
//     below 0C000h (code/stack inside the mapped window is a defect);
//     PORT_ISA RESET/AEN pulses are violations.
//
// Deliberately NOT modelled: paging beyond PAGE3, maskable IRQs and disk
// services. NMI delivery is injected below, including the implicit push.
// The EXE must therefore not do file I/O in this milestone.

'use strict';

import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export const PORT_PAGE3 = 0x00E2;
export const PORT_SYSTEM = 0x1FFD;
export const PORT_ISA = 0x9FBD;
export const WIN3_BASE = 0xC000;
export const UGMEM_BASE = 0xBC00;
export const UGMEM_END = 0xBD90;          // UGMEM_BASE + 400
export const DSS_PC = 0x0010;             // RST 10h lands here
export const DSS_STACK_COST = 48;         // bytes a DSS call may spend
export const CPU_HZ = 21_000_000;         // Sprinter 21 MHz
export const RESET_KEY = 0x55475253;

// deterministic PRNG for RAM fill (not crypto - reproducibility only)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function loadZ80(repoDir) {
  globalThis.window = globalThis;         // pinned core probes `window`
  return require(join(repoDir, 'tests/ultrags/dss/Z80core.js'));
}

// ------------------------------ EXE loader ------------------------------
// Parses the supported DSS header layout. The complete file, including
// its consumed header, is loaded at entry-hdrSize; execution starts at entry.
export function parseExe(file) {
  if (file.length < 0x80) throw new Error('EXE too small for header');
  if (file[0] !== 0x45 || file[1] !== 0x58 || file[2] !== 0x45)
    throw new Error('bad EXE magic');
  if (file[3] !== 1) throw new Error(`bad EXE header version ${file[3]}`);
  const hdrSize = file[4] | (file[5] << 8);
  if (hdrSize !== 0x80) throw new Error(`unsupported hdr size ${hdrSize}`);
  const entry = file[16] | (file[17] << 8);
  const entry2 = file[18] | (file[19] << 8);
  const stack = file[20] | (file[21] << 8);
  if (entry !== entry2) throw new Error('entry fields differ');
  if (entry < 0x100 || entry >= 0xC000) throw new Error(`bad entry ${entry}`);
  const body = file.slice(hdrSize);
  if (body.length === 0) throw new Error('empty body');
  const loadAddr = entry - hdrSize;
  const imageEnd = entry + body.length;    // exclusive
  if (imageEnd > 0xC000) throw new Error(`image end ${imageEnd} >= C000h`);
  if (stack < imageEnd + 64 && stack >= loadAddr)
    throw new Error(`stack ${stack} inside/near image (${loadAddr}..${imageEnd})`);
  if (stack >= 0xC000) throw new Error(`stack ${stack} inside ISA window`);
  if (stack < 0x140) throw new Error(`stack ${stack} lacks caller/DSS headroom`);
  return { hdrSize, entry, stack, loadAddr, body, imageEnd };
}

// ------------------------------ machine --------------------------------
export class SprinterMachine {
  constructor({ card, cardSlot = 0, seed = 0xC0FFEE, systemInit = 0x21, page3Init = 0x03, cpuHz = CPU_HZ, commandLine = null, movingClock = false, clockStart = 86390, escAfter = Infinity, logLimit = Infinity, files = {}, disk = {} }) {
    if (![3_500_000, 21_000_000].includes(cpuHz)) throw new Error('unsupported CPU frequency');
    this.files=new Map(Object.entries(files).map(([p,b])=>[p.toUpperCase(),Buffer.from(b)]));
    this.disk=disk; this.fileHandles=new Map(); this.nextFileHandle=1; this.fileCalls=0;
    this.cpuHz = cpuHz;
    this.commandLine = commandLine;
    this.movingClock = movingClock;
    this.clockStart = clockStart;
    this.escAfter = escAfter;
    this.keyCalls = 0;
    this.logLimit = logLimit;
    this.card = card;
    this.cardSlot = cardSlot;
    this.mem = new Uint8Array(0x10000);
    const rnd = mulberry32(seed);
    for (let i = 0; i < 0x10000; i++) this.mem[i] = (rnd() * 256) | 0;
    this.seed = seed;
    this.systemInit = systemInit; this.page3Init = page3Init;
    this.system = systemInit;
    this.page3 = page3Init;
    this.portIsa = 0;
    this.isaLog = [];          // {t, dir:'r'|'w', isa, val}
    this.ioLog = [];           // {t, dir, port, val}
    this.violations = [];
    this.nowFrac = 0;          // sub-us T-state fraction accumulator
    this.dssCalls = [];        // {fn, sp}
    this.text = '';
    this.minSpSeen = 0x10000;
    this.maxSpSeen = 0;
    this.cycles = 0;
    this.exitCode = null;
    this.exited = false;
    this.nmiPending = false;   // a deferred NMI fires after this instr
    this.nmiDelivered = 0;     // count of actually injected NMIs
    this.nmiArmed = false;     // runner marks 0066h a legal handler
    this.nmiArmIsa = null;     // ISA address that arms the deferred NMI
    this.trace = [];
    this.crcEntries=new Set(); this.crcCalls=0;
    this.windows = [];
    this.windowStart = null;
    this.maxWindowUs = 0;
    this.windowCount = 0;
  }

  // Arm a deferred NMI (fires after the next instruction completes).
  armNmi() { this.nmiPending = true; }

  get isaOpen() {
    return (this.system & 0x10) !== 0 && (this.page3 & 0xF1) === 0xD0;
  }
  isaAddr(a) { return (a - WIN3_BASE) | ((this.portIsa & 0x3F) << 14); }
  get isaSlot() { return (this.page3 >> 1) & 1; }

  memRead = (a) => {
    a &= 0xFFFF;
    if (a >= WIN3_BASE && this.isaOpen) {
      const isa = this.isaAddr(a);
      const v = this.card && this.isaSlot === this.cardSlot ? this.card.readPort(isa) : 0xFF;
      if (this.isaLog.length < this.logLimit) this.isaLog.push({ t: this.cycles, dir: 'r', slot: this.isaSlot, isa, val: v });
      return v;
    }
    return this.mem[a];
  };
  memWrite = (a, v) => {
    a &= 0xFFFF; v &= 0xFF;
    if (a >= WIN3_BASE && this.isaOpen) {
      const isa = this.isaAddr(a);
      if (this.isaLog.length < this.logLimit) this.isaLog.push({ t: this.cycles, dir: 'w', slot: this.isaSlot, isa, val: v });
      // NMI trigger: arms when the bus write hits the configured ISA
      // address (used to land an NMI inside a switched-SP burst)
      if (this.nmiArmIsa !== null && isa === this.nmiArmIsa && !this.nmiPending)
        this.nmiPending = true;
      if (this.card && this.isaSlot === this.cardSlot) this.card.writePort(isa, v);
      return;
    }
    this.mem[a] = v;
  };
  ioRead = (p) => {
    p &= 0xFFFF;
    if (this.ioLog.length < this.logLimit) this.ioLog.push({ t: this.cycles, dir: 'in', port: p });
    if (p === PORT_PAGE3) return this.page3;             // readable shadow
    if (p === PORT_SYSTEM) return this.system;           // DCP read-back
    if (p === PORT_ISA) return this.portIsa;
    return 0xFF;
  };
  ioWrite = (p, v) => {
    p &= 0xFFFF; v &= 0xFF;
    if (this.ioLog.length < this.logLimit) this.ioLog.push({ t: this.cycles, dir: 'out', port: p, val: v });
    if (p === PORT_PAGE3 || p === PORT_SYSTEM) {
      const before = this.isaOpen;
      if (p === PORT_PAGE3) this.page3 = v;
      else this.system = v;
      if (!before && this.isaOpen) this.windowStart = this.cycles;
      if (before && !this.isaOpen && this.windowStart !== null) {
        this.windowCount++;
        this.maxWindowUs = Math.max(this.maxWindowUs, (this.cycles - this.windowStart) * 1e6 / this.cpuHz);
        if (this.windows.length < this.logLimit) this.windows.push({ cycles: this.cycles - this.windowStart,
          us: (this.cycles - this.windowStart) * 1e6 / this.cpuHz });
        this.windowStart = null;
      }
      return;
    }
    if (p === PORT_ISA) {
      if (v & 0xC2)                                      // RESET/AEN/reset-pulse bits
        this.violations.push(`PORT_ISA forbidden bits written: ${v.toString(16)}`);
      this.portIsa = v; return;
    }
  };

  // advance model time by real T-states (21 MHz -> ~47.6ns per T)
  tick(tstates) {
    this.cycles += tstates;
    this.nowFrac += tstates;
    const ticksPerUs = this.cpuHz / 1e6;
    const us = Math.floor(this.nowFrac / ticksPerUs);
    if (us > 0) { this.nowFrac -= us * ticksPerUs; this.card?.tickUs(us); }
  }

  // true while the card holds an active data grant (BEGIN .. END/CANCEL)
  grantActive() {
    return !!(this.card && this.card.transfer);
  }

  // DSS call emulation; PC already at 0010h with ret addr pushed on stack
  dssCall(st) {
    const sp = st.sp;
    const ret = this.mem[sp] | (this.mem[sp + 1] << 8);
    if (this.dssCalls.length < this.logLimit) this.dssCalls.push({ fn: st.c, sp });
    // hard rule: DSS must never run while the ISA window is mapped or a
    // card transfer grant is open (spec 12.1 serialization)
    if (this.isaOpen)
      this.violations.push(`DSS call C=${st.c.toString(16)} while ISA window open`);
    if (this.grantActive() && ![0x21,0x31].includes(st.c))
      this.violations.push(`DSS call C=${st.c.toString(16)} while transfer grant active`);
    // DSS may spend up to 48 bytes below SP; flag only when that range
    // physically overlaps the library workspace [UGMEM_BASE,UGMEM_END)
    if (sp >= UGMEM_BASE && sp - DSS_STACK_COST < UGMEM_END)
      this.violations.push(`DSS stack budget underflow: SP=${sp.toString(16)}`);
    if([0x0a,0x0e,0x11,0x12,0x13,0x14,0x15].includes(st.c)) {
      this.fileCalls++;
      const flags=st.flags??{};
      const fail=(e=6)=>{st.a=e;st.flags={...flags,C:1};};
      const success=()=>{st.flags={...flags,C:0};};
      const path=()=>{let a=(st.h<<8)|st.l,s='';while(this.mem[a])s+=String.fromCharCode(this.mem[a++]);return s.toUpperCase();};
      const file=this.fileHandles.get(st.a),key=path();
      if(this.disk.failAt===this.fileCalls || this.disk.failFn===st.c)fail();
      else if(st.c===0x11) {
        if(!this.files.has(key))fail(3);
        else {st.a=this.nextFileHandle++;this.fileHandles.set(st.a,{path:key,pos:0});success();}
      } else if(st.c===0x0a) {
        this.files.set(key,Buffer.alloc(0));st.a=this.nextFileHandle++;
        this.fileHandles.set(st.a,{path:key,pos:0});success();
      } else if(st.c===0x0e) {this.files.delete(key);success();}
      else if(!file)fail(7);
      else if(st.c===0x12) {this.fileHandles.delete(st.a);success();}
      else if(st.c===0x15) {
        const offset=((st.h<<8)|st.l)*65536+st.ix;
        const pos=(st.b===2?this.files.get(file.path).length:st.b===1?file.pos:0)+offset;
        if(pos>0xffffffff)fail();else {file.pos=pos;st.ix=pos&65535;st.h=(pos>>>24)&255;st.l=(pos>>>16)&255;success();}
      } else {
        const ptr=(st.h<<8)|st.l,wanted=(st.d<<8)|st.e;
        let n=Math.min(wanted,st.c===0x13?(this.disk.shortRead??wanted):(this.disk.shortWrite??wanted));
        let bytes=this.files.get(file.path);
        if(st.c===0x13){n=Math.min(n,Math.max(0,bytes.length-file.pos));this.mem.set(bytes.subarray(file.pos,file.pos+n),ptr);}
        else {if(file.pos+n>bytes.length){const grow=Buffer.alloc(file.pos+n);bytes.copy(grow);bytes=grow;this.files.set(file.path,bytes);}bytes.set(this.mem.subarray(ptr,ptr+n),file.pos);}
        file.pos+=n;st.d=n>>8;st.e=n&255;success();
      }
      if(this.disk.delayUs)this.tick(this.disk.delayUs*this.cpuHz/1e6);
      st.pc=ret;st.sp=sp+2;return null;
    }
    switch (st.c) {
      case 0x41:                                       // EXIT, B=code
        this.exitCode = st.b;
        this.exited = true;
        return 'exit';
      case 0x5C: {                                     // PCHARS HL->ASCIIZ
        let hl = (st.h << 8) | st.l, s = '';
        for (let i = 0; i < 4096; i++) {
          const ch = this.mem[(hl + i) & 0xFFFF];
          if (ch === 0) break;
          s += String.fromCharCode(ch);
        }
        this.text += s;
        break;
      }
      case 0x5B:                                       // PUTCHAR A
        this.text += String.fromCharCode(st.a);
        break;
      case 0x21:                                       // SYSTIME -> H,L,B
        if (this.movingClock) {
          const sec = (this.clockStart + Math.floor(this.cycles / this.cpuHz)) % 86400;
          st.h = Math.floor(sec / 3600); st.l = Math.floor(sec / 60) % 60; st.b = sec % 60;
        } else { st.h = 12; st.l = 34; st.b = 56; }
        break;
      case 0x31:                                       // SCANKEY -> A
        st.a = ++this.keyCalls >= this.escAfter ? 27 : 0;
        break;
      default:
        this.violations.push(`unimplemented DSS call C=${st.c.toString(16)}`);
    }
    st.pc = ret;
    st.sp = sp + 2;                                    // emulate RET
    return null;
  }
}

// Run a loaded image on the pinned core. opts.budget bounds instructions.
// Returns {exitCode, steps, cycles, end, machine}.
export function runImage(Z80, mach, { entry, stack, iff = 1, budget = 4_000_000 }) {
  const z = new Z80({
    mem_read: mach.memRead,
    mem_write: mach.memWrite,
    io_read: mach.ioRead,
    io_write: mach.ioWrite,
  });
  mach.z = z;
  z.reset();
  const st0 = z.getState();
  st0.pc = entry; st0.sp = stack;
  if (mach.commandLine !== null) {
    const bytes = Buffer.from(mach.commandLine, 'ascii');
    if (bytes.length > 255) throw new Error('CLI too long');
    mach.mem[0x6000] = bytes.length;
    mach.mem.set(bytes, 0x6001);
    st0.ix = 0x6000;
  }
  st0.iff1 = !!iff; st0.iff2 = !!iff; st0.imode = 1;
  z.setState(st0);

  let steps = 0;
  while (!mach.exited && steps < budget) {
    const st = z.getState();
    if (st.pc === DSS_PC) {
      if (mach.dssCall(st) === 'exit') break;
      z.setState(st);
      continue;                                        // call, not instruction
    }
    if (st.pc === 0x0008 || st.pc === 0x0000 || st.pc === 0x0038 ||
        (st.pc === 0x0066 && !mach.nmiArmed)) {
      mach.violations.push(`trap vector executed: PC=${st.pc.toString(16)}`);
      break;
    }
    if (st.pc >= WIN3_BASE && mach.isaOpen)
      mach.violations.push(`code fetch inside ISA window: PC=${st.pc.toString(16)}`);
    if (st.sp >= WIN3_BASE && mach.isaOpen)
      mach.violations.push(`stack inside ISA window: SP=${st.sp.toString(16)}`);
    // SP physically inside the library workspace corrupts host state;
    // a data-pointer SP below the workspace (STACK-burst) is legal.
    if (st.sp >= UGMEM_BASE && st.sp < UGMEM_END)
      mach.violations.push(`stack inside library workspace: SP=${st.sp.toString(16)}`);
    if (st.sp < mach.minSpSeen) mach.minSpSeen = st.sp;
    if (st.sp > mach.maxSpSeen) mach.maxSpSeen = st.sp;
    if(mach.crcEntries.has(st.pc))mach.crcCalls++;
    mach.trace.push({ pc: st.pc, sp: st.sp, iff1: st.iff1 });
    if (mach.trace.length > 16) mach.trace.shift();
    mach.tick(z.run_instruction());
    steps++;
    // deferred NMI: fires after the armed instruction completes.  Real
    // semantics: PC is pushed through the CURRENT SP (which may be a
    // switched data pointer - that is exactly the spec-11.4 hazard) and
    // execution continues at 0066h with IFF1 cleared.
    if (mach.nmiPending) {
      mach.nmiPending = false;
      const s2 = z.getState();
      const nsp = (s2.sp - 2) & 0xFFFF;
      mach.memWrite(nsp + 1, (s2.pc >> 8) & 0xFF);   // high then low (Z80 push)
      mach.memWrite(nsp, s2.pc & 0xFF);
      s2.sp = nsp; s2.pc = 0x0066; s2.iff2 = s2.iff1; s2.iff1 = false;
      z.setState(s2);
      mach.nmiDelivered++;
      mach.tick(11);                                   // NMI acknowledge + push
    }
  }
  const end = z.getState();
  if (!mach.exited && steps >= budget)
    mach.violations.push(`instruction budget exhausted: PC=${end.pc.toString(16)}`);
  return { exitCode: mach.exitCode, steps, cycles: mach.cycles, end, machine: mach };
}
