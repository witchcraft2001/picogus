#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// ug-card-test.mjs - unit tests for the strict Ultra GS card model.
// Drives the model at the ISA port level (X_REQUEST byte stream,
// X_RESPONSE reads, BULK/GS_DATA grants, config ports) and checks the
// normative frame/grant/state/error behaviour of spec 5-8.
//
// Usage: node tests/ultrags/dss/ug-card-test.mjs <repo> [build_dir]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const REPO = resolve(process.argv[2] || '.');
const BUILD = resolve(process.argv[3] || join(REPO, 'build/ultrags'));
const require = createRequire(import.meta.url);
const UgCard = require(join(REPO, 'tests/ultrags/dss/ug-card.js'));
const { ERR, XS, XC } = UgCard;

let pass = 0, fail = 0;
const results = [];
const ok = (n, d = '') => { pass++; results.push({ n, ok: true, d }); console.log(`PASS ${n}${d ? ' -- ' + d : ''}`); };
const bad = (n, d = '') => { fail++; results.push({ n, ok: false, d }); console.log(`FAIL ${n} -- ${d}`); };
const eq = (a, b) => a === b;
const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- port-level helpers (model the ISA window directly) ----
const B = (card, off) => card.base + off;
const wr = (card, off, v) => card.writePort(B(card, off), v);
const rd = (card, off) => card.readPort(B(card, off));
const status = (card) => rd(card, 0x01);

function rpc(card, op, payload = [], { crc = false } = {}) {
  // block while not READY would be a bug in the model under test
  const bytes = [op | (crc ? 0x80 : 0), payload.length, ...payload];
  if (crc) {
    const c = UgCard.crc32done(UgCard.crc32(bytes));
    bytes.push(c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF, (c >>> 24) & 0xFF);
  }
  for (const b of bytes) { wr(card, 0x03, b); card.tickUs(0); }
  // read until status REPLY drops (response fully consumed)
  const out = [];
  for (let guard = 0; guard < 256 && (status(card) & XS.REPLY); guard++) {
    out.push(rd(card, 0x03));
  }
  return out; // [status, len, payload...]
}
const rpcStatus = (r) => r[0];
const rpcPayload = (r) => r.slice(2, 2 + (r[1] || 0));

function bulkWrite(card, bytes) {
  for (const b of bytes) { wr(card, 0x00, b); card.tickUs(0); }
}
function bulkRead(card, n) {
  const out = [];
  for (let i = 0; i < n; i++) { out.push(rd(card, 0x00)); card.tickUs(0); }
  return out;
}
const u32 = (n) => [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF];
const u16 = (n) => [n & 0xFF, (n >> 8) & 0xFF];

// =================== tests ===================

// Musical metadata is outside S0b; a partial descriptor must never report
// fake success while CAPS.formats advertises zero playable formats.
{
  const card = new UgCard();
  const r = rpc(card, 0x14, Array(26).fill(0));
  r[0] === ERR.BAD_OPCODE ? ok('PCM_CONFIG explicitly outside model scope')
    : bad('PCM_CONFIG scope', `status=${r[0]}`);
}


// --- config ports: proto4 unlock + ULTRAGS identification ---
{
  const card = new UgCard();
  card.writePort(0x1D0, 0xCC);
  card.writePort(0x1D0, 0);
  if (card.readPort(0x1D0) !== 0 || card.readPort(0x1D2) !== 0xDD) bad('cfg magic', 'selector/data mismatch'); else ok('cfg magic');
  card.writePort(0x1D0, 0x01);
  if (card.readPort(0x1D2) !== 4) bad('cfg protocol', ''); else ok('cfg protocol=4');
  card.writePort(0x1D0, 0xE4);
  if (card.readPort(0x1D2) !== 8) bad('cfg fw_active', `want 8 got ${card.readPort(0x1D2)}`);
  else ok('cfg FW_ACTIVE=8 (ULTRAGS)');
}

