// SPDX-License-Identifier: GPL-2.0-or-later
//
// ug-card.js - strict host-side model of the Ultra GS card for S0b testing.
// This is TEST INFRASTRUCTURE per the S0b prompt - not firmware production
// code. It models the ISA register window, EXT frame transport, grants,
// staging/commit, PSRAM objects, timeouts and the legacy GS latch pair with
// the precision needed to validate real Z80 machine code against spec 5-8.
//
// Modelled scope (advertised honestly via CAPS):
//   - EXT frame transport (FAST + FRAME_CRC, VERIFIED transfers)
//   - BULK_DATA streaming, 32-address alias window, GS_DATA transport
//   - Object store: ALLOC/FREE/OBJECT_INFO/OBJECT_ENUM/SEAL(BLOB only)/
//     WRITE_BEGIN/WRITE_END/READ_BEGIN/READ_END/TRANSFER_CANCEL
//   - X_CONTROL, X_ERROR/GS_ERROR, SNAP_LATCH/SNAP_DATA, STATS
//   - Legacy GS latch protocol: command handshake, LOAD stream, D2 publish,
//     F0/F3/F4/F5/F6, D0/D1 no-ops, 6A/6B registers, EXT_GS_DATA exclusivity
//   - Config subset: proto4 ports 1D0..1D2 with transactional u16 writes,
//     UG_BASE/UG_ALIAS/UG_GS_ALIASES/FW_ACTIVE/FW_CATALOG, config_idle gate
//
// NOT modelled (declared scope): audio engine/mixing, MOD playback, playlists,
// voice/pan/FX execution, MEM_TEST internals, PCM descriptor-based SEAL of
// musical kinds (RAW/WAV/MOD SEAL -> FORMAT until the parser milestone).
// These report honest errors instead of fake success.

'use strict';

const ERR = {
  OK: 0x00, BAD_OPCODE: 0x01, BAD_ARGUMENT: 0x02, LENGTH: 0x03, CRC: 0x04,
  BUSY: 0x05, STATE: 0x06, HANDLE: 0x07, RANGE: 0x08, NO_MEMORY: 0x09,
  NO_HANDLES: 0x0A, FORMAT: 0x0B, NO_VOICE: 0x0C, TIMEOUT: 0x0D,
  OVERFLOW: 0x0E, UNDERFLOW: 0x0F, SHORT_TRANSFER: 0x10, PSRAM: 0x11,
  PINNED: 0x12, UNSUPPORTED_MEMORY: 0x13, BAD_REGISTER: 0x14,
  CANCELLED: 0x15, INTERNAL: 0x16,
};
const XS = { READY: 1, BUSY: 2, REPLY: 4, WRITE_GRANT: 8, READ_GRANT: 16, XERR: 32, GSERR: 64, AUDIO: 128 };
const XC = { TRANSPORT_RESET: 0xA0, TRANSFER_CANCEL: 0xA1, CLEAR_ERRORS: 0xA2, SNAP_LATCH: 0xA3 };

const PSRAM_BYTES = 8 * 1024 * 1024;
const MAX_BLOCK = 1024;
const MAX_PAYLOAD = 128;
const MAX_OBJECTS = 128;
const FRAME_RX_US = 1000 * 1000;     // 1000 ms incomplete-RX timeout
const GRANT_IDLE_US = 5000 * 1000;   // 5000 ms in-grant inactivity timeout
const RESET_KEY = 0x55475253;        // "UGRS"

// opcodes allowed while a transfer owns the device (spec 5 whitelist).
const XFER_WHITELIST = new Set([0x00, 0x02, 0x03, 0x12, 0x16, 0x21, 0x23, 0x24, 0x50, 0x51]);

// exact request payload lengths per opcode (spec 6.4/7). Index = opcode.
const REQ_LENS = {
  0x00: [0], 0x01: [0], 0x02: [0], 0x03: [0], 0x04: [0], 0x05: [1], 0x06: [5],
  0x10: [5], 0x11: [2], 0x12: [2], 0x13: [7], 0x14: [26], 0x15: [2], 0x16: [0],
  0x20: [9, 13], 0x21: [4], 0x22: [9], 0x23: [4, 8], 0x24: [4],
  0x50: [0], 0x51: [1],
};

const crc32 = (() => { // ISO-HDLC EDB88320
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return (buf, acc = 0xFFFFFFFF) => {
    for (const b of buf) acc = t[(acc ^ b) & 0xFF] ^ (acc >>> 8);
    return acc >>> 0;
  };
})();
const crc32done = (acc) => (acc ^ 0xFFFFFFFF) >>> 0;
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
// pure additive decode: no bitwise OR, so the result stays an unsigned Number
// for every u32 including 0x80000000..0xFFFFFFFF
const le32 = (b, o) => b[o] + b[o + 1] * 0x100 + b[o + 2] * 0x10000 + b[o + 3] * 0x1000000;
const w16 = (b, o, v) => { b[o] = v & 0xFF; b[o + 1] = (v >> 8) & 0xFF; };
const w32 = (b, o, v) => { b[o] = v & 0xFF; b[o + 1] = (v >> 8) & 0xFF; b[o + 2] = (v >> 16) & 0xFF; b[o + 3] = (v / 0x1000000) & 0xFF; };
const align16 = (n) => Math.ceil(n / 16) * 16;   // exact arithmetic; no bitwise wrap

class UgCard {
  constructor(opts = {}) {
    // test hooks: absent card / card strapped to another multifw mode
    this.absent = !!opts.absent;
    this.mode = opts.mode ?? 8;
    this.base = opts.base ?? 0x2A0;
    this.alias = opts.alias ?? 0xFFFF;
    this.gsAliases = opts.gsAliases ?? false;
    this.psram = new Uint8Array(PSRAM_BYTES);
    this.injectPsramFail = false;      // COMMIT fails with PSRAM when set
    this.execDelayUs = opts.execDelayUs ?? 0;
    this.noReply = !!opts.noReply;         // EXEC never completes (timeout probe)
    this.nowUs = 0;
    this.cfgResult = 0;
    this.rebootRequested = false;
    this.desiredMode = this.mode;
    this.diag = { blockCrcs: 0 };      // instrumentation for lazy-CRC asserts
    this.session = 0x0123456789ABCDEFn;
    this.reset();
  }

