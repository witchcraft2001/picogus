// SPDX-License-Identifier: GPL-2.0-or-later
// Independent port-level acceptance probes: literals come from spec 5-8,
// not from schema-generated constants or the model's ERR values.
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
const root = resolve(process.argv[2] || '.');
const out = resolve(process.argv[3] || 'build/ultrags/evidence/S0b/model-extra');
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const Card = require(join(root, 'tests/ultrags/dss/ug-card.js'));
const results = [];
const assert = (v, why) => { if (!v) throw Error(why); };
const u16 = n => [n & 255, (n >>> 8) & 255];
const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
function rpc(c, op, p = []) {
  for (const b of [op, p.length, ...p]) c.writePort(0x2a3, b);
  assert(c.frame.st === 'REPLY', 'request did not prepare a reply');
  const bytes = [];
  while (c.frame.st === 'REPLY') bytes.push(c.readPort(0x2a3));
  return bytes;
}
const alloc = (c, size) => { const r = rpc(c, 0x10, [0, ...u32(size)]); assert(r[0] === 0, `ALLOC status ${r[0]}`); return r[2] | (r[3] << 8); };
const begin = (c, h, n, off = 0, read = false) => rpc(c, read ? 0x22 : 0x20, [...u16(h), ...u32(off), ...u16(n), 0]);
const token = r => r.slice(2, 6);
function upload(c, h, bytes) { const r = begin(c, h, bytes.length); assert(r[0] === 0, 'WRITE_BEGIN failed'); for (const b of bytes) c.writePort(0x2a0, b); assert(rpc(c, 0x21, token(r))[0] === 0, 'WRITE_END failed'); }
function test(name, fn) { try { fn(new Card()); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, defect: e.message }); } }
test('u32 allocation cannot wrap aligned reservation', c => {
  const r = rpc(c, 0x10, [0, ...u32(0xffffffff)]);
  assert(r[0] === 9 && c.objects.size === 0, `expected NO_MEMORY/no object; status=${r[0]} objects=${c.objects.size}`);
});
test('WRITE bounded by requested object size', c => {
  const h = alloc(c, 1), r = begin(c, h, 2);
  assert(r[0] === 8 && !c.transfer, `expected RANGE/no grant; status=${r[0]}`);
});
test('UPLOADING BLOB permits prefix rewrite', c => {
  const h = alloc(c, 4); upload(c, h, [1, 2, 3, 4]);
  const r = begin(c, h, 1, 0);
  assert(r[0] === 0, `expected prefix rewrite grant; status=${r[0]}`);
});
test('READY BLOB is immutable', c => {
  const h = alloc(c, 4); upload(c, h, [1, 2, 3, 4]);
  assert(rpc(c, 0x13, [...u16(h), 0, ...u32(0)])[0] === 0, 'SEAL failed');
  const r = begin(c, h, 1, 0);
  assert(r[0] === 6 && !c.transfer, `expected STATE/no grant; status=${r[0]}`);
});
test('CRC error response retains requested CRC trailer', c => {
  for (const b of [0x80, 0, 0, 0, 0, 0]) c.writePort(0x2a3, b);
  const r = []; while (c.frame.st === 'REPLY') r.push(c.readPort(0x2a3));
  assert(r[0] === 4 && r[1] === 0 && r.length === 6, `expected CRC error frame6; bytes=${r}`);
});
test('extra READ byte invalidates END', c => {
  const h = alloc(c, 1); upload(c, h, [42]); const r = begin(c, h, 1, 0, true);
  assert(c.readPort(0x2a0) === 42, 'readback mismatch'); c.readPort(0x2a0);
  const end = rpc(c, 0x23, token(r));
  assert(end[0] === 14 && !c.transfer, `expected OVERFLOW/release; status=${end[0]}`);
});
test('TRANSPORT_RESET clears framing error', c => {
  c.writePort(0x2a3, 0); c.writePort(0x2a3, 129);
  c.writePort(0x2a2, 0xa0);
  assert(c.frame.st === 'IDLE' && c.xerr === 0, `expected IDLE/X_ERROR0; ${c.frame.st}/${c.xerr}`);
});
test('empty INFO request enforces payload length', c => {
  const r = rpc(c, 0, [0]); assert(r[0] === 3, `expected LENGTH; status=${r[0]}`);
});
test('EXT response errors update sticky X_ERROR', c => {
  assert(rpc(c, 0x7f)[0] === 1, 'unknown opcode must answer BAD_OPCODE');
  assert(c.readPort(0x2a6) === 1, 'BAD_OPCODE must be recorded in X_ERROR');
  assert(rpc(c, 0)[0] === 0 && c.readPort(0x2a6) === 1, 'successful INFO must preserve sticky error');
});
test('early READ data is STATE without accounting', c => {
  const h = alloc(c, 1); upload(c, h, [42]);
  for (const b of [0x22, 9, ...u16(h), ...u32(0), ...u16(1), 0]) c.writePort(0x2a3, b);
  assert(c.readPort(0x2a0) === 255 && c.xerr === 6 && c.transfer.idx === 0, 'early READ must be FF/STATE, not UNDERFLOW or consumed data');
});
test('READ without any transfer is FF UNDERFLOW', c => {
  assert(c.readPort(0x2a0) === 255 && c.readPort(0x2a6) === 15, 'absence of data is UNDERFLOW; distinct from early READ STATE');
});
function gsReadGrant(c) {
  const h = alloc(c, 1); upload(c, h, [42]);
  const r = rpc(c, 0x22, [...u16(h), ...u32(0), ...u16(1), 1]);
  assert(r[0] === 0, 'GS READ_BEGIN precondition failed'); return r;
}
test('GS prefetch is not a consumed data byte', c => {
  const r = gsReadGrant(c); c.tickUs(0);
  assert(rpc(c, 0x23, token(r))[0] === 16 && !c.transfer, 'END without GD must be SHORT_TRANSFER despite a prepared OUT latch');
});
test('GS prefetch cannot refresh grant inactivity timer', c => {
  gsReadGrant(c); c.tickUs(4_900_000); c.tickUs(100_001);
  assert(!c.transfer && c.xerr === 13, 'grant must expire at5s without GD; publishing OUT is not valid data access');
});
test('10-bit ISA decode mirrors upper address bits', c => {
  assert(c.readPort(0x6a8) === 1, 'C6A8 must mirror API_MAJOR at C2A8');
});
test('transfer token exhaustion never returns zero/wrap', c => {
  const h = alloc(c, 1); c.nextTransferId = 0x100000000;
  const r = begin(c, h, 1);
  assert(r[0] !== 0 && !c.transfer, `expected refusal before wrap; status=${r[0]} token=${token(r)}`);
});
test('OBJECT_INFO whitelist restricted to active object', c => {
  const h = alloc(c, 1), other = alloc(c, 1); begin(c, h, 1);
  assert(rpc(c, 0x12, u16(other))[0] === 5, 'foreign OBJECT_INFO must be BUSY during transfer');
});
test('transfer pin is observable and released on cancel', c => {
  const h = alloc(c, 1); begin(c, h, 1);
  const active = rpc(c, 0x12, u16(h));
  assert((active[6] | (active[7] << 8)) >= 1, 'OBJECT_INFO must report the active transfer pin');
  c.writePort(0x2a2, 0xa1);
  const ended = rpc(c, 0x12, u16(h));
  assert((ended[6] | (ended[7] << 8)) === 0, 'cancel must release transfer pin');
});
test('BEGIN reply advertises grant before data eligibility', c => {
  const h = alloc(c, 1);
  for (const b of [0x20, 9, ...u16(h), ...u32(0), ...u16(1), 0]) c.writePort(0x2a3, b);
  assert((c.readPort(0x2a1) & 8) !== 0, 'prepared BEGIN response must advertise WRITE_GRANT');
  c.writePort(0x2a0, 99);
  assert(c.xerr === 6 && c.transfer.got === 0, 'early data must be STATE and not counted');
});
test('PREPARING has BUSY without premature GRANT', c => {
  const h = alloc(c, 1); c.execDelayUs = 1000;
  for (const b of [0x20, 9, ...u16(h), ...u32(0), ...u16(1), 0]) c.writePort(0x2a3, b);
  const before = c.readPort(0x2a1);
  assert((before & 2) !== 0 && (before & (8 | 16 | 4)) === 0, 'EXEC/PREPARING must not advertise grant/reply');
  c.tickUs(1000);
  assert((c.readPort(0x2a1) & (4 | 8)) === (4 | 8), 'prepared reply must advertise grant');
});
test('GS OUT latch preserves last consumed response', c => {
  c.gserr = 7; c.writePort(0x2bb, 0xf0);
  assert(c.readPort(0x2b3) === 7 && c.readPort(0x2b3) === 7, 'F0 last byte must remain rereadable');
});
test('BULK completion preserves independent GS response latch', c => {
  const h = alloc(c, 1); c.gserr = 7; c.writePort(0x2bb, 0xf0);
  const r = begin(c, h, 1); c.writePort(0x2a0, 42); rpc(c, 0x21, token(r));
  assert((c.readPort(0x2bb) & 0x80) !== 0 && c.readPort(0x2b3) === 7, 'BULK END must preserve GS DB/result');
});
test('legacy LOAD preliminary u8 is independent of EXT0100', c => {
  c.nextHandle = 0x100; c.handlesIssued = 255;
  c.writePort(0x2bb, 0x38);
  const legacy = c.readPort(0x2b3), info = rpc(c, 0x16);
  assert(legacy !== 0 && info[6] === 0 && info[7] === 1, `legacy=${legacy}, LEGACY_INFO=${info}`);
  assert(c.gs.state === 'LOAD', `preliminary latch consumption must preserve LOAD, got ${c.gs.state}`);
});
test('legacy LOAD packet rejects SD and D2 without mutation', c => {
  c.writePort(0x2bb, 0x38); c.readPort(0x2b3);
  assert(c.gs.state === 'LOAD', 'LOAD must stay active after preliminary latch read');
  const info = rpc(c, 0x16), h = info[6] | (info[7] << 8);
  const r = begin(c, h, 1); assert(r[0] === 0, 'pending LOAD must allow BULK BEGIN');
  c.writePort(0x2b3, 99); c.writePort(0x2bb, 0xd2);
  assert(c.gs.state === 'LOAD' && c.transfer && c.transfer.got === 0 && c.gs.loadObj.uploaded === 0, 'SD/D2 must preserve LOAD/packet/prefix');
  assert(c.gserr !== 0, 'SD/D2 must diagnose BUSY');
});
test('legacy LOAD aligned shrink does not overlap free extent', c => {
  c.writePort(0x2bb, 0x38); c.readPort(0x2b3);
  assert(c.gs.state === 'LOAD', 'LOAD precondition');
  c.writePort(0x2b3, 42); c.tickUs(0); c.writePort(0x2bb, 0xd2); c.tickUs(0);
  const info = rpc(c, 0x16), h = info[4] | (info[5] << 8), obj = c.objects.get(h);
  assert(obj && obj.reserved === 16 && obj.size === 1, 'RAW LOAD must publish aligned one-byte object');
  assert(c.freeList.every(e => e.off + e.size <= obj.dataOff || e.off >= obj.dataOff + 16), 'free extent overlaps reserved bytes');
});
test('GS warm reset clears store and changes session', c => {
  alloc(c, 1); const before = c.session; c.writePort(0x2bb, 0xf3); c.tickUs(0);
  assert(c.objects.size === 0 && c.session !== before && !c.transfer && !c.gs.loadObj, 'F3 must reset entire store/session');
});
test('CAPS excludes unimplemented musical and parser capabilities', c => {
  const r = rpc(c, 1), f = r[2] | (r[3] << 8) | (r[4] << 16) | (r[5] << 24);
  const formats = r[6] | (r[7] << 8) | (r[8] << 16) | (r[9] << 24);
  assert((f & (1 | 16 | 128 | 256 | 1024)) === 0 && formats === 0, `unsupported CAPS features=${f.toString(16)} formats=${formats.toString(16)}`);
});
test('SNAP_DATA reaches128 and reports underflow without wrapping', c => {
  c.writePort(0x2a2, 0xa3);
  for (let i = 0; i < 128; i++) c.readPort(0x2a5);
  assert(c.readPort(0x2a4) === 128, 'snapshot index must stop at128');
  assert(c.readPort(0x2a5) === 255 && c.xerr === 15 && c.readPort(0x2a4) === 128, 'past-end SNAP_DATA must be FF/UNDERFLOW, stable index');
});
test('SNAP_INDEX write128 is RANGE and preserves prior index', c => {
  c.writePort(0x2a4, 17); c.writePort(0x2a4, 128);
  assert(c.readPort(0x2a4) === 17 && c.readPort(0x2a6) === 8, 'writable snapshot index is0..127; internal end sentinel128 is not writable');
});
test('idle SNAPSHOT contains no fabricated output frames and increments seq', c => {
  alloc(c, 1); const r = rpc(c, 0x50), next = rpc(c, 0x50);
  assert(r.slice(14, 22).every(b => b === 0), 'output_frames must be zero without I2S, not object count');
  assert(r[29] === 255, 'playlist_index must be FF outside playlist');
  const seq = b => b[2] + b[3] * 256 + b[4] * 65536 + b[5] * 16777216;
  assert(seq(next) > seq(r), 'snapshot_seq must advance');
});
test('STATS counters saturate at FFFFFFFF', c => {
  c.stats.isaReads = 0xffffffff; c.readPort(0x2a1);
  const r = rpc(c, 3);
  assert(r.slice(2, 6).every(b => b === 255), 'isa_reads must saturate instead of wrapping to zero');
});
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.defect ? ': ' + r.defect : ''}`);
process.exit(results.every(r => r.pass) ? 0 : 1);