// --- INFO frame, no CRC ---
{
  const card = new UgCard();
  const r = rpc(card, 0x00, []);
  if (rpcStatus(r) !== 0 || r[1] !== 40) bad('info fast', `status=${r[0]} len=${r[1]}`);
  else {
    const p = rpcPayload(r);
    if (p.slice(0, 4).join(',') === '85,71,83,49' && p[6] === 8) ok('info fast', 'UGS1 mode 8');
    else bad('info fast', `bad payload ${p.slice(0, 8)}`);
  }
}

// --- INFO frame with FRAME_CRC ---
{
  const card = new UgCard();
  const r = rpc(card, 0x00, [], { crc: true });
  if (rpcStatus(r) !== 0 || r[1] !== 40 || r.length !== 46) bad('info crc', `len=${r.length}`);
  else ok('info crc', `${r.length} bytes incl trailer`);
}

// --- bad frame CRC -> CRC error reply ---
{
  const card = new UgCard();
  const bytes = [0x80, 0x00, 0x00, 0x00, 0x00, 0x00]; // INFO+CRC with wrong trailer
  for (const b of bytes) wr(card, 0x03, b);
  const r = []; while (status(card) & XS.REPLY) r.push(rd(card, 0x03));
  r[0] === ERR.CRC ? ok('bad frame crc -> CRC') : bad('bad frame crc', `status=${r[0]}`);
}

// --- payload_length >128 -> FAULT, stuck until TRANSPORT_RESET ---
{
  const card = new UgCard();
  wr(card, 0x03, 0x00); wr(card, 0x03, 0x81);   // INFO, len=129
  const st = status(card);
  const okF = !(st & XS.READY) && !(st & XS.REPLY) && (card.xerr === ERR.LENGTH);
  wr(card, 0x03, 0xAA);                        // discarded
  if (!(status(card) & XS.REPLY)) { /* still faulted */ }
  wr(card, 0x02, XC.TRANSPORT_RESET);
  const recovered = (status(card) & XS.READY) !== 0;
  okF && recovered ? ok('len>128 FAULT + reset recovery') : bad('len>128 FAULT', `xerr=${card.xerr} st=${st.toString(16)}`);
}

// --- ALLOC + WRITE_BEGIN + bulk + WRITE_END + OBJECT_INFO + SEAL + READ_BEGIN + readback + READ_END (FAST) ---
{
  const card = new UgCard();
  const data = [];
  for (let i = 0; i < 1024; i++) data.push((i * 37 + 11) & 0xFF);

  const al = rpc(card, 0x10, [0, ...u32(1024)]);                  // kind=0 BLOB, 1KiB
  if (rpcStatus(al) !== 0) { bad('alloc', `status ${al[0]}`); }
  const handle = al[2] | (al[3] << 8);
  const reserved = al[4] | (al[5] << 8) | (al[6] << 16) | (al[7] << 24);
  if (rpcStatus(al) === 0 && handle >= 1 && reserved === 1024) ok('alloc raw 1KiB', `h=${handle} reserved=${reserved}`);
  else bad('alloc raw 1KiB', `${JSON.stringify(al)}`);

  // early data access before BEGIN response is read -> would be STATE
  const wb = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(1024), 0x00]);
  const tid = le32s(wb, 2);
  if (rpcStatus(wb) === 0 && tid > 0 && (status(card) & XS.WRITE_GRANT)) ok('write_begin grant', `tid=${tid}`);
  else bad('write_begin grant', JSON.stringify(wb));

  bulkWrite(card, data);
  const we = rpc(card, 0x21, u32(tid));
  rpcStatus(we) === 0 ? ok('write_end commit', 'OK') : bad('write_end commit', `status ${we[0]}`);

  const oi = rpc(card, 0x12, u16(handle));
  const uploaded = le32s(oi, 12);
  rpcStatus(oi) === 0 && uploaded === 1024 ? ok('object_info uploaded=1024') : bad('object_info', `uploaded=${uploaded}`);

  const se = rpc(card, 0x13, [...u16(handle), 0, 0, 0, 0, 0]);
  rpcStatus(se) === 0 ? ok('seal', `crc=${le32s(se, 2).toString(16)}`) : bad('seal', JSON.stringify(se));

  const rb = rpc(card, 0x22, [...u16(handle), 0, 0, 0, 0, ...u16(1024), 0x00]);
  const rtid = le32s(rb, 2);
  rpcStatus(rb) === 0 && (status(card) & XS.READ_GRANT) ? ok('read_begin grant') : bad('read_begin', JSON.stringify(rb));
  const back = bulkRead(card, 1024);
  eqBytes(back, data) ? ok('bulk readback identical', '1024B') : bad('bulk readback', 'mismatch');
  const re = rpc(card, 0x23, u32(rtid));
  rpcStatus(re) === 0 ? ok('read_end', 'OK') : bad('read_end', `status ${re[0]}`);
}
function le32s(a, o) { return (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0; }

// --- VERIFIED write+read round trip ---
{
  const card = new UgCard();
  const data = []; for (let i = 0; i < 256; i++) data.push(i ^ 0x5A);
  rpc(card, 0x10, [1, ...u32(256)]);
  const oi = rpc(card, 0x15, [0, 0]); const handle = le32s(oi, 2) & 0xFFFF;
  const blockCrc = UgCard.crc32done(UgCard.crc32(Uint8Array.from(data)));
  const wb = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(256), 0x80, ...u32(blockCrc)]);
  rpcStatus(wb) === 0 ? ok('verified write_begin') : bad('verified write_begin', JSON.stringify(wb));
  bulkWrite(card, data);
  const we = rpc(card, 0x21, u32(le32s(wb, 2)));
  rpcStatus(we) === 0 ? ok('verified write_end crc match') : bad('verified write_end', `status ${we[0]}`);

  const rb = rpc(card, 0x22, [...u16(handle), 0, 0, 0, 0, ...u16(256), 0x80]);
  rpcStatus(rb) === 0 && rb.length === 10 ? ok('verified read_begin id+crc') : bad('verified read_begin', JSON.stringify(rb));
  const back = bulkRead(card, 256);
  const hostCrc = UgCard.crc32done(UgCard.crc32(Uint8Array.from(back)));
  const re = rpc(card, 0x23, [...u32(le32s(rb, 2)), ...u32(hostCrc)]);
  rpcStatus(re) === 0 && eqBytes(back, data) ? ok('verified read_end + host crc') : bad('verified read_end', `status ${re[0]}`);
}