  reset() {
    this.objects = new Map();
    this.freeList = [{ off: 0, size: PSRAM_BYTES }];
    this.nextHandle = 1;
    this.handlesIssued = 0;
    this.nextTransferId = 1;
    this.transferCounterExhausted = false;
    this.xerr = 0; this.gserr = 0;
    this.frame = { st: 'IDLE', buf: [], need: 0, crcBit: false, opcode: 0, lastByteUs: -Infinity };
    this.resp = null;
    this.pendingExec = null;
    this.transfer = null;
    this.stats = new Proxy({                               // counters saturate at u32 max
      isaReads: 0, isaWrites: 0, uploadBytes: 0, downloadBytes: 0,
      writeBlocks: 0, readBlocks: 0, crcErrors: 0, protocolErrors: 0,
      transferTimeouts: 0, audioUnderruns: 0, psramErrors: 0,
      rxFrames: 0, faults: 0,
    }, {
      get: (t, k) => (typeof t[k] === 'number' ? t[k] : 0),
      set: (t, k, v) => { t[k] = Math.min(Math.max(0, Math.floor(v)), 0xFFFFFFFF); return true; },
    });
    this.snapIndex = 0;
    this.snapshot = null;
    this.snapSeq = 0;
    this.gs = {
      cb: false, db: false, outLatch: 0, inPre: null, inPreSet: false,
      state: 'NORMAL',
      postNeed: 0, postBuf: [], postShortOk: false, outQ: [], pendingCmd: null,
      loadObj: null, loadLegacy: 0,
      reg6a: 0, reg6b: 0,
    };
    this.legacyMod = 0;                 // EXT handle of published module (legacy #1)
    this.legacyFx = new Map();          // legacy fx number 1..60 -> EXT handle
    this.cfg = { unlocked: false, sel: 0, lo: 0 };
    this.catalogIndex = 0;
    this.log = [];
  }

  _log(e) { if (this.log.length < 4096) this.log.push({ us: this.nowUs, ...e }); }
  _xferOpen() { return this.transfer !== null; }
  _configIdle() {
    return this.frame.st === 'IDLE' && !this.transfer && !this.pendingExec &&
      this.gs.state === 'NORMAL' && !this.resp;
  }

  // ================= virtual time =================
  tickUs(us) {
    this.nowUs += us;
    if (this.frame.st === 'RX' && this.nowUs - this.frame.lastByteUs >= FRAME_RX_US) {
      this.frame.st = 'FAULT';
      this.xerr = ERR.TIMEOUT; this.stats.transferTimeouts++;
      this._log({ ev: 'frame-timeout' });
    }
    if (this.transfer && this.transfer.grantLive &&
        this.nowUs - this.transfer.lastDataUs >= GRANT_IDLE_US) {
      this._cancelTransfer('timeout');
      this.xerr = ERR.TIMEOUT; this.stats.transferTimeouts++;
      this._log({ ev: 'grant-timeout' });
    }
    if (this.pendingExec && this.nowUs >= this.pendingExec.due) {
      const p = this.pendingExec; this.pendingExec = null;
      this.resp = p.resp;
      this.frame.st = 'REPLY';
    }
    const g = this.gs;
    // EXT_GS_DATA write latch: consume staged byte (clears DB -> WD passes)
    if (g.state === 'EXT_GS_DATA' && g.db && g._pendingByte !== undefined) {
      this._xferPut(g._pendingByte);
      g._pendingByte = undefined;
      g.db = false;
    }
    // EXT_GS_DATA read latch: prefetch next byte into OUT (sets DB -> WN).
    // The prefetch is NOT consumption: idx and the inactivity timer move only
    // when the host actually GD-reads the byte.
    if (g.state === 'EXT_GS_DATA' && !g.db && this.transfer &&
        this.transfer.dir === 'r' && this.transfer.grantLive &&
        this.transfer.idx < this.transfer.n) {
      g.outLatch = this.transfer.buf[this.transfer.idx];
      g.db = true;
    }
  }

  // ================= ISA port routing (exact 10-bit decode) =================
  readPort(addr) {
    if (this.absent) return 0xFF;
    addr &= 0x3FF;
    if (addr >= 0x1D0 && addr <= 0x1D2) { this.stats.isaReads++; return this._cfgRead(addr); }
    if (this.mode !== 8) return 0xFF;                    // card present, other fw mode
    if (addr >= this.base && addr < this.base + 0x20)
      { this.stats.isaReads++; return this._regRead(addr - this.base); }
    if (this.alias !== 0xFFFF && addr >= this.alias && addr < this.alias + 0x20)
      { this.stats.isaReads++; return this._regRead(0); }
    if (this.gsAliases && addr === 0xB3) { this.stats.isaReads++; return this._regRead(0x13); }
    if (this.gsAliases && addr === 0xBB) { this.stats.isaReads++; return this._regRead(0x1B); }
    return 0xFF;
  }
  writePort(addr, v) {
    if (this.absent) return;
    addr &= 0x3FF; v &= 0xFF;
    if (addr >= 0x1D0 && addr <= 0x1D2) { this.stats.isaWrites++; return this._cfgWrite(addr, v); }
    if (this.mode !== 8) return;
    if (addr >= this.base && addr < this.base + 0x20)
      { this.stats.isaWrites++; return this._regWrite(addr - this.base, v); }
    if (this.alias !== 0xFFFF && addr >= this.alias && addr < this.alias + 0x20)
      { this.stats.isaWrites++; return this._regWrite(0, v); }
    if (this.gsAliases && addr === 0xB3) { this.stats.isaWrites++; return this._regWrite(0x13, v); }
    if (this.gsAliases && addr === 0xBB) { this.stats.isaWrites++; return this._regWrite(0x1B, v); }
  }

  // ================= register file =================
  getXStatus() {
    const f = this.frame, t = this.transfer;
    let s = 0;
    if (f.st === 'IDLE') s |= XS.READY;
    if (f.st === 'EXEC') s |= XS.BUSY;
    if (f.st === 'REPLY') s |= XS.REPLY;
    if (t && t.dir === 'w' && (t.grantLive || (t.grantPending && f.st === 'REPLY'))) s |= XS.WRITE_GRANT;
    if (t && t.dir === 'r' && (t.grantLive || (t.grantPending && f.st === 'REPLY'))) s |= XS.READ_GRANT;
    if (this.xerr) s |= XS.XERR;
    if (this.gserr) s |= XS.GSERR;
    return s;
  }

  _regRead(off) {
    switch (off) {
      case 0x00: return this._bulkRead();
      case 0x01: return this.getXStatus();
      case 0x02: return 0;
      case 0x03: return this._respRead();
      case 0x04: return this.snapIndex;
      case 0x05: {
        if (!this.snapshot) { this._setXerr(ERR.STATE); return 0; }
        if (this.snapIndex >= this.snapshot.length) {
          this._setXerr(ERR.UNDERFLOW);                          // past end: no wrap
          return 0xFF;
        }
        return this.snapshot[this.snapIndex++];                  // index stops at64
      }
      case 0x06: return this.xerr;
      case 0x07: return this.gserr;
      case 0x08: return 1;
      case 0x09: return 0;
      case 0x13: return this._gsDataRead();
      case 0x1B: return 0x7E | (this.gs.cb ? 0x01 : 0) | (this.gs.db ? 0x80 : 0);
      default:
        return 0;                                  // reserved window reads as 0
    }
  }

  _regWrite(off, v) {
    switch (off) {
      case 0x00: return this._bulkWrite(v);
      case 0x02: return this._control(v);
      case 0x03: return this._reqWrite(v);
      case 0x04:
        if (v > 0x3F) { this._setXerr(ERR.RANGE); return; }      // 0..63 writable;64 is the internal end sentinel
        this.snapIndex = v; return;
      case 0x13: return this._gsDataWrite(v);
      case 0x1B: return this._gsCommandWrite(v);
      default:
        this._setXerr(ERR.BAD_REGISTER);
    }
  }

