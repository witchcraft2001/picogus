#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// gen-wire.mjs - Ultra GS wire schema validator + C/ASM equate generator.
// Input : tools/ultrags/wire-schema.json  (handwritten, tracked)
// Output: <build>/gen/ug_wire.h, ug_wire.inc, ug_wire.norm.json
// Usage : node tools/ultrags/gen-wire.mjs <schema.json> <outdir>
// Exits non-zero with a diagnostic on any schema defect.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const [schemaPath, outDir] = process.argv.slice(2);
if (!schemaPath || !outDir) {
  console.error('usage: gen-wire.mjs <wire-schema.json> <outdir>');
  process.exit(2);
}

const problems = [];
const fail = (msg) => problems.push(msg);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
// Cached layout fields are generator-owned, never trusted as schema input.
function rejectDerived(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('_')) fail(`reserved derived key ${key} in input schema`);
    rejectDerived(child);
  }
}
rejectDerived(schema);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

const TYPE_SIZES = { u8: 1, u16: 2, u24le: 3, u32: 4, u64: 8 };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// strict numeric: JSON number (must be integral) or 0x-hex / decimal string.
// Rejects NaN, fractions, partial parses ("0x10junk"), and out-of-range values.
const num = (v, ctx, lo, hi) => {
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) n = parseInt(v, 16);
  else if (typeof v === 'string' && /^[0-9]+$/.test(v)) n = parseInt(v, 10);
  else { fail(`${ctx}: bad numeric value ${JSON.stringify(v)}`); return 0; }
  if (!Number.isInteger(n)) { fail(`${ctx}: non-integer value ${JSON.stringify(v)}`); return 0; }
  if (lo !== undefined && (n < lo || n > hi)) {
    fail(`${ctx}: value ${n} out of range ${lo}..${hi}`);
  }
  return n;
};

// strict field type grammar; anything outside this grammar is a schema error
function parseFieldType(t, ctx) {
  if (typeof t !== 'string') { fail(`${ctx}: non-string type ${JSON.stringify(t)}`); return null; }
  if (TYPE_SIZES[t]) return { kind: 'scalar', size: TYPE_SIZES[t] };
  let m;
  if ((m = t.match(/^bytes:([1-9][0-9]*)$/))) return { kind: 'bytes', size: +m[1] };
  if ((m = t.match(/^struct:([A-Za-z_][A-Za-z0-9_]*)$/))) return { kind: 'struct', name: m[1] };
  if ((m = t.match(/^array:([1-9][0-9]*):([A-Za-z_][A-Za-z0-9_]*)$/)))
    return { kind: 'array', n: +m[1], name: m[2] };
  if ((m = t.match(/^varray:([A-Za-z_][A-Za-z0-9_]*)$/))) return { kind: 'varray', name: m[1] };
  fail(`${ctx}: unknown/ill-formed type ${JSON.stringify(t)}`);
  return null;
}

// ---------- validation helpers ----------
const seenNames = new Set();
function uniq(name, ctx) {
  if (seenNames.has(name)) fail(`${ctx}: duplicate name ${name}`);
  seenNames.add(name);
}

function fieldSize(f, ctx) {
  const pt = parseFieldType(f.type, `${ctx}.${f.name}`);
  if (!pt) return 0;
  switch (pt.kind) {
    case 'scalar': case 'bytes': return pt.size;
    case 'struct': return ctx.structSize(pt.name);
    case 'array': return pt.n * ctx.structSize(pt.name);
    case 'varray': return 0; // variable; handled by caller
  }
  return 0;
}