// --- write_begin VERIFIED with wrong crc -> CRC error, object unchanged ---
{
  const card = new UgCard();
  const al = rpc(card, 0x10, [1, ...u32(64)]);
  const handle = le32s(al, 2) & 0xFFFF;
  const wb = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(64), 0x80, ...u32(0xDEADBEEF)]);
  bulkWrite(card, new Array(64).fill(0xAA));
  const we = rpc(card, 0x21, u32(le32s(wb, 2)));
  rpcStatus(we) === ERR.CRC ? ok('verified write crc mismatch -> CRC err + no commit') : bad('verified crc mismatch', `status ${we[0]}`);
  const oi = rpc(card, 0x12, u16(handle));
  le32s(oi, 12) === 0 ? ok('no commit on crc fail (uploaded=0)') : bad('crc fail uploaded', `${le32s(oi, 12)}`);
}

// --- negative: write without grant -> STATE, read without grant -> FF/UNDERFLOW ---
{
  const card = new UgCard();
  wr(card, 0x00, 0xAA);
  card.xerr === ERR.STATE ? ok('bulk write no grant -> STATE') : bad('bulk write no grant', `xerr=${card.xerr}`);
  wr(card, 0x02, XC.CLEAR_ERRORS);
  const v = rd(card, 0x00);
  v === 0xFF && card.xerr === ERR.UNDERFLOW ? ok('bulk read no transfer -> FF+UNDERFLOW') : bad('bulk read no transfer', `v=${v} xerr=${card.xerr}`);
}

// --- negative: extra byte invalidates block (OVERFLOW), END -> OVERFLOW no commit ---
{
  const card = new UgCard();
  const al = rpc(card, 0x10, [1, ...u32(4)]);
  const handle = le32s(al, 2) & 0xFFFF;
  const wb = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(4), 0x00]);
  bulkWrite(card, [1, 2, 3, 4]);
  wr(card, 0x00, 0x55);                                          // 5th byte
  const we = rpc(card, 0x21, u32(le32s(wb, 2)));
  rpcStatus(we) === ERR.OVERFLOW && card.xerr === ERR.OVERFLOW
    ? ok('extra byte -> OVERFLOW + no commit')
    : bad('extra byte overflow', `we=${we[0]} xerr=${card.xerr}`);
}

