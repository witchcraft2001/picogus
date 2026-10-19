#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// run-ugdiag.mjs - milestone-2/3 vertical proof: assemble the real DSS
// EXEs (UGDIAG.ASM plus the named self-test binaries), load each through
// the real header parser, and execute instruction-by-instruction on the
// pinned Z80 core against the strict UgCard model through the emulated
// Sprinter ISA-8 window.  No host-side shortcuts: every request byte,
// grant, bulk byte and reply crosses the ISA window in the model.
//
// Vertical scenarios:
//   main      - full write/read/compare roundtrip + SNAP + GS latch
//   ctxB      - different PAGE3 + IFF=0 restore; canonical DSS SYSTEM
//   slowio    - execDelay 200us -> real BUSY polling loops
//   absent    - card absent: honest fail at UG_OPEN
//   wrongmode - card strapped to another multifw mode: honest fail
//
// Named self-tests (each must fail/pass for ITS defect, machine bytes
// on the pinned core): st-dsswin, st-dssgrant, st-nest, st-badslot,
// st-overgrant, st-ctxpg3, st-ctxsys, st-ctxiff, st-ctxsp, st-budget,
// st-alias, st-nmiunsafe, st-nmihaz.  Loader negatives: bad magic,
// truncated, entry/stack at C000h, stack inside image, image over C000h.
//
// Usage: node tests/ultrags/dss/run-ugdiag.mjs <repo> [build_dir]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { verifyBuild, executionInputs, dssExeName } from '../../../tools/ultrags/build-evidence.mjs';
import {
  loadZ80, parseExe, SprinterMachine, runImage, WIN3_BASE,
  PORT_PAGE3, PORT_SYSTEM, PORT_ISA,
} from './ug-harness.mjs';

const require = createRequire(import.meta.url);
const UgCard = require('./ug-card.js');

const REPO = resolve(process.argv[2] || '.');
const BUILD = process.argv[3] || 'build/ultrags';
// --exe-dir=DIR: run prebuilt EXEs (what `make dss` produced) instead of
// reassembling - this is what makes the packaged-bytes == executed-bytes
// identity chain honest.
const exeDirArg = process.argv.find((a) => a.startsWith('--exe-dir='));
const EXEDIR = exeDirArg ? resolve(exeDirArg.split('=')[1]) : null;
const SRC = join(REPO, 'host/sprinter/ultrags/apps/ugdiag.asm');
const STDIR = join(REPO, 'host/sprinter/ultrags/selftest');
const OUTDIR = EXEDIR || join(BUILD, 'dss');
const EXE = join(OUTDIR, 'UGDIAG.EXE');
const LOGS = join(BUILD, 'logs');
const INCDIR = join(REPO, 'host/sprinter/ultrags/include');
const LIBDIR = join(REPO, 'host/sprinter/ultrags/lib');
const GENDIR = join(BUILD, 'gen');

const UG_N = 256;
const RESULT = 0xBA00;
const CARD_BASE = 0x2A0;
const CARD_ALIAS = 0x260;                    // st-alias scenario config
const STG_DONE = 13, STG_OPEN = 2, STG_INIT = 1;