  _setXerr(e) { this.xerr = e; this._inc('protocolErrors'); }
  _inc(k, n = 1) {                                             // stats saturate at u32 max
    const v = this.stats[k] + n;
    this.stats[k] = v > 0xFFFFFFFF ? 0xFFFFFFFF : v;
  }

  _control(v) {
    switch (v) {
      case XC.TRANSPORT_RESET:
        this.frame = { st: 'IDLE', buf: [], need: 0, crcBit: false, opcode: 0, lastByteUs: -Infinity };
        this.resp = null; this.pendingExec = null;
        this._cancelTransfer('reset');
        this.xerr = 0;                              // framing error clears with the transport
        this._log({ ev: 'transport-reset' });
        return;
      case XC.TRANSFER_CANCEL:
        this._cancelTransfer('cancel');
        return;
      case XC.CLEAR_ERRORS:
        this.xerr = 0; this.gserr = 0; return;
      case XC.SNAP_LATCH:
        this.snapshot = this._buildSnapshot(); this.snapIndex = 0; return;
      default:
        this._setXerr(ERR.BAD_ARGUMENT);
    }
  }

  // ================= frame transport =================
  _reqWrite(v) {
    const f = this.frame;
    switch (f.st) {
      case 'IDLE':
        f.buf = [v]; f.crcBit = !!(v & 0x80); f.opcode = v & 0x7F;
        f.need = 2; f.st = 'RX'; f.lastByteUs = this.nowUs;
        return;
      case 'RX': {
        f.lastByteUs = this.nowUs;
        f.buf.push(v);
        if (f.buf.length === 2) {
          const plen = v;
          if (plen > MAX_PAYLOAD) {
            f.st = 'FAULT'; this._setXerr(ERR.LENGTH); this.stats.faults++;
            this._log({ ev: 'frame-fault', why: 'length' });
            return;
          }
          f.need = 2 + plen + (f.crcBit ? 4 : 0);
        }
        if (f.buf.length === f.need) this._execFrame();
        return;
      }
      case 'EXEC': case 'REPLY':
        this._setXerr(ERR.BUSY);
        return;
      case 'FAULT':
        return;
    }
  }

  _respRead() {
    if (this.frame.st !== 'REPLY' || !this.resp) {
      this._setXerr(ERR.UNDERFLOW);
      return 0xFF;
    }
    const b = this.resp.bytes[this.resp.idx++];
    if (this.resp.idx >= this.resp.bytes.length) {
      this.resp = null;
      this.frame.st = 'IDLE';
      // consuming the full BEGIN response makes the grant host-eligible
      if (this.transfer && this.transfer.grantPending) {
        this.transfer.grantPending = false;
        this.transfer.grantLive = true;
        this.transfer.lastDataUs = this.nowUs;
      }
    }
    return b;
  }

  _execFrame() {
    const f = this.frame;
    const plen = f.buf[1];
    const payload = f.buf.slice(2, 2 + plen);
    let resp;
    if (f.crcBit) {
      const got = le32(f.buf, 2 + plen);
      const want = crc32done(crc32(f.buf.slice(0, 2 + plen)));
      if (got !== want) {
        resp = this._mkResp(ERR.CRC, []);
        this.stats.crcErrors++;
      } else resp = this._dispatch(f.opcode, payload);
    } else resp = this._dispatch(f.opcode, payload);
    this.stats.rxFrames++;
    if (f.crcBit) {
      // every reply to a CRC-flagged request carries the trailer - including
      // error replies such as the CRC-mismatch report itself
      const trailer = crc32done(crc32(resp));
      for (let i = 0; i < 4; i++) resp.push((trailer >>> (8 * i)) & 0xFF);
    }
    return this._enterReply(resp);
  }

  _mkResp(status, payload) {
    if (status !== 0) {
      this.stats.protocolErrors++;
      this.xerr = status;          // every EXT error reply is sticky in X_ERROR
    }
    return [status, payload.length, ...payload];
  }

  _enterReply(respBytes) {
    if (this.noReply) {
      // wedged EXEC: the reply is never published; the host's bounded
      // wait must time out and recover via TRANSPORT_RESET
      this.frame.st = 'EXEC';
      return;
    }
    if (this.execDelayUs > 0) {
      this.frame.st = 'EXEC';
      this.pendingExec = { due: this.nowUs + this.execDelayUs, resp: { bytes: respBytes, idx: 0 } };
    } else {
      this.resp = { bytes: respBytes, idx: 0 };
      this.frame.st = 'REPLY';
    }
  }