// --- negative: short block -> SHORT_TRANSFER, token released ---
{
  const card = new UgCard();
  const al = rpc(card, 0x10, [1, ...u32(8)]);
  const handle = le32s(al, 2) & 0xFFFF;
  const wb = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(8), 0x00]);
  bulkWrite(card, [1, 2, 3]);
  const we = rpc(card, 0x21, u32(le32s(wb, 2)));
  const oi = rpc(card, 0x12, u16(handle));
  rpcStatus(we) === ERR.SHORT_TRANSFER && le32s(oi, 12) === 0 && !card.transfer
    ? ok('short block -> SHORT_TRANSFER + released')
    : bad('short transfer', `we=${we[0]} uploaded=${le32s(oi, 12)}`);
}

// --- negative: wrong END token -> HANDLE, transfer stays ---
{
  const card = new UgCard();
  const al = rpc(card, 0x10, [1, ...u32(4)]);
  const handle = le32s(al, 2) & 0xFFFF;
  const wb = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(4), 0x00]);
  bulkWrite(card, [9, 9, 9, 9]);
  const we = rpc(card, 0x21, u32(0xDEADBEEF));
  const still = card.transfer !== null;
  const we2 = rpc(card, 0x21, u32(le32s(wb, 2)));
  rpcStatus(we) === ERR.HANDLE && still && rpcStatus(we2) === 0
    ? ok('bad END token -> HANDLE, real END still commits')
    : bad('bad END token', `${we[0]} still=${still} we2=${we2[0]}`);
}

// --- negative: second BEGIN while grant open -> BUSY; whitelist INFO ok ---
{
  const card = new UgCard();
  const al = rpc(card, 0x10, [1, ...u32(4)]);
  const handle = le32s(al, 2) & 0xFFFF;
  rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(4), 0x00]);
  const wb2 = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(4), 0x00]);
  const inf = rpc(card, 0x00, []);
  const ca = rpc(card, 0x01, []);                                 // CAPS not whitelisted
  rpcStatus(wb2) === ERR.BUSY && rpcStatus(inf) === 0 && rpcStatus(ca) === ERR.BUSY
    ? ok('BUSY during grant + whitelist (INFO ok, CAPS busy)')
    : bad('whitelist', `wb2=${wb2[0]} info=${inf[0]} caps=${ca[0]}`);
  rpc(card, 0x24, u32(card.transfer.id));                         // cleanup
}

// --- negative: N=0 and N>1024 -> LENGTH ---
{
  const card = new UgCard();
  const al = rpc(card, 0x10, [1, ...u32(2048)]);
  const handle = le32s(al, 2) & 0xFFFF;
  const z = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(0), 0x00]);
  const big = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(1025), 0x00]);
  rpcStatus(z) === ERR.LENGTH && rpcStatus(big) === ERR.LENGTH
    ? ok('N=0/N=1025 -> LENGTH') : bad('N bounds', `z=${z[0]} big=${big[0]}`);
}

// --- transfer inactivity timeout: grant expires after 5000ms ---
{
  const card = new UgCard();
  const al = rpc(card, 0x10, [1, ...u32(4)]);
  const handle = le32s(al, 2) & 0xFFFF;
  rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(4), 0x00]);
  card.tickUs(5001 * 1000);                                       // 5001 ms idle
  const gone = card.transfer === null && card.xerr === ERR.TIMEOUT;
  const wb2 = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(4), 0x00]);
  gone && rpcStatus(wb2) === 0 ? ok('grant inactivity timeout -> TIMEOUT + reusable')
    : bad('grant timeout', `xerr=${card.xerr} wb2=${wb2[0]}`);
}