const results = [];
let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; results.push({ name: n, ok: true, detail: d }); console.log(`PASS ${n}${d ? ' -- ' + d : ''}`); };
const bad = (n, d = '') => { fail++; results.push({ name: n, ok: false, detail: d }); console.log(`FAIL ${n} -- ${d}`); };
const hex = (n, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
// same pattern the ASM emits, computed independently: v[i] = (i*13+7)&0xFF
const pattern = () => { const b = new Uint8Array(UG_N); let v = 7;
  for (let i = 0; i < UG_N; i++) { b[i] = v; v = (v + 13) & 0xFF; } return b; };

mkdirSync(OUTDIR, { recursive: true });
mkdirSync(LOGS, { recursive: true });

// Assemble the whole set once; prebuilt mode verifies content provenance.
if (!EXEDIR) execFileSync(process.execPath, [join(REPO, 'tests/ultrags/dss/assemble.mjs'), REPO, OUTDIR], { stdio: 'pipe' });
const assemblyEvidence = verifyBuild(REPO, OUTDIR);
const executed = new Map();
function loadExecuted(path) {
  const bytes = readFileSync(path);
  executed.set(path.split('/').at(-1), { name: path.split('/').at(-1), size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  return bytes;
}

// ---- 1. obtain the real EXE (assemble, or load the prebuilt artifact) ----
let exe = null, hdr = null;
try {
  exe = loadExecuted(EXE);
  ok(EXEDIR ? 'load UGDIAG.EXE (prebuilt)' : 'assemble UGDIAG.EXE', `${exe.length} bytes sha256=${sha256(EXE).slice(0, 16)}`);
} catch (e) {
  bad('prepare UGDIAG.EXE', String(e.stdout || e.stderr || e.message).split('\n').slice(0, 12).join(' | '));
  done([]);
}
try {
  hdr = parseExe(exe);
  if (hdr.entry !== 0x8080 || hdr.stack !== 0xBFFE || hdr.loadAddr !== 0x8000)
    throw new Error(`unexpected hdr ${JSON.stringify({ entry: hdr.entry, stack: hdr.stack, loadAddr: hdr.loadAddr })}`);
  ok('exe header parse', `entry=${hex(hdr.entry)} stack=${hex(hdr.stack)} body=${hdr.body.length}B imageEnd=${hex(hdr.imageEnd)}`);
} catch (e) { bad('exe header parse', e.message); done([]); }

// ---- 1b. loader negatives (named, no machine bytes needed) ----
for (const [name, mutate, why] of [
  ['bad magic', (b) => { b[0] = 0x58; return b; }, 'bad EXE magic'],
  ['truncated header', (b) => b.slice(0, 0x40), 'too small'],
  ['entry at C000', (b) => { b[16] = 0x00; b[17] = 0xC0; b[18] = 0x00; b[19] = 0xC0; return b; }, 'bad entry'],
  ['stack at C000', (b) => { b[20] = 0x00; b[21] = 0xC0; return b; }, 'inside ISA window'],
  ['stack inside image', (b) => { b[20] = 0x81; b[21] = 0x80; return b; }, 'inside/near image'],
]) {
  try {
    parseExe(mutate(Buffer.from(exe)));
    bad(`loader: ${name}`, 'parseExe accepted a defective image');
  } catch (e) {
    e.message.toLowerCase().includes(why.toLowerCase())
      ? ok(`loader: ${name}`, e.message)
      : bad(`loader: ${name}`, e.message);
  }
}
// image end past C000: craft a header with a body exactly to C001
{
  const b = Buffer.alloc(0x80 + 0x101);
  exe.copy(b, 0, 0, 0x80);
  b[16] = 0x01; b[17] = 0xBF; b[18] = 0x01; b[19] = 0xBF;      // entry=BF01 -> end >C000
  b[20] = 0xFE; b[21] = 0xBF;                                  // stack BFFE valid
  try { parseExe(b); bad('loader: image over C000', 'accepted'); }
  catch (e) { e.message.includes('image end') ? ok('loader: image over C000', e.message) : bad('loader: image over C000', e.message); }
}

const Z80 = loadZ80(REPO);
const runs = [];

// ---- 2. the vertical roundtrip under a given machine context ----
function scenario(tag, { systemInit, page3Init, iff, absent = false, mode = 8,
                         execDelayUs = 0, noReply = false, alias, cardBase = CARD_BASE, cardSlot = 0 }) {
  const card = new UgCard({ absent, mode, execDelayUs, noReply, alias, base: cardBase });
  const mach = new SprinterMachine({ card, cardSlot, seed: 0x5EED01, systemInit, page3Init });
  mach.mem.set(exe, hdr.loadAddr);
  const run = runImage(Z80, mach, { entry: hdr.entry, stack: hdr.stack, iff });
  const fin = mach.z.getState();
  const res = mach.mem.slice(RESULT, RESULT + 32);
  const rd16 = (o) => res[o] | (res[o + 1] << 8);
  const ctx = { card, mach, run, fin, res, rd16, tag, iffExpected: iff };
  runs.push(ctx);
  return ctx;
}

function checkRoundtrip({ card, mach, run, fin, res, rd16, tag, iffExpected }) {
  const stage = res[2], err = res[3];
  mach.exited ? ok(`${tag}: EXIT reached`, `code=${mach.exitCode} ${run.steps} instrs ${run.cycles}T`)
    : bad(`${tag}: EXIT`, `no exit after ${run.steps} instrs PC=${hex(fin.pc)} viol=${mach.violations[0] || 'none'}`);
  res[0] === 0x55 && res[1] === 0xAA ? ok(`${tag}: result magic`)
    : bad(`${tag}: result magic`, `got=${hex(res[1] * 256 + res[0])}`);
  stage === STG_DONE && err === 0 && mach.exitCode === 0
    ? ok(`${tag}: all stages clean`, `stage=${stage}`)
    : bad(`${tag}: stages`, `stage=${stage} err=${err} exit=${mach.exitCode}`);
  !!fin.iff1 === !!iffExpected && mach.system === mach.systemInit && mach.page3 === mach.page3Init
    ? ok(`${tag}: ctx restored`, `system=${hex(mach.system, 2)} page3=${hex(mach.page3, 2)} iff=${fin.iff1}`)
    : bad(`${tag}: ctx restored`, `system=${hex(mach.system, 2)}/${hex(mach.systemInit, 2)} page3=${hex(mach.page3, 2)}/${hex(mach.page3Init, 2)} iff1=${fin.iff1}/${iffExpected}`);
  mach.maxDiUs < 2000 && mach.maxWindowUs < mach.maxDiUs
    ? ok(`${tag}: full DI budget`, `${mach.maxDiUs.toFixed(2)}us; ISA ${mach.maxWindowUs.toFixed(2)}us`)
    : bad(`${tag}: full DI budget`, `${mach.maxDiUs}us`);
  mach.isaOpen === false ? ok(`${tag}: window closed`)
    : bad(`${tag}: window closed`, `page3=${hex(mach.page3, 2)}`);
  const wrBlk = mach.isaLog.filter((e) => e.dir === 'w' && e.isa === CARD_BASE).length;
  const rdBlk = mach.isaLog.filter((e) => e.dir === 'r' && e.isa === CARD_BASE).length;
  wrBlk === UG_N && rdBlk === UG_N
    ? ok(`${tag}: bulk bytes`, `wr=${wrBlk} rd=${rdBlk}`)
    : bad(`${tag}: bulk bytes`, `wr=${wrBlk} rd=${rdBlk}`);
  const commit = card.log.find((e) => e.ev === 'commit');
  const pat = pattern();
  const inPsram = commit ? card.psram.slice(commit.off, commit.off + commit.n) : new Uint8Array(0);
  commit && commit.n === UG_N && Buffer.compare(Buffer.from(inPsram), Buffer.from(pat)) === 0
    ? ok(`${tag}: PSRAM matches pattern`, `${commit.n}B @${hex(commit.off)}`)
    : bad(`${tag}: PSRAM`, commit ? 'content mismatch' : 'no commit logged');
  const rx = mach.mem.slice(0xB900, 0xB900 + UG_N);
  Buffer.compare(Buffer.from(rx), Buffer.from(pat)) === 0 && rd16(12) === 0 && rd16(10) === UG_N
    ? ok(`${tag}: Z80 compare 0 mismatches`, `compared=${rd16(10)}`)
    : bad(`${tag}: compare`, `mismatches=${rd16(12)} first=${rd16(14)}`);
  res[18] === 0x5A ? ok(`${tag}: GS latch roundtrip`, `gs0=${hex(res[18], 2)}`)
    : bad(`${tag}: GS latch`, `gs0=${hex(res[18], 2)}`);
  res[19] === 1 && card.snapSeq === 1
    ? ok(`${tag}: SNAP capture`, `snap0=${res[19]} seq=${card.snapSeq}`)
    : bad(`${tag}: SNAP`, `snap0=${res[19]} seq=${card.snapSeq}`);
  card.objects.size === 0 && card.transfer === null && card.xerr === 0 && card.gserr === 0
    && card.freeList.reduce((a, e) => a + e.size, 0) === UgCard.PSRAM_BYTES
    ? ok(`${tag}: card state clean`)
    : bad(`${tag}: card state`, `objs=${card.objects.size} xfer=${!!card.transfer} xerr=${card.xerr} gserr=${card.gserr}`);
  card.diag.blockCrcs === 0
    ? ok(`${tag}: FAST did no block CRC`, `blockCrcs=${card.diag.blockCrcs}`)
    : bad(`${tag}: block CRC`, `blockCrcs=${card.diag.blockCrcs}`);
}

function checkHonestFail({ card, mach, run, fin, res, rd16, tag, expectErr }) {
  mach.exited ? ok(`${tag}: EXIT reached`, `code=${mach.exitCode}`)
    : bad(`${tag}: EXIT`, `no exit; PC=${hex(fin.pc)}`);
  const stage = res[2], err = res[3];
  stage === STG_INIT && err === expectErr && mach.exitCode === STG_OPEN
    ? ok(`${tag}: honest absence failure`, `stage=${stage} err=${hex(err, 2)} exit=${mach.exitCode}`)
    : bad(`${tag}: absence failure`, `stage=${stage} err=${hex(err, 2)} exit=${mach.exitCode}`);
  mach.system === mach.systemInit && mach.page3 === mach.page3Init
    ? ok(`${tag}: ctx restored on failure`, `system=${hex(mach.system, 2)} page3=${hex(mach.page3, 2)}`)
    : bad(`${tag}: ctx restored`, `system=${hex(mach.system, 2)}/${hex(mach.systemInit, 2)} page3=${hex(mach.page3, 2)}/${hex(mach.page3Init, 2)}`);
  card.objects.size === 0 ? ok(`${tag}: no objects leaked`) : bad(`${tag}: objects`, `${card.objects.size}`);
  // spec 5 ordering: config-port activity only, never a BASE access
  const baseTouched = mach.isaLog.some((e) => e.isa >= CARD_BASE && e.isa < CARD_BASE + 0x20);
  !baseTouched ? ok(`${tag}: no BASE register access before gate`)
    : bad(`${tag}: gate order`, `BASE touched on failed open`);
}

// ---- 3. vertical scenarios ----
{
  const s = scenario('main', { systemInit: 0x01, page3Init: 0x03, iff: 1 });
  console.log(`console(main): ${JSON.stringify(s.mach.text.trim())}`);
  checkRoundtrip(s);
  // ISA open sequence: PAGE3 read, Turbo off, then ISA mapping writes
  const io = s.mach.ioLog.map((e) => e.dir === 'out' ? `W${e.port.toString(16)}=${e.val}` : `R${e.port.toString(16)}`);
  const i = [io.indexOf('Re2'), io.indexOf('W3c=2'), io.indexOf('W1ffd=17'), io.indexOf('We2=212'), io.indexOf('W9fbd=0')];
  i.every((x) => x >= 0) && !io.includes('R1ffd') && i[0] < i[1] && i[1] < i[2] && i[2] < i[3] && i[3] < i[4]
    ? ok('isa-open sequence', i.map((x) => io[x]).join(' '))
    : bad('isa-open sequence', io.slice(0, 12).join(' '));
  // spec 5 order: EVERY config-port access precedes the first BASE access
  const firstBase = s.mach.isaLog.findIndex((e) => e.isa >= CARD_BASE && e.isa < CARD_BASE + 0x20);
  const cfgLog = s.mach.isaLog.slice(0, firstBase === -1 ? 0 : firstBase);
  const cfgOps = cfgLog.filter((e) => e.isa >= 0x1D0 && e.isa <= 0x1D2);
  const unlock = cfgOps.find((e) => e.dir === 'w' && e.isa === 0x1D0 && e.val === 0xCC);
  const selFw = cfgOps.find((e) => e.dir === 'w' && e.isa === 0x1D0 && e.val === 0xE4);
  const readFw = cfgOps.findIndex((e) => e.dir === 'r' && e.isa === 0x1D2
    && cfgOps.indexOf(selFw) < cfgOps.indexOf(e));
  firstBase > 0 && unlock && selFw && readFw > cfgOps.indexOf(selFw)
    ? ok('config gate before BASE', `unlock@${cfgOps.indexOf(unlock)} selE4@${cfgOps.indexOf(selFw)} readE4@${readFw} firstBase=${firstBase}`)
    : bad('config gate before BASE', `firstBase=${firstBase} cfgOps=${cfgOps.length}`);
  // FRAME_CRC request observed: header0 has bit7 set on the INFO frame
  const firstReq = s.mach.isaLog.find((e) => e.dir === 'w' && e.isa === CARD_BASE + 3);
  firstReq && (firstReq.val & 0x80) === 0x80
    ? ok('FRAME_CRC request observed', `hdr0=${hex(firstReq.val, 2)}`)
    : bad('FRAME_CRC request', firstReq ? `hdr0=${hex(firstReq.val, 2)}` : 'none');
  // bounded windows: every op opens/closes. Count open events
  // (SYSTEM write 11h) and verify they dominate a single open.
  const opens = s.mach.ioLog.filter((e) => e.dir === 'out' && e.port === 0x1FFD && e.val === 0x11).length;
  opens >= 12
    ? ok('bounded per-op windows', `${opens} ISA opens`)
    : bad('bounded windows', `only ${opens} ISA opens (window held open)`);
}
{
  const s = scenario('ctxB', { systemInit: 0x01, page3Init: 0xE9, iff: 0 });
  checkRoundtrip(s);                     // same roundtrip, foreign ctx + IFF=0
}
{
  // EXEC/PREPARING exercised: replies land only after 1000us of card time;
  // the ASM X_STATUS poll loop must really wait for the REPLY bit
  const s = scenario('slowio', { systemInit: 0x01, page3Init: 0x03, iff: 1, execDelayUs: 1000 });
  checkRoundtrip(s);
  const polls = s.mach.isaLog.filter((e) => e.dir === 'r' && e.isa === CARD_BASE + 1).length;
  polls > 40 ? ok('slowio: BUSY polling real', `${polls} X_STATUS reads`)
    : bad('slowio: polling', `only ${polls} status reads`);
}
{
  const s = scenario('absent', { systemInit: 0x01, page3Init: 0x03, iff: 1, absent: true });
  checkHonestFail({ ...s, expectErr: 0x0D });
}
{
  const s = scenario('wrongmode', { systemInit: 0x01, page3Init: 0x03, iff: 1, mode: 1 });
  checkHonestFail({ ...s, expectErr: 0x06 });
}
{
  const s = scenario('wrongslot', { systemInit: 0x01, page3Init: 0x03, iff: 1, cardSlot: 1 });
  checkHonestFail({ ...s, expectErr: 0x0D });
}

// ---- 4. named self-tests: assembled machine bytes on the pinned core ----
// Each entry: file, card opts, nmi opts, expect(mach,card,res)->string|null
const SELFTESTS = [
  ['st-dsswin', {}, {}, (m) => m.violations.some((v) => v.includes('DSS call') && v.includes('ISA window'))
    ? null : 'no DSS-while-window violation'],
  ['st-dssgrant', {}, {}, (m) => m.violations.some((v) => v.includes('grant active'))
    ? null : 'no DSS-while-grant violation'],
  ['st-nest', {}, {}, (m, c, r) =>
      (m.exitCode === 0 && r[3] === 0 && m.violations.length === 0) ? null : `exit=${m.exitCode} err=${r[3]} viol=${m.violations[0] || ''}`],
  ['st-badslot', { cardSlot: 1 }, {}, (m, c, r) => {
      if (m.exitCode !== 0 || r[3] !== 0) return `exit=${m.exitCode} err=${r[3]}`;
      // slot-2/3 opens must produce ZERO bus traffic; the whole run has
      // exactly the slot-1 UG_OPEN sequence (two confirmed selects per register: 16W+13R cfg + 2R api = 31)
      return m.isaLog.length === 31 && m.isaLog.every(e => e.slot === 1)
        ? null : `isaLog=${m.isaLog.length} (bad-slot opens leaked bus writes)`;
    }],
  ['st-respbuf', {}, {}, (m, c, r) => {
      // aliased + distinct destinations, exact-fit and OVERFLOW reject,
      // nonzero wire status - and no leaked objects at the end
      if (m.exitCode !== 0 || r[3] !== 0) return `exit=${m.exitCode} err=${r[3]}`;
      return c.objects.size === 0 ? null : `leaked objects=${c.objects.size}`;
    }],
  ['st-verified', {}, {}, (m, c, r) => {
      if (m.exitCode !== 0 || r[3] !== 0) return `exit=${m.exitCode} err=${r[3]}`;
      // VERIFIED write BEGIN must carry a 13-byte request on the wire
      const i = m.isaLog.findIndex((e) => e.dir === 'w' && e.isa === CARD_BASE + 3 && e.val === 0x20);
      if (i < 0 || m.isaLog[i + 1].val !== 13) return 'BEGIN req not 13B';
      return c.diag.blockCrcs >= 1 ? null : `blockCrcs=${c.diag.blockCrcs}`;
    }],
  ['st-badcrc', {}, {}, (m, c, r) => {
      // forged host crc -> card X_CRC; no transfer may survive/pin
      if (m.exitCode !== 0 || r[3] !== 0) return `exit=${m.exitCode} err=${r[3]}`;
      return (c.transfer === null && c.xerr === 0x04) ? null : `xfer=${!!c.transfer} xerr=${c.xerr}`;
    }],
  ['st-cancel', {}, {}, (m, c, r) => {
      if (m.exitCode !== 0 || r[3] !== 0) return `exit=${m.exitCode} err=${r[3]}`;
      const cancelled = m.isaLog.some((e) => e.dir === 'w' && e.isa === CARD_BASE + 3 && e.val === 0x24);
      return (cancelled && c.transfer === null && c.objects.size === 0)
        ? null : `cancelFrame=${cancelled} xfer=${!!c.transfer} objs=${c.objects.size}`;
    }],
  ['st-transport', {}, {}, (m, c, r) => {
      if (m.exitCode !== 0 || r[3] !== 0) return `exit=${m.exitCode} err=${r[3]}`;
      // the 4 rejected calls must not touch the bus: only ALLOC(7B) +
      // FREE(4B) request writes and ZERO bulk-data writes exist
      const reqW = m.isaLog.filter((e) => e.dir === 'w' && e.isa === CARD_BASE + 3).length;
      const blkW = m.isaLog.filter((e) => e.dir === 'w' && e.isa === CARD_BASE).length;
      return (reqW === 11 && blkW === 0) ? null : `reqW=${reqW} blkW=${blkW}`;
    }],
  ['st-overgrant', {}, {}, (m, c, r) =>
      (m.exitCode === 0 && c.xerr === 0x0E) ? null : `exit=${m.exitCode} xerr=${c.xerr}`],
  ['st-ctxpg3', {}, {}, (m, c, r) =>
      (m.exitCode === 0 && m.page3 === 0x99) ? null : `exit=${m.exitCode} page3=${hex(m.page3, 2)}`],
  ['st-ctxsys', {}, {}, (m, c, r) =>
      (m.exitCode === 0 && m.system === 0x01) ? null : `exit=${m.exitCode} system=${hex(m.system, 2)}`],
  ['st-ctxiff', { iff: 1 }, {}, (m, c, r) =>
      (m.exitCode === 0 && !m.z.getState().iff1) ? null : `exit=${m.exitCode} iff1=${m.z.getState().iff1}`],
  ['st-ctxsp', {}, {}, (m, c, r) => m.violations.some((v) => v.includes('stack inside ISA window'))
    ? null : 'no stack-in-window violation'],
  ['st-budget', { noReply: true }, {}, (m, c, r, run) =>
      (m.exitCode === 0 && run.steps < 2_000_000
        && m.isaLog.some((e) => e.dir === 'w' && e.isa === CARD_BASE + 2 && e.val === 0xA0))
        ? null : `exit=${m.exitCode} steps=${run.steps} reset=${m.isaLog.some((e) => e.val === 0xA0)}`],
  ['st-alias', { alias: CARD_ALIAS }, {}, (m, c, r) => {
      // byte 33 must escape the 32B alias window: a write past 0x260+0x20
      const esc = m.isaLog.filter((e) => e.dir === 'w' && e.isa >= CARD_ALIAS && e.isa < CARD_ALIAS + 0x20);
      const beyond = m.isaLog.filter((e) => e.dir === 'w' && e.isa === CARD_ALIAS + 0x20);
      return (esc.length === 32 && beyond.length === 1 && m.exitCode === 0)
        ? null : `aliasWrites=${esc.length} beyond=${beyond.length} exit=${m.exitCode}`;
    }],
  ['st-nosession', {}, {}, (m, c, r) => {
      // no UG_OPEN was ever called: every public ISA path must fail
      // STATE with literally zero IO writes and zero ISA transactions
      if (m.exitCode !== 0 || r[3] !== 0) return `exit=${m.exitCode} err=${r[3]}`;
      return (m.ioLog.length === 0 && m.isaLog.length === 0)
        ? null : `ioLog=${m.ioLog.length} isaLog=${m.isaLog.length}`;
    }],
  ['st-framecrc', {}, {}, (m, c, r) => {
      // pure-ABI test (no session, no window): the 0/1 accept and the
      // BAD_ARGUMENT refusals must produce zero bus traffic at all
      if (m.exitCode !== 0 || r[3] !== 0) return `exit=${m.exitCode} err=${r[3]}`;
      return (m.ioLog.length === 0 && m.isaLog.length === 0)
        ? null : `ioLog=${m.ioLog.length} isaLog=${m.isaLog.length}`;
    }],
  ['st-nmiunsafe', {}, {}, (m, c, r) => {
      if (m.exitCode !== 0 || r[3] !== 0) return `exit=${m.exitCode} err=${r[3]}`;
      // The refused UG_WRITE_STACK must add ZERO bus entries. The only
      // allowed pre-call traffic is exactly one request frame: ALLOC
      // (op+len+5 payload = 7 byte-writes to X_REQUEST = BASE+3).
      const reqW = m.isaLog.filter((e) => e.dir === 'w' && e.isa === CARD_BASE + 3);
      if (reqW.length !== 7) return `X_REQUEST writes=${reqW.length} (expected 7: one ALLOC frame)`;
      // after the last frame byte only reads may follow (status polls,
      // response, trailer) - a BEGIN or any bulk write is forbidden
      const lastW = m.isaLog.reduce((ix, e, i) =>
        (e.dir === 'w' && e.isa === CARD_BASE + 3 ? i : ix), -1);
      if (m.isaLog.slice(lastW + 1).some((e) => e.dir === 'w'))
        return 'isa write after the ALLOC frame';
      const blk = m.isaLog.filter((e) => e.isa === CARD_BASE).length;
      if (blk !== 0) return `BULK_DATA accesses=${blk}`;
      // window accounting on ioLog: every window open writes
      // PORT_ISA=0 and PAGE3=D4h+slot*2; the refused call may not add
      // an open. After the FINAL isa access only the last window's
      // close-restore (out PAGE3=init, out SYSTEM=init) may appear.
      const lastIsaT = m.isaLog[m.isaLog.length - 1].t;
      const tail = m.ioLog.filter((e) => e.t > lastIsaT);
      const badTail = tail.filter((e) =>
        !(e.dir === 'out' && (e.port === PORT_PAGE3 || e.port === PORT_SYSTEM || e.port === 0x3C)));
      if (badTail.length) return `io entries after last isa access: ${badTail.length}`;
      if (tail.some((e) => e.port === PORT_PAGE3 && (e.val & 0xF1) === 0xD0))
        return 'PAGE3 remapped to ISA window after last isa access';
      if (tail.some((e) => e.port === PORT_SYSTEM && e.val === 0x11))
        return 'SYSTEM re-armed for ISA after last isa access';
      // card state: no transfer pinned, object got no bytes
      if (c.transfer !== null) return 'transfer pinned by refused call';
      const o = [...c.objects.values()][0];
      return (o && o.uploaded === 0) ? null : `uploaded=${o ? o.uploaded : '?'}`;
    }],
  ['st-nmihaz', { nmiIsa: CARD_BASE, iff: 1 }, {}, (m, c, r) => {
      if (m.nmiDelivered < 1) return 'NMI never delivered';
      // named defect ONLY: the test stores marker E5 at result+3 after
      // re-verifying the NMI push corrupted the switched-SP buffer, and
      // exits 1. No unrelated harness violation may stand in for it.
      if (m.exitCode !== 1) return `exit=${m.exitCode} (expected 1: hazard fail)`;
      if (r[3] !== 0xE5)
        return `marker=${hex(r[3], 2)} (expected E5: push corruption unseen)`;
      return m.violations.length === 0
        ? null : `unrelated violations: ${m.violations.join('; ')}`;
    }],
];

SELFTESTS.push(['st-pending',{}, {}, (m,c,r)=>
  m.exitCode===0 && r[3]===0 && c.frame.st==='IDLE' &&
  m.isaLog.filter(e=>e.dir==='w' && e.isa===CARD_BASE+3).length===2 ? null : 'stale reply was reused or a new request was sent']);
SELFTESTS.push(['st-profile', {}, {}, m => m.exitCode === 0 ? null : `exit=${m.exitCode}`]);
SELFTESTS.push(['st-loop', { budget: 1000 }, {}, (m,c,r,run) =>
  !m.exited && run.steps === 1000 && m.violations.length === 1 &&
  m.violations[0].startsWith('instruction budget exhausted: PC=') && m.trace.length === 16
    ? null : 'loop was not stopped by its instruction budget with PC/trace']);
for (const opts of [
  { tag: 'turbo-fixed', profile: 1 },
  { tag: 'noturbo-fixed', profile: 2, cpuHz: 3_500_000 },
  { tag: 'unknown-fixed', profile: 0xFF },
  { tag: 'fixed-safe-nmi', profile: 1, nmiIsa: CARD_BASE },
  { tag: 'alias-safe-nmi', profile: 2, cpuHz: 3_500_000, method: 1, alias: CARD_ALIAS, nmiIsa: CARD_ALIAS },
  { tag: 'stack-known-excluded-nmi', profile: 1, method: 2, safeStack: true },
]) SELFTESTS.push(['st-transfer', opts, {}, (m,c,r) => {
  if (m.exitCode !== 0 || r[3] !== 0 || c.objects.size || c.transfer) return 'transfer/cleanup failed';
  if (opts.nmiIsa !== undefined && m.nmiDelivered === 0) return 'safe NMI never injected';
  const expectedChunk = 8;
  const groups = []; let group = 0;
  for (const e of [...m.isaLog.map(e => ({ ...e, type: 'isa' })),
    ...m.ioLog.filter(e => e.dir === 'out' && e.port === PORT_PAGE3 && e.val === m.page3Init).map(e => ({ ...e, type: 'close' }))].sort((a,b) => a.t-b.t)) {
    if (e.type === 'close') { if (group) groups.push(group); group = 0; }
    else if (e.dir === 'w' && (e.isa === CARD_BASE || (opts.method === 1 && e.isa >= CARD_ALIAS && e.isa < CARD_ALIAS + 32))) group++;
  }
  if (groups.length !== 1024 / expectedChunk || groups.some(n => n !== expectedChunk))
    return `chunk groups ${groups.length}, expected ${1024/expectedChunk} x ${expectedChunk}`;
  if (m.windows.some(w => w.us >= 10_000)) return 'virtual ISA section exceeds 10ms';
  return null;
}]);

for (const opts of [
  { tag:'short-BEGIN-payload', shortBegin:true, expectedError:3, expectedSource:1 },
  { tag:'commit-PSRAM-error', psramFail:true, expectedError:0x11, expectedSource:2 },
]) SELFTESTS.push(['st-writefail',opts,{},(m,c,r)=> {
  if (m.exitCode!==0 || r[3] || c.transfer || c.objects.size) return 'wrong error bookkeeping or leaked grant/object';
  if (opts.shortBegin && m.isaLog.some(e=>e.dir==='w' && e.isa===CARD_BASE)) return 'data sent using malformed token';
  return null;
}]);

// Per-window guard, independent of session state and firmware identity.
for (const slot of [0,1]) for (const turboInit of [false,true])
for (const turboHardware of [false,true]) for (const iff of [0,1])
for (const page3Init of [0x03,0xE9,0xFE]) {
  const opts={tag:`turbo-${slot}-${turboInit}-${turboHardware}-${iff}-${page3Init}`,
    profile:slot,cardSlot:slot,turboInit,turboHardware,iff,page3Init};
  SELFTESTS.push(['st-turbo',opts,{},m=>{
    if(m.exitCode || m.turboWrites!==4 || !m.turbo || m.windowCount!==2) return 'guard/reopen';
    if(m.systemPage[0x13A]!==0xA5) return 'CONFIG_DE was modified';
    if(m.ioLog.some(e=>e.dir==='in' && e.port!==PORT_PAGE3)) return 'unreliable state read';
    if(m.maxDiUs<=m.maxWindowUs || m.maxDiUs>=2000) return 'complete DI section budget';
    const writes=m.ioLog.filter(e=>e.dir==='out').map(e=>[e.port,e.val]);
    const window=[[0x3C,2],[PORT_SYSTEM,0x11],[PORT_PAGE3,0xD4+slot*2],[PORT_ISA,0],
      [PORT_SYSTEM,1],[PORT_PAGE3,page3Init],[0x3C,3]];
    return JSON.stringify(writes)===JSON.stringify([...window,...window])?null:'IO order';
  }]);
}
// Negative model control: a consuming read must be rejected before it reaches the card.
{
  let reads=0;
  const m=new SprinterMachine({card:{readPort(){reads++;return 0;}},systemInit:0x11,page3Init:0xD4});
  try {m.memRead(0xC1D0);bad('Turbo ISA rejection','accepted');}
  catch(e) {e.message==='ISA access with Turbo enabled' && reads===0 ? ok('Turbo ISA rejection') : bad('Turbo ISA rejection',e.message);}
}

for (const [file, cardOpts, , expect] of SELFTESTS) {
  const exePath = join(OUTDIR, dssExeName(file));
  let bytes;
  try {
    bytes = loadExecuted(exePath);
    ok(EXEDIR ? `load ${file}` : `assemble ${file}`, `${bytes.length}B`);
  } catch (e) {
    bad(`prepare ${file}`, String(e.stdout || e.message).split('\n').slice(0, 8).join(' | '));
    continue;
  }
  let sh;
  try { sh = parseExe(bytes); } catch (e) { bad(`${file} header`, e.message); continue; }
  const card = new UgCard({ alias: cardOpts.alias ?? 0xFFFF, noReply: !!cardOpts.noReply });
  const mach = new SprinterMachine({ card, cardSlot: cardOpts.cardSlot ?? 0, seed: 0x5EED02, systemInit: 0x01, page3Init: cardOpts.page3Init ?? 0x03, turboInit: cardOpts.turboInit, turboHardware: cardOpts.turboHardware, cpuHz: cardOpts.cpuHz ?? 21_000_000 });
  if (cardOpts.psramFail) card.injectPsramFail = true;
  if (cardOpts.shortBegin) {
    const begin = card._writeBegin.bind(card);
    card._writeBegin = p => { const r = begin(p); return r[0] ? r : [0,1,1]; };
  }
  mach.mem[0xB300] = cardOpts.profile ?? 0;
  mach.mem[0xB301] = cardOpts.method ?? 0;
  mach.mem[0xB302] = cardOpts.safeStack ? 1 : 0;
  mach.mem[0xB303] = cardOpts.expectedError ?? 0;
  mach.mem[0xB304] = cardOpts.expectedSource ?? 0;
  if (cardOpts.nmiIsa !== undefined) { mach.nmiArmIsa = cardOpts.nmiIsa; mach.nmiArmed = true; }
  mach.mem.set(bytes, sh.loadAddr);
  const run = runImage(Z80, mach, { entry: sh.entry, stack: sh.stack, iff: cardOpts.iff ?? 1, budget: cardOpts.budget ?? 4_000_000 });
  const res = mach.mem.slice(RESULT, RESULT + 8);
  let why = expect(mach, card, res, run);
  const intendedViolation = {
    'st-dsswin': /DSS call C=5c while ISA window open/,
    'st-dssgrant': /DSS call C=5c while transfer grant active/,
    'st-ctxsp': /^stack inside ISA window:/,
  }[file];
  if (why === null && intendedViolation && (mach.exitCode !== 0 || res[3] !== 0 ||
      !mach.violations.length || mach.violations.some(v => !intendedViolation.test(v))))
    why = 'target defect masked by unrelated exit/error/violation';
  const deliberatelyDefective = new Set(['st-dsswin', 'st-dssgrant', 'st-ctxpg3', 'st-ctxiff', 'st-ctxsp', 'st-nmihaz', 'st-loop']);
  if (why === null && !deliberatelyDefective.has(file)) {
    const fin = mach.z.getState();
    if (mach.violations.length) why = `unrelated violations: ${mach.violations.join('; ')}`;
    else if (mach.system !== mach.systemInit || mach.page3 !== mach.page3Init ||
      !!fin.iff1 !== !!(cardOpts.iff ?? 1) || fin.sp !== sh.stack - 2)
      why = 'context/IFF/SP not restored';
  }
  const tag = cardOpts.tag ?? file;
  const ctxOk = mach.system === mach.systemInit && mach.page3 === mach.page3Init;
  runs.push({ tag, mach, card, run, res, fin: mach.z.getState(), rd16: () => 0 });
  if (why === null) ok(`selftest ${tag}`, `code=${mach.exitCode} ${run.steps}i viol=${mach.violations.length} nmi=${mach.nmiDelivered}`);
  else bad(`selftest ${tag}`, `${why} ctxOk=${ctxOk}`);
}

// Execute the new standalone tools and named defective EXEs before
// publishing a combined byte-identity chain for the stage package.
try {
  execFileSync(process.execPath, [join(REPO, 'tests/ultrags/dss/run-s1.mjs'), REPO, BUILD], {stdio:'inherit'});
  const s1 = JSON.parse(readFileSync(join(LOGS, 's1-run.json')));
  for (const e of s1.executed) executed.set(e.name,e);
  for (const r of s1.results) r.ok ? ok(`S1 ${r.name}`) : bad(`S1 ${r.name}`,r.violations.join(';'));
} catch (e) { bad('S1 actual-EXE suite', e.message); }
try {
  const parentBuild = resolve(BUILD, '..');
  execFileSync(process.execPath, [join(REPO, 'tests/ultrags/dss/run-s2.mjs'), REPO, parentBuild], {stdio:'inherit'});
  const s2 = JSON.parse(readFileSync(join(LOGS, 's2-run.json')));
  for (const e of s2.executed) executed.set(e.name,e);
  execFileSync(process.execPath, [join(REPO, 'tests/ultrags/dss/run-s3.mjs'), REPO, parentBuild], {stdio:'inherit'});
  const s3=JSON.parse(readFileSync(join(parentBuild,'ultrags/logs/s3-run.json')));
  for (const e of s3.executed) executed.set(e.name,e);
  if(assemblyEvidence.files.some(e=>e.name==='UGLOAD.EXE')) {
    execFileSync(process.execPath,[join(REPO,'tests/ultrags/dss/run-s4.mjs'),REPO,parentBuild],{stdio:'inherit'});
    const s4=JSON.parse(readFileSync(join(LOGS,'s4-run.json')));
    for(const e of s4.executed)executed.set(e.name,e);
    for(const r of s4.results)r.ok?ok(`S4 ${r.name}`):bad(`S4 ${r.name}`,r.errors.join(';'));
  }
  if(assemblyEvidence.files.some(e=>e.name===dssExeName('ST-S1-BENCH'))) {
    execFileSync(process.execPath,[join(REPO,'tests/ultrags/dss/run-s5.mjs'),REPO,parentBuild],{stdio:'inherit'});
    const s5=JSON.parse(readFileSync(join(LOGS,'s5-run.json')));
    for(const e of s5.executed)executed.set(e.name,e);
    for(const r of s5.results)r.ok?ok(`S5 ${r.name}`):bad(`S5 ${r.name}`,r.errors.join(';'));
  }
  if(assemblyEvidence.files.some(e=>e.name==='UGPLAY.EXE')) {
    execFileSync(process.execPath,[join(REPO,'tests/ultrags/dss/run-s6.mjs'),REPO,parentBuild],{stdio:'inherit'});
    const s6=JSON.parse(readFileSync(join(LOGS,'s6-run.json')));
    for(const e of s6.executed)executed.set(e.name,e);
    for(const r of s6.results)r.ok?ok(`S6 ${r.name}`):bad(`S6 ${r.name}`,r.errors.join(';'));
  }
  for (const r of s3.results) r.ok ? ok(`S3 ${r.name}`) : bad(`S3 ${r.name}`,r.errors.join(';'));

  for (const r of s2.results) r.ok ? ok(`S2 ${r.name}`) : bad(`S2 ${r.name}`,r.errors.join(';'));
} catch(e) { bad('S2/S3 actual-EXE suite',e.message); }
done(runs);

function done(runs_) {
  const ev = {
    buildInputs: assemblyEvidence.inputs,
    executionInputs: executionInputs(REPO),
    executed: assemblyEvidence.files.filter(e => executed.has(e.name)).map(e => executed.get(e.name)),
    exe: { path: EXE, bytes: exe ? exe.length : 0, sha256: exe ? sha256(EXE) : null,
           header: hdr ? { entry: hdr.entry, stack: hdr.stack, loadAddr: hdr.loadAddr, imageEnd: hdr.imageEnd } : null },
    core: { path: 'tests/ultrags/dss/Z80core.js', sha256: sha256(join(REPO, 'tests/ultrags/dss/Z80core.js')) },
    artifacts: {
      'ug-card.js': sha256(join(REPO, 'tests/ultrags/dss/ug-card.js')),
      'ug-harness.mjs': sha256(join(REPO, 'tests/ultrags/dss/ug-harness.mjs')),
      'ugdiag.asm': sha256(SRC),
      'isa.asm': sha256(join(LIBDIR, 'isa.asm')),
      'ugproto.asm': sha256(join(LIBDIR, 'ugproto.asm')),
      'ugcrc.asm': sha256(join(LIBDIR, 'ugcrc.asm')),
      'ugle.asm': sha256(join(LIBDIR, 'ugle.asm')),
      'ugframe.asm': sha256(join(LIBDIR, 'ugframe.asm')),
      'ugmem.inc': sha256(join(INCDIR, 'ugmem.inc')),
      'ug_wire.inc': sha256(join(GENDIR, 'ug_wire.inc')),
      selftests: Object.fromEntries(SELFTESTS.map(([f]) => [f, (() => {
        try { return sha256(join(STDIR, `${f}.asm`)); } catch { return null; } })()])),
    },
    runs: runs_.map((r) => ({
      tag: r.tag,
      cpuHz: r.mach.cpuHz, maxWindowUs: r.mach.maxWindowUs, maxDiUs: r.mach.maxDiUs, windows: r.mach.windows, traceTail: r.mach.trace,
      exitCode: r.mach.exitCode, steps: r.run.steps, cycles: r.run.cycles,
      endPc: r.fin.pc, minSp: r.mach.minSpSeen, maxSp: r.mach.maxSpSeen,
      systemInit: r.mach.systemInit, page3Init: r.mach.page3Init,
      ctxFinal: { system: r.mach.system, page3: r.mach.page3, iff1: r.fin.iff1 },
      dssCalls: r.mach.dssCalls, nmiDelivered: r.mach.nmiDelivered,
      resultRecord: Array.from(r.mach.mem.slice(RESULT, RESULT + 32)),
      console: r.mach.text,
      violations: r.mach.violations,
      cardState: { xerr: r.card.xerr, gserr: r.card.gserr, objects: r.card.objects.size,
                   stats: { ...r.card.stats }, blockCrcs: r.card.diag.blockCrcs },
      isaLogTail: r.mach.isaLog.slice(-20),
    })),
    pass, fail, results,
  };
  writeFileSync(join(LOGS, 'ugdiag-run.json'), JSON.stringify(ev, null, 2));
  console.log(`UGDIAG ${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