  _dispatch(op, p) {
    const err = (e) => this._mkResp(e, []);
    const ok = (pl) => this._mkResp(0, pl);
    const lens = REQ_LENS[op];
    if (!lens) return err(ERR.BAD_OPCODE);
    if (!lens.includes(p.length)) return err(ERR.LENGTH);
    if (this.gs.state === 'LOAD' && (op === 0x05 || op === 0x06))
      return err(ERR.BUSY);                                      // 8.4: MEM_TEST/RESET_STORE hold
    if (this.transfer) {
      if (!XFER_WHITELIST.has(op)) return err(ERR.BUSY);
      if (op === 0x20 || op === 0x22) return err(ERR.BUSY);      // no nested BEGIN
      if (op === 0x12 && le16(p, 0) !== this.transfer.handle)    // OBJECT_INFO gate
        return err(ERR.BUSY);
    }
    switch (op) {
      case 0x00: { // INFO
        const b = new Uint8Array(40);
        b.set([0x55, 0x47, 0x53, 0x31]);
        b[4] = 1; b[5] = 0; b[6] = this.mode; b[7] = this.injectPsramFail ? 1 : 0;
        w32(b, 8, 0x010000);
        for (let i = 0; i < 8; i++) b[12 + i] = Number((this.session >> BigInt(8 * i)) & 0xFFn);
        b.set(Buffer.from('deadbeeffeedface', 'ascii'),20);b.set(Buffer.from('VLS1'),36);
        return ok(Array.from(b));
      }
      case 0x01: { // CAPS - advertise ONLY what this model implements
        const b = new Uint8Array(44);
        const feat = 0x02 | 0x04 | 0x20 | 0x40                    // slow+bulk+snapshot+crc
          | (this.alias !== 0xFFFF ? 0x08 : 0)                    // alias enabled
          | (this.gsAliases ? 0x200 : 0);                         // legacy gs aliases enabled
        w32(b, 0, feat);
        w32(b, 4, 0x00);                     // formats: none playable in this model
        w32(b, 8, 44100);
        w16(b, 12, MAX_BLOCK); w16(b, 14, MAX_PAYLOAD);
        w16(b, 16, MAX_OBJECTS); w16(b, 18, 0);  // playlist_entries: none
        b[20] = 0; b[21] = 0;                    // music_voices / fx_voices: none
        b[22] = 0; b[23] = 0;                    // gs_profile 0: no musical engine
        b[27]=1;w16(b,28,this.base);w16(b,30,this.alias);b[40]=20;b[41]=16;w16(b,42,64);
        w32(b,32,0);w32(b,36,0);            // pcm range n/a (no PCM path)
        return ok(Array.from(b));
      }
      case 0x02: { // MEM_INFO
        const free = this.freeList.reduce((a, e) => a + e.size, 0);
        const largest = this.freeList.reduce((a, e) => Math.max(a, e.size), 0);
        const b = new Uint8Array(20);
        w32(b, 0, PSRAM_BYTES); w32(b, 4, PSRAM_BYTES);
        w32(b, 8, free); w32(b, 12, largest);
        w16(b, 16, this.objects.size); w16(b, 18, MAX_OBJECTS);
        return ok(Array.from(b));
      }
      case 0x03: { // STATS - field order follows wire schema STATS struct
        const s = this.stats;
        const b = new Uint8Array(64);
        const vals = [s.isaReads, s.isaWrites, s.uploadBytes, s.downloadBytes,
          s.writeBlocks, s.readBlocks, s.crcErrors, s.protocolErrors,
          s.transferTimeouts, s.audioUnderruns, s.psramErrors,
          0, 0, 0, 0, 0];
        vals.forEach((v, i) => w32(b, i * 4, v >>> 0));
        return ok(Array.from(b));
      }
      case 0x04: {
        for (const k of Object.keys(this.stats)) this.stats[k] = 0;
        return ok([]);
      }
      case 0x05: return err(ERR.UNSUPPORTED_MEMORY); // MEM_TEST not modelled in S0b
      case 0x06: { // RESET_STORE
        if (le32(p, 0) !== RESET_KEY) return err(ERR.BAD_ARGUMENT);
        if (p[4] > 1) return err(ERR.BAD_ARGUMENT);
        this._storeReset(p[4]);
        const b = new Uint8Array(8);
        for (let i = 0; i < 8; i++) b[i] = Number((this.session >> BigInt(8 * i)) & 0xFFn);
        return ok(Array.from(b));
      }
      case 0x10: { // ALLOC
        const kind = p[0], size = le32(p, 1);
        if (kind > 3) return err(ERR.BAD_ARGUMENT);
        if (size === 0) return err(ERR.LENGTH);
        if (size > PSRAM_BYTES) return err(ERR.NO_MEMORY);          // before any rounding
        if (this.objects.size >= MAX_OBJECTS) return err(ERR.NO_HANDLES);
        if (this.nextHandle > 0xFFFF || this.handlesIssued >= 65535)
          return err(ERR.NO_HANDLES);                               // u16 space exhausted
        const reserved = align16(size);                              // exact; <= PSRAM+15
        const alloc = this._allocPsram(reserved);
        if (alloc < 0) return err(ERR.NO_MEMORY);
        const handle = this.nextHandle++;
        this.handlesIssued++;
        this.objects.set(handle, {
          handle, kind, state: 0, pins: 0, size, reserved, uploaded: 0,
          crc: 0, dataOff: alloc, dataLen: 0, rate: 0, frames: 0,
          channels: 0, bits: 0, fmt: 0, modCh: 0, pending: false, legacyNum: 0,
        });
        const b = new Uint8Array(6); w16(b, 0, handle); w32(b, 2, reserved);
        return ok(Array.from(b));
      }
      case 0x11: { // FREE
        const o = this.objects.get(le16(p, 0));
        if (!o) return err(ERR.HANDLE);
        if (o.pins > 0) return err(ERR.PINNED);
        if (this.transfer && this.transfer.handle === o.handle) return err(ERR.BUSY);
        if (o === this.gs.loadObj) return err(ERR.BUSY);            // pending LOAD pin
        this._freeObject(o);
        return ok([]);
      }
      case 0x12: { // OBJECT_INFO (transfer-gate checked above)
        const o = this.objects.get(le16(p, 0));
        if (!o) return err(ERR.HANDLE);
        const b = new Uint8Array(38);
        w16(b, 0, o.handle); b[2] = o.kind; b[3] = o.state; w16(b, 4, o.pins);
        w32(b, 6, o.size); w32(b, 10, o.uploaded); w32(b, 14, o.crc);
        w32(b, 18, o.dataOff); w32(b, 22, o.dataLen); w32(b, 26, o.rate);
        w32(b, 30, o.frames); b[34] = o.channels; b[35] = o.bits;
        b[36] = o.fmt; b[37] = o.modCh;
        return ok(Array.from(b));
      }
      case 0x13: { // SEAL - BLOB only in this model's scope
        const o = this.objects.get(le16(p, 0));
        if (!o) return err(ERR.HANDLE);
        if (o.state !== 0) return err(ERR.STATE);
        if (o.uploaded !== o.size) return err(ERR.STATE);
        if (p[2] & ~1) return err(ERR.BAD_ARGUMENT);
        if (o.kind !== 0) return err(ERR.FORMAT);      // no musical parser in S0b model
        const actual = crc32done(crc32(this.psram.slice(o.dataOff, o.dataOff + o.size)));
        if ((p[2] & 1) && le32(p, 3) !== actual) { o.state = 2; return err(ERR.CRC); }
        o.crc = actual; o.state = 1;
        const b = new Uint8Array(4); w32(b, 0, actual);
        return ok(Array.from(b));
      }
      // No PCM descriptor/parser implementation is advertised by CAPS.
      // Do not return success for partially validated musical metadata.
      case 0x14: return err(ERR.BAD_OPCODE);
      case 0x15: { // OBJECT_ENUM
        const after = le16(p, 0);
        const next = [...this.objects.keys()].filter((h) => h > after).sort((a, b) => a - b)[0] || 0;
        const b = new Uint8Array(2); w16(b, 0, next);
        return ok(Array.from(b));
      }
      case 0x16: { // LEGACY_INFO - EXT u16 handles per spec 7.5
        const b = new Uint8Array(10);
        w16(b, 0, this.legacyMod);
        w16(b, 2, this._legacyFxCurrent());
        w16(b, 4, this.gs.loadObj ? this.gs.loadObj.handle : 0);
        w32(b, 6, this.gs.loadObj ? this.gs.loadObj.uploaded : 0);
        return ok(Array.from(b));
      }
      case 0x20: return this._writeBegin(p);
      case 0x21: return this._writeEnd(p);
      case 0x22: return this._readBegin(p);
      case 0x23: return this._readEnd(p);
      case 0x24: { // TRANSFER_CANCEL
        if (!this.transfer || this.transfer.id !== le32(p, 0)) return err(ERR.HANDLE);
        this._cancelTransfer('host-cancel');
        return ok([]);
      }
      case 0x50: { // SNAPSHOT
        return ok(Array.from(this._buildSnapshot()));
      }
      case 0x51: { // MOD_TICK query - minimal model: count only
        const b = new Uint8Array(1); b[0] = 0;
        return ok(Array.from(b));
      }
      default: return err(ERR.BAD_OPCODE);
    }
  }