// declared `const` domain check: scalar const must be an integer that fits the
// field width; bytes:N const must be an ASCII string of exactly N chars;
// const on composite/varray fields is meaningless.
function fieldConstCheck(f, ctx) {
  if (f.const === undefined) return;
  const pt = parseFieldType(f.type, `${ctx}.${f.name}`);
  if (!pt) return;
  const width = { u8: 8, u16: 16, u24le: 24, u32: 32, u64: 64 }[f.type];
  if (width) {
    const v = num(f.const, `${ctx}.${f.name}.const`);
    if (Number.isInteger(v) && (v < 0 || v >= 2 ** Math.min(width, 53)))
      fail(`${ctx}.${f.name}: const ${v} does not fit ${f.type}`);
  } else if (pt.kind === 'bytes') {
    if (typeof f.const !== 'string' || f.const.length !== pt.size || !/^[\x00-\x7F]*$/.test(f.const))
      fail(`${ctx}.${f.name}: bytes:${pt.size} const must be ${pt.size}-char string, got ${JSON.stringify(f.const)}`);
  } else {
    fail(`${ctx}.${f.name}: const not allowed on type ${f.type}`);
  }
}

function structSize(name, visiting = new Set()) {
  const st = schema.structs[name];
  if (!st) { fail(`struct ${name}: referenced but not defined`); return 0; }
  if (st._size !== undefined) return st._size;
  if (visiting.has(name)) { fail(`struct ${name}: recursive reference`); return 0; }
  visiting.add(name);
  let off = 0;
  for (const f of st.fields || []) {
    f._off = off;
    if (f.off !== undefined && f.off !== off)
      fail(`struct ${name}.${f.name}: declared off ${f.off} != computed ${off}`);
    const sz = fieldSize(f, { structSize: (s) => structSize(s, visiting) });
    off += sz;
    f._size = sz;
  }
  st._vsize = off; // full size incl. trailing verifiedOnly fields
  st._size = off - (st.fields || []).reduce((a, f) => a + (f.verifiedOnly ? f._size : 0), 0);
  st._hasVarray = (st.fields || []).some((f) => String(f.type).startsWith('varray:'));
  return off;
}

// ---------- validate ----------
if (schema.meta?.name !== 'ultrags-wire') fail('meta.name must be ultrags-wire');
if (schema.meta?.endianness !== 'le') fail('meta.endianness must be le');

// limits / modes / scalar groups: u32 domain, integral values
for (const grp of ['limits', 'modes']) {
  for (const [k, v] of Object.entries(schema[grp] || {})) {
    uniq(`UG_${k}`, grp);
    num(v.value, `${grp}.${k}`, 0, 0xFFFFFFFF);
  }
}
// bit tables
for (const [k, v] of Object.entries(schema.xStatus || {})) {
  uniq(`UG_XS_${k}`, 'xStatus');
  num(v.bit, `xStatus.${k}.bit`, 0, 7);
}
const xsBits = Object.values(schema.xStatus).map((v) => v.bit);
if (new Set(xsBits).size !== xsBits.length) fail('xStatus: duplicate bit');
{
  const vals = new Set();
  for (const [k, v] of Object.entries(schema.xControl || {})) {
    uniq(`UG_XC_${k}`, 'xControl');
    const n = num(v.value, `xControl.${k}`, 0, 0xFF);
    if (vals.has(n)) fail(`xControl.${k}: duplicate value ${n}`);
    vals.add(n);
  }
}
{
  const vals = new Set();
  for (const [k, v] of Object.entries(schema.transport || {})) {
    uniq(`UG_TRANSPORT_${k}`, 'transport');
    const n = num(v.value, `transport.${k}`, 0, 0xFF);
    if (vals.has(n)) fail(`transport.${k}: duplicate value ${n}`);
    vals.add(n);
  }
}

// errors
{
  const vals = new Set();
  for (const e of schema.errors || []) {
    const v = num(e.value, `errors.${e.name}`, 0, 0x7F);
    uniq(`UG_ERR_${e.name}`, 'errors');
    if (vals.has(v)) fail(`errors.${e.name}: duplicate value ${v}`);
    vals.add(v);
  }
}

// object kinds/states: u8 domain, unique names AND unique values
for (const [grp, pfx] of [['kinds', 'UG_KIND_'], ['states', 'UG_STATE_']]) {
  const vals = new Set();
  for (const e of schema.objects?.[grp] || []) {
    uniq(`${pfx}${e.name}`, `objects.${grp}`);
    const v = num(e.value, `objects.${grp}.${e.name}`, 0, 0xFF);
    if (vals.has(v)) fail(`objects.${grp}.${e.name}: duplicate value ${v}`);
    vals.add(v);
  }
}