// --- incomplete frame RX timeout: 1000ms ---
{
  const card = new UgCard();
  wr(card, 0x03, 0x00); wr(card, 0x03, 0x02);                     // header asks 2 payload bytes
  wr(card, 0x03, 0xAA);                                          // only 1 byte arrives
  card.tickUs(1001 * 1000);
  (status(card) & (XS.READY | XS.REPLY)) === 0 && card.xerr === ERR.TIMEOUT
    ? ok('incomplete RX 1000ms -> FAULT/TIMEOUT')
    : bad('rx timeout', `st=${status(card).toString(16)} xerr=${card.xerr}`);
}

// --- X_CONTROL: TRANSFER_CANCEL / CLEAR_ERRORS / bad value ---
{
  const card = new UgCard();
  wr(card, 0x02, 0x55);
  card.xerr === ERR.BAD_ARGUMENT ? ok('x_control bad value -> BAD_ARGUMENT') : bad('x_control', `xerr=${card.xerr}`);
  wr(card, 0x02, XC.CLEAR_ERRORS);
  card.xerr === 0 ? ok('clear_errors') : bad('clear_errors', `${card.xerr}`);
  const al = rpc(card, 0x10, [1, ...u32(4)]);
  const handle = le32s(al, 2) & 0xFFFF;
  rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(4), 0x00]);
  wr(card, 0x02, XC.TRANSFER_CANCEL);
  card.transfer === null ? ok('x_control transfer_cancel') : bad('transfer_cancel', 'still active');
}

// --- alias window: 32 consecutive addresses = same stream ---
{
  const card = new UgCard({ alias: 0x280 });
  const al = rpc(card, 0x10, [1, ...u32(40)]);
  const handle = le32s(al, 2) & 0xFFFF;
  const wb = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(40), 0x00]);
  for (let i = 0; i < 40; i++) card.writePort(0x280 + (i % 32), i);  // wrap inside window
  const we = rpc(card, 0x21, u32(le32s(wb, 2)));
  const rb = rpc(card, 0x22, [...u16(handle), 0, 0, 0, 0, ...u16(40), 0x00]);
  const back = []; for (let i = 0; i < 40; i++) back.push(card.readPort(0x280 + (i % 32)));
  rpc(card, 0x23, u32(le32s(rb, 2)));
  const expect = Array.from({ length: 40 }, (_, i) => i);
  rpcStatus(we) === 0 && eqBytes(back, expect)
    ? ok('alias window streaming (wrapped 32-address window)') : bad('alias stream', `we=${we[0]}`);
}

// --- bulk via alias does NOT leak into neighbouring regs (boundary) ---
{
  const card = new UgCard({ alias: 0x280 });
  card.writePort(0x280 + 32, 0x12);       // 0x2A0 = native BULK_DATA (still stream, no grant -> STATE)
  card.xerr === ERR.STATE ? ok('alias boundary: +32 is native BULK_DATA, not alias byte 32') : bad('alias boundary', `xerr=${card.xerr}`);
}

// --- GS latch idle status 7E + unknown command GS_ERROR ---
{
  const card = new UgCard();
  rd(card, 0x1B) === 0x7E ? ok('gs idle STATUS=7E') : bad('gs idle', `${rd(card, 0x1B).toString(16)}`);
  wr(card, 0x1B, 0x77);                                            // undeclared cmd
  rd(card, 0x1B) === 0x7E && card.gserr !== 0 ? ok('unknown gs cmd -> ack + GS_ERROR') : bad('gs unknown cmd', `st=${rd(card, 0x1B).toString(16)} err=${card.gserr}`);
}

// --- GS_DATA transport write path (EXT_GS_DATA latch) ---
{
  const card = new UgCard();
  const data = [0x11, 0x22, 0x33, 0x44];
  const al = rpc(card, 0x10, [1, ...u32(4)]);
  const handle = le32s(al, 2) & 0xFFFF;
  const wb = rpc(card, 0x20, [...u16(handle), 0, 0, 0, 0, ...u16(4), 0x01]);  // GS_FAST
  for (const b of data) { wr(card, 0x13, b); card.tickUs(0); }
  const we = rpc(card, 0x21, u32(le32s(wb, 2)));
  const rb = rpc(card, 0x22, [...u16(handle), 0, 0, 0, 0, ...u16(4), 0x01]);  // read via GS_DATA
  const back = [];
  for (let i = 0; i < 4; i++) { card.tickUs(0); back.push(rd(card, 0x13)); }
  rpc(card, 0x23, u32(le32s(rb, 2)));
  rpcStatus(we) === 0 && eqBytes(back, data)
    ? ok('GS_DATA slow transport write+read')
    : bad('GS_DATA transport', `we=${we[0]} back=${back}`);
}