  _freeObject(o) {
    this._freePsram(o.dataOff, o.reserved);
    this.objects.delete(o.handle);
    if (this.legacyMod === o.handle) this.legacyMod = 0;
    for (const [k, v] of this.legacyFx) if (v === o.handle) this.legacyFx.delete(k);
  }
  _legacyFxCurrent() {
    // "current" FX for LEGACY_INFO: most recently published fx object
    return this.legacyFx.size ? [...this.legacyFx.values()][this.legacyFx.size - 1] : 0;
  }

  // ================= transfers =================
  _checkTransport(t) { return t === 0x00 || t === 0x01 || t === 0x80 || t === 0x81; }

  _nextToken() {
    if (this.transferCounterExhausted || this.nextTransferId > 0xFFFFFFFF) {
      this.transferCounterExhausted = true;
      return 0;                                    // refuse: never wrap to 0
    }
    return this.nextTransferId++;
  }

  _writeBegin(p) {
    if (!this._checkTransport(p[8])) return this._mkResp(ERR.BAD_ARGUMENT, []);
    const verified = (p[8] & 0x80) !== 0;
    if (p.length !== (verified ? 13 : 9)) return this._mkResp(ERR.LENGTH, []);
    const o = this.objects.get(le16(p, 0));
    if (!o) return this._mkResp(ERR.HANDLE, []);
    if (o.state === 2) return this._mkResp(ERR.STATE, []);
    const offset = le32(p, 2), n = le16(p, 6);
    if (n === 0 || n > MAX_BLOCK) return this._mkResp(ERR.LENGTH, []);
    const bound = o.pending ? o.reserved : o.size;  // pending LOAD object sized at close
    if (o.state === 0) {
      // UPLOADING: append at uploaded, or a rewrite fully inside the filled prefix
      const append = offset === o.uploaded;
      const prefix = offset + n <= o.uploaded;
      if (!append && !prefix) return this._mkResp(ERR.RANGE, []);
    } else {
      return this._mkResp(ERR.STATE, []);           // READY objects are immutable (7.1)
    }
    if (offset + n > bound) return this._mkResp(ERR.RANGE, []);
    const tid = this._nextToken();
    if (!tid) return this._mkResp(ERR.INTERNAL, []);
    const t = {
      dir: 'w', id: tid, handle: o.handle, offset, n,
      transport: p[8], verified,
      expectCrc: verified ? le32(p, 9) : null,
      buf: new Uint8Array(n), got: 0, over: 0,
      grantLive: false, grantPending: true, lastDataUs: this.nowUs,
    };
    if ((t.transport & 1) && this.gs.state !== 'NORMAL')
      return this._mkResp(ERR.BUSY, []);
    this.transfer = t;
    o.pins++;                                                     // transfer pins the object
    if (t.transport & 1) this.gs.state = 'EXT_GS_DATA';
    const b = new Uint8Array(4); w32(b, 0, t.id);
    return this._mkResp(0, Array.from(b));
  }

  _writeEnd(p) {
    const t = this.transfer;
    if (!t || t.dir !== 'w' || t.id !== le32(p, 0)) return this._mkResp(ERR.HANDLE, []);
    // a correctly-formed END with the right token ALWAYS releases the grant
    const finish = (status) => { this._releaseTransfer(); return this._mkResp(status, []); };
    if (t.got < t.n) { this._setXerr(ERR.SHORT_TRANSFER); return finish(ERR.SHORT_TRANSFER); }
    if (t.over) return finish(ERR.OVERFLOW);
    if (t.verified && crc32done(crc32(t.buf)) !== t.expectCrc)
      { this.stats.crcErrors++; return finish(ERR.CRC); }
    const o = this.objects.get(t.handle);
    if (!o) return finish(ERR.HANDLE);
    if (this.injectPsramFail) { o.state = 2; this.stats.psramErrors++; return finish(ERR.PSRAM); }
    this.psram.set(t.buf, o.dataOff + t.offset);
    if (o.state === 0) o.uploaded = Math.max(o.uploaded, t.offset + t.n);
    this.stats.writeBlocks++;
    this._log({ ev: 'commit', handle: o.handle, off: t.offset, n: t.n });
    this._releaseTransfer();
    return this._mkResp(0, []);
  }

  _readBegin(p) {
    if (!this._checkTransport(p[8])) return this._mkResp(ERR.BAD_ARGUMENT, []);
    const o = this.objects.get(le16(p, 0));
    if (!o) return this._mkResp(ERR.HANDLE, []);
    if (o.state === 2) return this._mkResp(ERR.STATE, []);
    const offset = le32(p, 2), n = le16(p, 6);
    if (n === 0 || n > MAX_BLOCK) return this._mkResp(ERR.LENGTH, []);
    if (offset + n > o.uploaded) return this._mkResp(ERR.RANGE, []);
    if ((p[8] & 1) && this.gs.state !== 'NORMAL') return this._mkResp(ERR.BUSY, []);
    const tid = this._nextToken();
    if (!tid) return this._mkResp(ERR.INTERNAL, []);
    const buf = this.psram.slice(o.dataOff + offset, o.dataOff + offset + n);
    const t = {
      dir: 'r', id: tid, handle: o.handle, offset, n,
      transport: p[8], verified: (p[8] & 0x80) !== 0,
      buf, idx: 0, over: 0, crc: null,              // CRC is computed only for VERIFIED
      grantLive: false, grantPending: true, lastDataUs: this.nowUs,
    };
    if (t.verified) { t.crc = crc32done(crc32(buf)); this.diag.blockCrcs++; }
    this.transfer = t;
    o.pins++;
    if (t.transport & 1) this.gs.state = 'EXT_GS_DATA';
    const b = new Uint8Array(t.verified ? 8 : 4); w32(b, 0, t.id);
    if (t.verified) w32(b, 4, t.crc);
    return this._mkResp(0, Array.from(b));
  }

  _readEnd(p) {
    const t = this.transfer;
    if (!t || t.dir !== 'r') {
      if (p.length !== 4 && p.length !== 8) return this._mkResp(ERR.LENGTH, []);
      return this._mkResp(ERR.HANDLE, []);
    }
    if (p.length !== (t.verified ? 8 : 4)) return this._mkResp(ERR.LENGTH, []);
    if (t.id !== le32(p, 0)) return this._mkResp(ERR.HANDLE, []);
    const finish = (status) => { this._releaseTransfer(); return this._mkResp(status, []); };
    if (t.idx < t.n) { this._setXerr(ERR.SHORT_TRANSFER); return finish(ERR.SHORT_TRANSFER); }
    if (t.over) return finish(ERR.OVERFLOW);
    if (t.verified && le32(p, 4) !== t.crc) { this.stats.crcErrors++; return finish(ERR.CRC); }
    this.stats.readBlocks++;
    return finish(0);
  }