// registers: every offset 0..31 covered exactly once; known read/write domains
{
  const REG_R = new Set(['bulk_byte', 'status', 'zero', 'response_byte', 'index',
    'snap_byte', 'xerror', 'gserror', 'const', 'gs_data_out', 'gs_status']);
  const REG_W = new Set(['bulk_byte', 'control', 'request_byte', 'index',
    'bad_register', 'gs_data_in', 'gs_command']);
  const cover = new Array(32).fill(0);
  for (const r of schema.registers || []) {
    const lo = num(r.off, `registers.${r.name}`, 0, 0x1F);
    const hi = r.through !== undefined ? num(r.through, `registers.${r.name}`, 0, 0x1F) : lo;
    if (hi < lo) fail(`register ${r.name}: bad range ${r.off}..${r.through}`);
    for (let i = lo; i <= hi; i++) cover[i]++;
    uniq(`UG_REG_${r.name}`, 'registers');
    if (!REG_R.has(r.read)) fail(`register ${r.name}: unknown read kind ${JSON.stringify(r.read)}`);
    if (!REG_W.has(r.write)) fail(`register ${r.name}: unknown write kind ${JSON.stringify(r.write)}`);
  }
  const misses = cover.map((c, i) => (c === 0 ? i : -1)).filter((i) => i >= 0);
  const dup = cover.map((c, i) => (c > 1 ? i : -1)).filter((i) => i >= 0);
  if (misses.length) fail(`registers: uncovered offsets ${misses.map((i) => i.toString(16)).join(',')}`);
  if (dup.length) fail(`registers: overlapping offsets ${dup.map((i) => i.toString(16)).join(',')}`);
}

// config ports: u16 port addresses / u8 values; selectors u8 + unique values
{
  const PORT_KEYS = new Set(['CONTROL', 'DATA_LOW', 'DATA_HIGH']);
  const selVals = new Map();
  for (const [k, v] of Object.entries(schema.configPorts || {})) {
    if (k === 'selectors') {
      for (const [s, sv] of Object.entries(v)) {
        uniq(`UG_CFG_SEL_${s}`, 'configPorts.selectors');
        const n = num(sv.value, `configPorts.selectors.${s}`, 0, 0xFF);
        if (selVals.has(n)) fail(`configPorts.selectors.${s}: duplicate selector value ${n} (also ${selVals.get(n)})`);
        selVals.set(n, s);
      }
    } else {
      uniq(`UG_CFG_${k}`, 'configPorts');
      num(v.value, `configPorts.${k}`, 0, PORT_KEYS.has(k) ? 0xFFFF : 0xFF);
    }
  }
}