// --- GS_DATA transport occupied: second GS begin -> BUSY, bulk write still fine ---
{
  const card = new UgCard();
  rpc(card, 0x10, [1, ...u32(4)]);
  rpc(card, 0x10, [1, ...u32(4)]);
  const hs = [...card.objects.keys()];
  rpc(card, 0x20, [...u16(hs[0]), 0, 0, 0, 0, ...u16(4), 0x01]);   // gs path
  const w2 = rpc(card, 0x20, [...u16(hs[1]), 0, 0, 0, 0, ...u16(4), 0x00]);
  rpcStatus(w2) === ERR.BUSY ? ok('second begin while transfer -> BUSY (any transport)') : bad('busy begin', `${w2[0]}`);
}

// --- u32 OOB: write past reserved extent -> RANGE ---
{
  const card = new UgCard();
  const al = rpc(card, 0x10, [1, ...u32(1024)]);
  const handle = le32s(al, 2) & 0xFFFF;
  const wb = rpc(card, 0x20, [...u16(handle), ...u32(0xFFFFF000), ...u16(4), 0x00]);
  rpcStatus(wb) === ERR.RANGE ? ok('u32 OOB offset -> RANGE') : bad('oob offset', `${wb[0]}`);
  // also: offset != uploaded is RANGE in UPLOADING
  const wb2 = rpc(card, 0x20, [...u16(handle), ...u32(512), ...u16(4), 0x00]);
  rpcStatus(wb2) === ERR.RANGE ? ok('gap write (offset!=uploaded) -> RANGE') : bad('gap write', `${wb2[0]}`);
}

// --- OBJECT_ENUM walk + NO_HANDLES boundary handled by allocator ---
{
  const card = new UgCard();
  rpc(card, 0x10, [0, ...u32(16)]); rpc(card, 0x10, [0, ...u32(16)]);
  const e1 = rpc(card, 0x15, [0, 0]);
  const e2 = rpc(card, 0x15, [le32s(e1, 2) & 0xFF, 0]);
  const e3 = rpc(card, 0x15, [le32s(e2, 2) & 0xFF, 0]);
  const n3 = le32s(e3, 2) & 0xFFFF;
  e1[0] === 0 && n3 === 0 ? ok('object_enum iteration ends with 0') : bad('enum', `${JSON.stringify(e3)}`);
}

// --- SNAP_LATCH + SNAP_DATA indexed read ---
{
  const card = new UgCard();
  wr(card, 0x02, XC.SNAP_LATCH);
  wr(card, 0x04, 4);
  const b0 = rd(card, 0x05), b1 = rd(card, 0x05);
  wr(card, 0x04, 0x81);                                          // >128 -> RANGE
  const rErr = card.xerr === ERR.RANGE;
  // session_id = 0x0123456789ABCDEF little-endian at bytes 4..11
  b0 === 0xEF && b1 === 0xCD && rErr ? ok('snap_index/snap_data + RANGE on >=64')
    : bad('snapshot regs', `b0=${b0.toString(16)} b1=${b1.toString(16)} xerr=${card.xerr}`);
}

// --- write to read-only register -> BAD_REGISTER ---
{
  const card = new UgCard();
  wr(card, 0x01, 0x00);                                          // X_STATUS is read-only
  wr(card, 0x08, 0x00);                                          // API_MAJOR read-only
  card.xerr === ERR.BAD_REGISTER ? ok('write read-only regs -> BAD_REGISTER')
    : bad('bad_register', `xerr=${card.xerr}`);
}

mkdirSync(join(BUILD, 'logs'), { recursive: true });
writeFileSync(join(BUILD, 'logs', 'ug-card-tests.json'), JSON.stringify({ pass, fail, results }, null, 2));
console.log(`UG-CARD-TESTS ${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