  _cancelTransfer(why) {
    if (!this.transfer) return;
    this._log({ ev: 'transfer-cancelled', why });
    this._releaseTransfer();
  }
  _releaseTransfer() {
    const t = this.transfer;
    if (t) {
      const o = this.objects.get(t.handle);
      if (o && o.pins > 0) o.pins--;                              // grant pin released
      // tear down only what this transfer owned: EXT_GS_DATA latch state is
      // released when the transport used it, foreign GS DB/response state is
      // never touched by EXT END/CANCEL
      if ((t.transport & 1) && this.gs.state === 'EXT_GS_DATA') {
        this.gs.state = 'NORMAL';
        this.gs._pendingByte = undefined; this.gs.db = false;
      }
    }
    this.transfer = null;
  }

  _xferPut(v) {
    const t = this.transfer;
    if (!t || t.dir !== 'w') return;
    if (t.got >= t.n) { t.over++; this._setXerr(ERR.OVERFLOW); return; }
    t.buf[t.got++] = v; t.lastDataUs = this.nowUs;
    this.stats.uploadBytes++;
  }

  _bulkWrite(v) {
    const t = this.transfer;
    if (!t || t.dir !== 'w' || (t.transport & 1) !== 0 || !t.grantLive) {
      this._setXerr(ERR.STATE); return;            // incl. early data before full reply
    }
    this._xferPut(v);
  }
  _bulkRead() {
    const t = this.transfer;
    if (!t || t.dir !== 'r') {
      this._setXerr(ERR.UNDERFLOW); return 0xFF;   // no data at all -> UNDERFLOW
    }
    if ((t.transport & 1) !== 0 || !t.grantLive) {
      this._setXerr(ERR.STATE); return 0xFF;       // early read is STATE, no accounting
    }
    if (t.idx >= t.n) {                            // extra byte invalidates the block
      t.over++; this._setXerr(ERR.OVERFLOW); return 0xFF;
    }
    t.lastDataUs = this.nowUs;
    this.stats.downloadBytes++;
    return t.buf[t.idx++];
  }

  // ================= GS legacy latches =================
  _gsErr(e) {
    // §8.3.13 mapping: NO_MEMORY->0x10, NO_HANDLES->0x11, PSRAM->0xE1,
    // SHORT_TRANSFER->0xE0; all other codes pass through as the §6.5 value.
    const map = { [ERR.NO_MEMORY]: 0x10, [ERR.NO_HANDLES]: 0x11,
                  [ERR.PSRAM]: 0xE1, [ERR.SHORT_TRANSFER]: 0xE0 };
    this.gserr = map[e] ?? e;
  }

  _gsDataWrite(v) {
    const g = this.gs;
    if (g.state === 'EXT_GS_DATA') {
      const t = this.transfer;
      if (t && t.dir === 'w' && (t.transport & 1)) {
        if (!t.grantLive) { this._gsErr(ERR.STATE); return; }
        if (g.db) { this._gsErr(ERR.BUSY); return; }               // WD violation
        g.db = true; g._pendingByte = v;
      } else this._gsErr(ERR.STATE);
      return;
    }
    if (this._xferOpen()) {
      // packet transfer owns the card: DATA writes are acked+discarded with
      // GS_ERROR=BUSY; offsets/packet accounting never move (spec 8.4)
      this._gsErr(ERR.BUSY);
      return;
    }
    if (g.state === 'LOAD') {
      const o = g.loadObj;
      if (o) {
        if (o.uploaded < o.reserved) this.psram[o.dataOff + o.uploaded++] = v;
        else o.loadOverflow = true;      // keep acking+discarding until D2
      }
      g.db = false;
      return;
    }
    if (g.state === 'POST') {
      g.postBuf.push(v); g.db = false;
      if (g.postBuf.length === g.postNeed) this._gsApplyPost();
      return;
    }
    if (g.db) { this._gsErr(0x01); g.db = false; return; }         // SD while DB set
    g.inPre = v; g.inPreSet = true;                                // single pre latch
  }

  _gsDataRead() {
    const g = this.gs;
    if (g.state === 'EXT_GS_DATA') {
      if (g.db) {
        g.db = false;
        const t = this.transfer;                                 // consume prefetched byte
        if (t && t.dir === 'r') { t.idx++; t.lastDataUs = this.nowUs; this.stats.downloadBytes++; }
        return g.outLatch;
      }
      return 0xFF;                                               // WN violation: not ready
    }
    if (g.outQ.length) {
      const v = g.outQ.shift();
      g.outLatch = v;                                            // last byte stays rereadable
      if (!g.outQ.length) { g.db = false; g.state = 'NORMAL'; }
      return v;
    }
    return g.outLatch;                                           // [old]/LOAD preliminary read
  }

  _gsCommandWrite(c) {
    const g = this.gs;
    g.cb = false;                                                // command accepted
    // F3/F4 act in every state incl. LOAD/EXT_GS_DATA (full store reset)
    if (c === 0xF3 || c === 0xF4) { this._storeReset(c === 0xF4 ? 1 : 0); return; }
    if (g.state === 'LOAD') {
      // LOAD whitelist: only D2 acts; every other command (incl. 00/08/D0/D1/
      // F0/F5) is acked and ignored without touching offset/GS_ERROR/latch
      if (c === 0xD2) {
        if (this._xferOpen()) { this._gsErr(ERR.BUSY); return; } // packet unfinished
        return this._gsLoadClose();
      }
      return;
    }
    if (g.state === 'EXT_GS_DATA') {
      if (c === 0x00) { this._cancelTransfer('gs-00'); return; }
      this._gsErr(ERR.BUSY);                                     // ordinary cmds -> BUSY
      return;
    }
    if (c === 0x00) {
      // NORMAL/POST/RESPONSE: reset GS flags/args/errors only; a BULK packet
      // transfer is NOT cancelled by this (gs-00 cancels via EXT_GS_DATA only)
      g.outQ = []; g.postBuf = []; g.pendingCmd = null;
      g.db = false; g.inPreSet = false; g.state = 'NORMAL';
      this.gserr = 0;
      return;
    }
    if (this._xferOpen()) { this._gsErr(ERR.BUSY); return; }     // other cmds incl. D2
    // a new SC aborts any pending POST sequence (no partial apply); 6B has a
    // legal short form that completes first
    if (g.state === 'POST' && g.pendingCmd) {
      const pc = g.pendingCmd;
      g.pendingCmd = null; g.state = 'NORMAL'; g.postBuf = [];
      if (pc.cmd === 0x6B) this._gsExec(0x6B, pc.pre, []);       // short form: 512 words
    }
    g.outQ = [];                                                 // new SC drops old response
    if (g.state === 'RESPONSE') g.state = 'NORMAL';
    g.db = false;
    if (c === 0xD0 || c === 0xD1) return;                          // pure no-op, never an error
    const def = UgCard.GS_CMDS[c];
    if (!def) { this._gsErr(0x01); return; }
    if (def.load) {                                              // LOAD stream open
      const kind = def.load === 'module' ? 3 : 1;
      return this._gsLoadStart(kind, g.inPreSet ? g.inPre : null, c);
    }
    g.postNeed = c === 0x6B ? 1 : def.post;                      // 6B: optional hi (short form)
    g.postBuf = [];
    g.pendingCmd = { cmd: c, pre: g.inPreSet ? g.inPre : null };
    g.inPreSet = false;
    if (g.postNeed > 0) { g.state = 'POST'; return; }
    this._gsApplyPost();
  }