// structs
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
// verifiedOnly fields are legal only as the single trailing suffix of these
// three structs, and only under the name the spec assigns them.
const VERIFIED_FIELD = { STREAM_FEED_REQ: 'crc', WRITE_BEGIN_REQ: 'crc', READ_BEGIN_RESP: 'crc', READ_END_REQ: 'host_crc' };
for (const [name, st] of Object.entries(schema.structs || {})) {
  if (!NAME_RE.test(name)) fail(`struct ${JSON.stringify(name)}: name must be UPPER_SNAKE`);
  uniq(`UG_${name}`, 'structs');
  if (st.size !== undefined) num(st.size, `struct ${name}.size`, 0, 4096);
  const size = structSize(name);
  if (st._hasVarray) {
    if (st.size !== st._size) fail(`struct ${name}: declared size ${st.size} != computed prefix ${st._size}`);
  } else if (st.size !== st._size) {
    fail(`struct ${name}: declared size ${st.size} != computed ${st._size}`);
  }
  if (size > 128 && !['SNAPSHOT', 'FW_CATALOG'].includes(name))
    fail(`struct ${name}: fixed size ${size} exceeds frame payload`);
  const fname = new Set();
  const fields = st.fields || [];
  let seenVerified = false;
  fields.forEach((f, fi) => {
    if (typeof f.name !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(f.name))
      fail(`struct ${name}: ill-formed field name ${JSON.stringify(f.name)}`);
    if (fname.has(f.name)) fail(`struct ${name}: duplicate field ${f.name}`);
    fname.add(f.name);
    if (f.off !== undefined) num(f.off, `struct ${name}.${f.name}.off`, 0, 4095);
    if (f.min !== undefined) num(f.min, `struct ${name}.${f.name}.min`, 0, 0xFF);
    if (f.max !== undefined) num(f.max, `struct ${name}.${f.name}.max`, 0, 0xFF);
    fieldConstCheck(f, `struct ${name}`);
    if (f.verifiedOnly) {
      if (typeof f.verifiedOnly !== 'boolean') fail(`struct ${name}.${f.name}: verifiedOnly not boolean`);
      seenVerified = true;
      if (!VERIFIED_FIELD[name])
        fail(`struct ${name}.${f.name}: verified field in struct without a VERIFIED layout`);
      else if (f.name !== VERIFIED_FIELD[name])
        fail(`struct ${name}.${f.name}: verified suffix field must be named ${VERIFIED_FIELD[name]}`);
      else if (fi !== fields.length - 1)
        fail(`struct ${name}.${f.name}: verified field must be the trailing last field`);
    } else if (seenVerified)
      fail(`struct ${name}.${f.name}: verified fields must form a trailing block`);
  });
}

// opcodes: u7 command space; request/response must use exactly one layout form
{
  const vals = new Set();
  for (const op of schema.opcodes || []) {
    const v = num(op.hex, `opcodes.${op.name}`, 0, 0x7F);
    uniq(`UG_OP_${op.name}`, 'opcodes');
    if (vals.has(v)) fail(`opcode ${op.name}: duplicate hex ${op.hex}`);
    vals.add(v);
    if (op.req && op.reqStruct) fail(`opcode ${op.name}: both req and reqStruct`);
    if (op.resp && op.respStruct) fail(`opcode ${op.name}: both resp and respStruct`);
    const reqLen = op.req ? payloadLen(op.req, `opcode ${op.name} req`) :
      op.reqStruct ? (schema.structs[op.reqStruct] ? structSize(op.reqStruct)
        : fail(`opcode ${op.name}: missing reqStruct ${op.reqStruct}`) || 0) : 0;
    if (reqLen > 128) fail(`opcode ${op.name}: req payload ${reqLen} > 128`);
    if (op.respStruct && !schema.structs[op.respStruct]) fail(`opcode ${op.name}: missing respStruct ${op.respStruct}`);
    if (op.resp) payloadLen(op.resp, `opcode ${op.name} resp`);
    if (op.transferOk !== undefined && typeof op.transferOk !== 'boolean')
      fail(`opcode ${op.name}: transferOk not boolean`);
    if (op.transferCmd !== undefined && typeof op.transferCmd !== 'boolean')
      fail(`opcode ${op.name}: transferCmd not boolean`);
  }
}
function payloadLen(fields, ctx) {
  let n = 0;
  for (const f of fields) {
    if (typeof f.name !== 'string' || typeof f.type !== 'string')
      fail(`${ctx}: ill-formed field ${JSON.stringify(f)}`);
    const sz = fieldSize(f, { structSize: (s) => structSize(s) });
    f._size = sz;
    f._off = n;
    n += sz;
    fieldConstCheck(f, ctx);
  }
  if (n > 128) fail(`${ctx}: payload ${n} > 128`);
  return n;
}

// gs commands: u8 opcodes; `range` must parse and must not overlap other entries
{
  const vals = new Set();
  const covered = new Map();
  for (const g of schema.gsCommands || []) {
    const v = num(g.hex, `gsCommands.${g.name}`, 0, 0xFF);
    uniq(`UG_GS_${g.name}`, 'gsCommands');
    if (vals.has(v)) fail(`gs ${g.name}: duplicate hex ${g.hex}`);
    vals.add(v);
    for (const k of ['pre', 'post', 'out'])
      if (g[k] !== undefined) num(g[k], `gs ${g.name}.${k}`, -1, 0xFF);
    // hex itself plus any declared range must be uniquely owned
    const span = [v];
    if (g.range !== undefined) {
      const m = String(g.range).match(/^0x([0-9a-fA-F]+)-0x([0-9a-fA-F]+)$/);
      if (!m) fail(`gs ${g.name}: bad range grammar ${JSON.stringify(g.range)}`);
      else {
        const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
        if (lo !== v || hi < lo || hi > 0xFF) fail(`gs ${g.name}: bad range ${g.range}`);
        for (let i = lo; i <= hi; i++) span.push(i);
      }
    }
    for (const c of new Set(span)) {
      if (covered.has(c)) fail(`gs ${g.name}: hex/range 0x${c.toString(16)} overlaps ${covered.get(c)}`);
      covered.set(c, g.name);
    }
  }
}

// crc parameters: strict u32 integers (no fractions, no >32-bit, no strings
// that partially parse). Validated HERE so failures hit the gate before emit.
for (const k of ['poly', 'init', 'xorout'])
  num(schema.crc?.[k], `crc.${k}`, 0, 0xFFFFFFFF);
// refin/refout are booleans and ISO-HDLC requires both reflected-true;
// a string like "true" or a missing/false value is a schema defect.
if (schema.crc?.refin !== true)
  fail(`crc.refin: must be boolean true (ISO-HDLC reflected input), got ${JSON.stringify(schema.crc?.refin)}`);
if (schema.crc?.refout !== true)
  fail(`crc.refout: must be boolean true (ISO-HDLC reflected output), got ${JSON.stringify(schema.crc?.refout)}`);