  _gsApplyPost() {
    const g = this.gs, cmd = g.pendingCmd; g.pendingCmd = null;
    g.state = 'NORMAL';
    if (!cmd) return;
    const out = this._gsExec(cmd.cmd, cmd.pre, g.postBuf);
    if (out.length) {
      g.outQ = out.slice();
      g.db = true; g.state = 'RESPONSE';
    }
  }

  _gsExec(cmd, pre, post) {
    const g = this.gs;
    switch (cmd) {
      case 0x00: case 0x08: return [];                           // no-ops (00 handled earlier)
      case 0xF0: return [this.gserr];                            // read GS_ERROR, no clear
      case 0x6A: { const old = g.reg6a; g.reg6a = pre ?? 0; return [old]; }
      case 0x6B: {
        const lo = pre ?? 0, hi = post[0];
        if (hi === undefined) g.reg6b = 512;                     // short form: 512 words
        else {
          const words = lo | (hi << 8);
          g.reg6b = (words <= 16384) ? words : 512;              // invalid normalizes to 512
        }
        return [];
      }
      case 0x69: return [];                                      // one MOD tick: no MOD engine
      case 0xF5: this.gs.busyOn = true; return [];
      case 0xF6: this.gs.busyOn = false; return [];
      default:
        // declared in the profile but with no modelled semantics in S0b:
        // ack honestly via GS_ERROR rather than fake success
        this._gsErr(0x01);
        return [];
    }
  }

  _gsLoadStart(kind, pre, cmd) {
    const g = this.gs;
    if (g.loadObj) { this._gsErr(ERR.BUSY); return; }            // LOAD already open
    if (kind === 3 && this.legacyMod) {
      // a new legacy module replaces all legacy-owned objects first (8.4);
      // foreign pins stop the whole operation before any deletion
      const pinned = [...this.objects.values()].some((o) => o.legacyOwned && o.pins > 0);
      if (pinned) { this._gsErr(ERR.PINNED); return; }
      for (const o of [...this.objects.values()]) if (o.legacyOwned) this._freeObject(o);
      this.legacyMod = 0; this.legacyFx.clear();
    }
    const largest = this.freeList.reduce((a, e) => Math.max(a, e.size), 0);
    if (!largest) { this._gsErr(ERR.NO_MEMORY); return; }
    if (this.nextHandle > 0xFFFF) { this._gsErr(ERR.NO_HANDLES); return; }
    // reserve the legacy number now so the preliminary GD can report it
    let legacyNum;
    if (kind === 3) legacyNum = 1;                               // single MOD slot
    else {
      for (legacyNum = 1; legacyNum <= 60 && this.legacyFx.has(legacyNum); legacyNum++);
      if (legacyNum > 60) { this._gsErr(ERR.NO_HANDLES); return; }
    }
    const alloc = this._allocPsram(largest);
    const handle = this.nextHandle++;
    this.handlesIssued++;
    const o = {
      handle, kind, state: 0, pins: 1, size: 0, reserved: largest, uploaded: 0,
      crc: 0, dataOff: alloc, dataLen: 0, rate: 0, frames: 0,
      channels: 0, bits: 0, fmt: 0, modCh: 0, pending: true, legacyNum,
      legacyOwned: true, loadOverflow: false,
      // RAW fmt at publish: 38 always U8(0); 3E pre 0=S8(1), 1=U8(0) (8.3.11)
      loadFmt: cmd === 0x3E ? (pre === 0 ? 1 : 0) : 0,
    };
    this.objects.set(handle, o);
    g.loadObj = o; g.loadLegacy = legacyNum; g.state = 'LOAD';
    g.outLatch = legacyNum;                                      // preliminary via [old] read
    g.db = false;
  }

  _gsLoadClose() {
    const g = this.gs, o = g.loadObj; g.loadObj = null; g.state = 'NORMAL';
    const finish = (byte) => { g.outQ = [byte]; g.outLatch = byte; g.db = true; g.state = 'RESPONSE'; };
    const drop = (err) => {
      if (o) { this._freePsram(o.dataOff, o.reserved); this.objects.delete(o.handle); }
      if (err) this._gsErr(err);
      finish(0);
    };
    if (!o) return drop(0);
    // honest S0b scope: no MOD parser -> module streams fail at close, the
    // pending object is freed and no READY object is ever faked
    if (o.kind === 3) return drop(ERR.FORMAT);
    if (o.uploaded === 0 || o.loadOverflow) return drop(ERR.LENGTH);
    // shrink: free only the aligned remainder past the filled prefix
    const keep = align16(o.uploaded);
    this._freePsram(o.dataOff + keep, o.reserved - keep);
    o.reserved = keep; o.size = o.uploaded;
    o.crc = crc32done(crc32(this.psram.slice(o.dataOff, o.dataOff + o.size)));
    o.state = 1; o.pending = false; o.pins = 0;
    // FX stream creates RAW mono 8-bit with per-command sign metadata (8.4)
    o.rate = 16574; o.channels = 1; o.bits = 8;
    o.fmt = o.loadFmt; o.dataLen = o.size;
    this.legacyFx.set(o.legacyNum, o.handle);
    finish(o.legacyNum);                                          // legacy u8 handle
  }

  _storeReset(level) {
    const keep6a = level === 0 ? this.gs.reg6a : 0;
    const keep6b = level === 0 ? this.gs.reg6b : 0;
    const keepCfg = this.cfg, keepBase = this.base, keepAlias = this.alias,
      keepGsAliases = this.gsAliases, keepMode = this.mode,
      keepDesired = this.desiredMode, keepResult = this.cfgResult;
    this.reset();
    this.cfg = keepCfg; this.base = keepBase; this.alias = keepAlias;
    this.gsAliases = keepGsAliases; this.mode = keepMode; this.desiredMode = keepDesired;
    this.cfgResult = keepResult;
    this.gs.reg6a = keep6a; this.gs.reg6b = keep6b;
    this.session += 1n;                                           // new session id
  }

  _buildSnapshot() {
    const b = new Uint8Array(64);                                // summary only; voices are paged
    w32(b, 0, ++this.snapSeq);                                   // advancing seq
    for (let i = 0; i < 8; i++) b[4 + i] = Number((this.session >> BigInt(8 * i)) & 0xFFn);
    // output_frames 12..19 = 0: no I2S engine runs in this model
    b[50] = 0;                                                   // last_audio_error
    w32(b, 56, this.transfer ? this.transfer.id : 0);
    w16(b, 60, this.transfer ? (this.transfer.dir === 'w' ? this.transfer.got : this.transfer.idx) : 0);
    w16(b, 62, this.transfer ? this.transfer.n : 0);
    return b;
  }

  // ================= PSRAM allocator =================
  _allocPsram(size) {
    for (let i = 0; i < this.freeList.length; i++) {
      const e = this.freeList[i];
      if (e.size >= size) {
        const off = e.off;
        e.off += size; e.size -= size;
        if (!e.size) this.freeList.splice(i, 1);
        return off;
      }
    }
    return -1;
  }
  _freePsram(off, size) {
    if (size <= 0) return;
    this.freeList.push({ off, size });
    this.freeList.sort((a, b) => a.off - b.off);
    for (let i = 0; i + 1 < this.freeList.length; i++) {
      const a = this.freeList[i], b = this.freeList[i + 1];
      if (a.off + a.size === b.off) { a.size += b.size; this.freeList.splice(i + 1, 1); i--; }
    }
  }

  // ================= config ports 0x1D0..0x1D2 (proto4) =================
  _cfgWrite(port, v) {
    const c = this.cfg;
    if (port === 0x1D0) {
      if (v === 0xCC) { c.unlocked = true; return; }
      if (!c.unlocked) return;
      c.sel = v; c.lo = 0;                                       // new select resets staged LOW
      if (v === 0xE3) this.catalogIndex = 0;
      return;
    }
    if (!c.unlocked) return;
    if (port === 0x1D1) { c.lo = v; return; }
    if (port === 0x1D2) return this._cfgApply(v);
  }

  _cfgApply(hi) {
    const c = this.cfg;
    const res = (e) => { this.cfgResult = e; };
    switch (c.sel) {
      case 0x76: case 0x77: {                                    // UG_BASE / UG_ALIAS
        const val = c.lo | (hi << 8);
        const isAlias = c.sel === 0x77;
        if (isAlias && val === 0xFFFF) { this.alias = 0xFFFF; return res(0); }
        if (val < 0x200 || val > 0x3FF - 31 || (val & 31) !== 0) return res(ERR.BAD_ARGUMENT);
        const other = isAlias ? this.base : this.alias;
        const overlaps = (a, b) => a < b + 0x20 && a + 0x20 > b;
        if (other !== 0xFFFF && overlaps(val, other)) return res(ERR.BAD_ARGUMENT);
        if (val <= 0x1D2 && val + 0x20 > 0x1D0) return res(ERR.BAD_ARGUMENT);
        if (this.gsAliases && (val <= 0xBB && val + 0x20 > 0xB3)) return res(ERR.BAD_ARGUMENT);
        if (this.mode === 8 && !this._configIdle()) return res(ERR.BUSY);
        if (isAlias) this.alias = val; else this.base = val;
        return res(0);
      }
      case 0x79: {                                               // UG_GS_ALIASES (volatile)
        if (hi > 1) return res(ERR.BAD_ARGUMENT);
        if (this.mode !== 8) return res(ERR.STATE);
        if (this.gs.state !== 'NORMAL' || this._xferOpen()) return res(ERR.BUSY);
        this.gsAliases = hi === 1;
        return res(0);
      }
      case 0x03: {                                               // BOOTMODE: mode id, not slot
        if (hi < 1 || hi > 8) return res(ERR.BAD_ARGUMENT);
        if (hi === 7) return res(ERR.STATE);                     // known but absent
        this.desiredMode = hi;                                   // staged; reboot applies
        return res(0);
      }
      case 0xE1:                                                 // SAVE
        return res(hi === 0xFF ? 0 : ERR.BAD_ARGUMENT);
      case 0xE2:                                                 // CMD_REBOOT request
        if (hi !== 0xFF) return res(ERR.BAD_ARGUMENT);
        this.rebootRequested = true;
        return res(0);
      default:
        return res(ERR.BAD_ARGUMENT);                            // unsupported selector write
    }
  }

  _catalogByte() {
    const i = this.catalogIndex++;
    if (i >= this._catalog.length) return 0xFF;
    return this._catalog[i];
  }
  get _catalog() {
    if (this.__cat) return this.__cat;
    const b = new Uint8Array(148);
    b.set([0x55, 0x47, 0x43, 0x46], 0);                          // "UGCF"
    b[4] = 1; b[5] = 0; b[6] = 8; b[7] = 16;
    w32(b, 8, 148);
    for (let m = 1; m <= 8; m++) {
      const o = 16 + (m - 1) * 16;
      b[o] = m; b[o + 1] = m === 7 ? 0 : 1;                      // mode7 absent
      w32(b, o + 4, 0x10000 + m * 0x20000); w32(b, o + 8, m === 7 ? 0 : 0x20000);
      w32(b, o + 12, m === 7 ? 0 : crc32done(crc32(Buffer.from(`image${m}`))));
    }
    w32(b, 144, crc32done(crc32(b.slice(0, 144))));
    this.__cat = b;
    return b;
  }

  _cfgRead(port) {
    const c = this.cfg;
    if (port === 0x1D0) return c.sel;
    if (port === 0x1D1) {                                        // DATA_LOW read
      if (c.sel === 0x76) return this.base & 0xFF;
      if (c.sel === 0x77) return this.alias & 0xFF;
      return 0xFF;
    }
    if (port === 0x1D2) {                                        // DATA_HIGH read
      switch (c.sel) {
        case 0x00: return 0xDD;
        case 0x01: return 4;
        case 0x76: return (this.base >> 8) & 0xFF;
        case 0x77: return (this.alias >> 8) & 0xFF;
        case 0x78: return this.cfgResult;
        case 0x79: return this.gsAliases ? 1 : 0;
        case 0xE3: return this._catalogByte();
        case 0xE4: return this.mode;
        case 0xE5: return 0;                                     // boot result OK
        default: return 0xFF;
      }
    }
    return 0xFF;
  }
}

// §8.2 command handshake table, loaded from the single checked schema so the
// model's profile never drifts from the declared command surface.
// Entries: { pre, post, out, range?, load? } -- pre/post counts with -1 marking
// an optional byte (e.g. 6B short form), load marks stream-open commands.
UgCard.GS_CMDS = (() => {
  const schema = require('../../../tools/ultrags/wire-schema.json');
  const num = (v) => typeof v === 'number' ? v : parseInt(v, 16);
  const map = {};
  for (const g of schema.gsCommands) {
    const base = num(g.hex);
    const hi = g.range ? num(g.range.split('-')[1]) : base;
    for (let c = base; c <= hi; c++)
      map[c] = { pre: g.pre ?? 0, post: g.post ?? 0, out: g.out ?? 0, load: g.load || null };
  }
  // D2 (LOAD close) is in the schema range table? It is state-whitelisted in
  // the model, not dispatched here; keeping an entry documents its profile.
  if (!map[0xD2]) map[0xD2] = { pre: 0, post: 0, out: 1 };
  return map;
})();

UgCard.ERR = ERR; UgCard.XS = XS; UgCard.XC = XC;
UgCard.PSRAM_BYTES = PSRAM_BYTES; UgCard.MAX_BLOCK = MAX_BLOCK;
UgCard.FRAME_RX_US = FRAME_RX_US; UgCard.GRANT_IDLE_US = GRANT_IDLE_US;
UgCard.crc32 = crc32; UgCard.crc32done = crc32done;
module.exports = UgCard;