if (problems.length) {
  console.error(`wire-schema validation FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// ---------- emit helpers ----------
const cnum = (v) => (typeof v === 'number' ? (v > 9 ? '0x' + v.toString(16).toUpperCase() : String(v)) : v);

const H = [];
H.push('/* SPDX-License-Identifier: GPL-2.0-or-later');
H.push(' * Auto-generated by tools/ultrags/gen-wire.mjs from tools/ultrags/wire-schema.json');
H.push(' * Ultra GS EXT wire protocol per ultra-gs.md v' + schema.meta.specVersion + '. DO NOT EDIT. */');
H.push('#ifndef UG_WIRE_H', '#define UG_WIRE_H', '', '#include <stdint.h>', '');
H.push('#ifdef __cplusplus', '#define UG_STATIC_ASSERT static_assert',
       '#else', '#define UG_STATIC_ASSERT _Static_assert', '#endif', '');

const I = [];
I.push('; SPDX-License-Identifier: GPL-2.0-or-later');
I.push('; Auto-generated by tools/ultrags/gen-wire.mjs from tools/ultrags/wire-schema.json');
I.push('; Ultra GS EXT wire protocol per ultra-gs.md v' + schema.meta.specVersion + '. DO NOT EDIT.');
I.push('; sjasmplus include guards require DEFINE (EQU labels are not visible to IFNDEF).');
I.push('');
I.push('\tIFNDEF UG_WIRE_INC');
I.push('\tDEFINE UG_WIRE_INC');
I.push('');

// Every emitted symbol name is checked for collisions across BOTH outputs:
// a duplicate define/EQU must be a hard generator error, not a silent
// redefinition that only the C consumer happens to trip over.
const emitted = new Set();

function emitBoth(name, value) {
  if (emitted.has(name)) {
    console.error(`gen-wire: emitted symbol collision: ${name}`);
    process.exit(1);
  }
  emitted.add(name);
  H.push(`#define ${name} ${cnum(value)}`);
  I.push(`${name}\tEQU ${typeof value === 'number' ? '0x' + value.toString(16).toUpperCase() : value}`);
}

H.push('/* limits */'); I.push('; ---- limits ----');
for (const [k, v] of Object.entries(schema.limits)) { emitBoth(`UG_${k}`, num(v.value)); }
H.push(''); H.push('/* mode/api */'); I.push(''); I.push('; ---- mode/api ----');
for (const [k, v] of Object.entries(schema.modes)) { emitBoth(`UG_${k}`, num(v.value)); }

H.push(''); H.push('/* X_STATUS bit masks */'); I.push(''); I.push('; ---- X_STATUS masks ----');
for (const [k, v] of Object.entries(schema.xStatus)) { emitBoth(`UG_XS_${k}`, 1 << v.bit); }
H.push(''); H.push('/* X_CONTROL values */'); I.push(''); I.push('; ---- X_CONTROL ----');
for (const [k, v] of Object.entries(schema.xControl)) { emitBoth(`UG_XC_${k}`, num(v.value)); }
H.push(''); H.push('/* transport field values */'); I.push(''); I.push('; ---- transport ----');
for (const [k, v] of Object.entries(schema.transport)) { emitBoth(`UG_TRANSPORT_${k}`, num(v.value)); }
H.push(''); H.push('/* error/status codes (response byte 0, X_ERROR, GS_ERROR mapping) */'); I.push(''); I.push('; ---- errors ----');
for (const e of schema.errors) emitBoth(`UG_ERR_${e.name}`, num(e.value));
H.push(''); H.push('/* object kinds / states */'); I.push(''); I.push('; ---- objects ----');
for (const e of schema.objects.kinds) emitBoth(`UG_KIND_${e.name}`, e.value);
for (const e of schema.objects.states) emitBoth(`UG_STATE_${e.name}`, e.value);
H.push(''); H.push('/* register offsets within BASE window */'); I.push(''); I.push('; ---- registers ----');
for (const r of schema.registers) emitBoth(`UG_REG_${r.name}`, num(r.off));
H.push(''); H.push('/* config ports/selectors (shared PicoGUS protocol4) */'); I.push(''); I.push('; ---- config ports ----');
for (const [k, v] of Object.entries(schema.configPorts)) {
  if (k === 'selectors') continue;
  emitBoth(`UG_CFG_${k}`, num(v.value));
}
I.push('; ---- config selectors ----');
for (const [k, v] of Object.entries(schema.configPorts.selectors)) emitBoth(`UG_CFG_SEL_${k}`, num(v.value));
H.push(''); H.push('/* EXT opcodes */'); I.push(''); I.push('; ---- opcodes ----');
for (const op of schema.opcodes) emitBoth(`UG_OP_${op.name}`, num(op.hex));
H.push(''); H.push('/* GS (legacy profile) commands */'); I.push(''); I.push('; ---- GS commands ----');
for (const g of schema.gsCommands) emitBoth(`UG_GS_${g.name}`, num(g.hex));
H.push(''); H.push('/* CRC-32/ISO-HDLC parameters */'); I.push(''); I.push('; ---- CRC ----');
emitBoth('UG_CRC_POLY', num(schema.crc.poly));
emitBoth('UG_CRC_INIT', num(schema.crc.init));
emitBoth('UG_CRC_XOROUT', num(schema.crc.xorout));
emitBoth('UG_FRAME_CRC_BIT', 0x80);
emitBoth('UG_MAX_FRAME', schema.limits.MAX_PAYLOAD.value + 2 + 4);

// per-opcode normalized request/response payload lengths (opcode-specific;
// a VERIFIED-only field extends exactly the opcode/direction the spec allows)
H.push(''); H.push('/* per-opcode payload lengths: _LEN=FAST, _VLEN=VERIFIED */');
I.push(''); I.push('; ---- per-opcode payload lengths (_LEN=FAST, _VLEN=VERIFIED) ----');
for (const op of schema.opcodes) {
  const reqSt = op.reqStruct ? schema.structs[op.reqStruct] : null;
  const respSt = op.respStruct ? schema.structs[op.respStruct] : null;
  const reqLen = reqSt ? reqSt._size : (op.req || []).reduce((a, f) => a + f._size, 0);
  const reqVLen = reqSt ? reqSt._vsize
    : reqLen + (op.req || []).reduce((a, f) => a + (f.verifiedOnly ? f._size : 0), 0);
  const respLen = respSt ? respSt._size : (op.resp || []).reduce((a, f) => a + f._size, 0);
  const respVLen = respSt ? respSt._vsize
    : respLen + (op.resp || []).reduce((a, f) => a + (f.verifiedOnly ? f._size : 0), 0);
  emitBoth(`UG_OP_${op.name}_REQ_LEN`, reqLen);
  if (reqVLen !== reqLen) emitBoth(`UG_OP_${op.name}_REQ_VLEN`, reqVLen);
  emitBoth(`UG_OP_${op.name}_RESP_LEN`, respLen);
  if (respVLen !== respLen) emitBoth(`UG_OP_${op.name}_RESP_VLEN`, respVLen);
}

// struct offsets + typedefs
H.push(''); H.push('/* payload struct offsets/sizes (packed, LE) */'); H.push('#pragma pack(push,1)'); H.push('');
I.push(''); I.push('; ---- payload struct offsets/sizes ----');
const cType = { u8: 'uint8_t', u16: 'uint16_t', u24le: 'uint8_t', u32: 'uint32_t', u64: 'uint64_t' };
for (const [name, st] of Object.entries(schema.structs)) {
  const up = name.toUpperCase();
  emitBoth(`UG_${up}_LEN`, st._size);
  if (st._vsize !== st._size) emitBoth(`UG_${up}_VLEN`, st._vsize);
  H.push(`typedef struct {`);
  for (const f of st.fields || []) {
    const upf = f.name.toUpperCase();
    emitBoth(`UG_${up}_${upf}_OFF`, f._off);
    const t = f.type;
    let ct;
    if (cType[t]) ct = cType[t] + (t === 'u24le' ? '[3]' : '');
    else if (t.startsWith('bytes:')) ct = `uint8_t[${t.slice(6)}]`;
    else if (t.startsWith('struct:')) ct = `ug_${t.slice(7).toLowerCase()}_t`;
    else if (t.startsWith('array:')) {
      const [, n, s] = t.match(/^array:(\d+):(.+)$/);
      ct = `ug_${s.toLowerCase()}_t[${n}]`;
    } else if (t.startsWith('varray:')) {
      ct = `ug_${t.slice(7).toLowerCase()}_t[] /* variable */`;
    } else ct = 'uint8_t';
    H.push(`    ${ct.split('[')[0]} ${f.name}${ct.includes('[') ? ct.slice(ct.indexOf('[')) : ''};`);
  }
  H.push(`} ug_${name.toLowerCase()}_t;`);
  if (!st._hasVarray) H.push(`UG_STATIC_ASSERT(sizeof(ug_${name.toLowerCase()}_t) == ${st._vsize}, "ug_${name.toLowerCase()}_t size");`);
  H.push('');
}
H.push('#pragma pack(pop)');
H.push(''); H.push('#endif /* UG_WIRE_H */');
I.push('');
I.push('\tENDIF ; UG_WIRE_INC');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'ug_wire.h'), H.join('\n'));
writeFileSync(join(outDir, 'ug_wire.inc'), I.join('\n'));

// normalized echo: canonical sort+hash for drift tests
const norm = JSON.stringify(schema, Object.keys(schema).sort(), 2);
const sha = createHash('sha256').update(readFileSync(schemaPath)).digest('hex');
writeFileSync(join(outDir, 'ug_wire.norm.json'), JSON.stringify({ schemaSha256: sha, generated: 'gen-wire.mjs' }, null, 2) + '\n');

console.log(`gen-wire: schema OK (${seenNames.size} symbols, ${schema.opcodes.length} opcodes, ` +
  `${schema.gsCommands.length} gs cmds, ${Object.keys(schema.structs).length} structs) -> ${outDir}`);
