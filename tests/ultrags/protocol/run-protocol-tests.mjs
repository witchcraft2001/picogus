#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// run-protocol-tests.mjs - Ultra GS wire-schema milestone-1 test runner.
//  1. regenerates C/ASM equates via gen-wire.mjs (fresh)
//  2. mechanical vector reformat via vec2c.mjs
//  3. compiles+runs check-wire.c (compiled C consumer + handwritten vectors)
//  4. cross-checks vectors.json against schema (drift guard, JS-side)
//  5. negative schema-validation probes (generator must reject defects)
// Usage: node run-protocol-tests.mjs <repo_root> <build_dir>
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(process.argv[2] || '.');
const build = resolve(process.argv[3] || join(root, 'build/ultrags'));
const gen = join(build, 'gen');
const schemaPath = join(root, 'tools/ultrags/wire-schema.json');
const vectorsPath = join(root, 'tests/ultrags/protocol/vectors.json');
const genWire = join(root, 'tools/ultrags/gen-wire.mjs');
const vec2c = join(root, 'tools/ultrags/vec2c.mjs');

mkdirSync(gen, { recursive: true });
mkdirSync(join(build, 'logs'), { recursive: true });

let pass = 0, fail = 0;
const results = [];
const ok = (name, detail = '') => { pass++; results.push({ name, result: 'PASS', detail }); };
const bad = (name, detail = '') => { fail++; results.push({ name, result: 'FAIL', detail }); };

const toBytes = (s) => (s === '' || s === undefined ? [] : s.trim().split(/\s+/).map((h) => parseInt(h, 16)));

function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

// ---- 1. fresh generate ----
{
  const r = run(process.execPath, [genWire, schemaPath, gen]);
  r.code === 0 ? ok('gen-wire schema validation+emit') : bad('gen-wire schema validation+emit', r.out);
}
// ---- 2. vectors -> C header ----
{
  const r = run(process.execPath, [vec2c, vectorsPath, join(gen, 'vectors-expected.h')]);
  r.code === 0 ? ok('vec2c vector reformat') : bad('vec2c vector reformat', r.out);
}
// ---- 3. compile + run check-wire.c (C) + C++ smoke consumer ----
{
  const cc = process.env.CC || 'cc';
  const bin = join(build, 'check-wire');
  const c = run(cc, ['-O0', '-Wall', '-Wextra', '-Werror', '-std=c11',
    '-I' + gen, '-o', bin, join(root, 'tests/ultrags/protocol/check-wire.c')]);
  if (c.code !== 0) bad('check-wire compile', c.out);
  else {
    const r = run(bin, []);
    if (r.code === 0) ok('check-wire execution', r.out.trim().split('\n').pop());
    else bad('check-wire execution', r.out.trim().split('\n').slice(-6).join(' | '));
  }
  // C++ consumer: generated header must be valid C++ too (firmware is C++/C mix)
  const cxx = process.env.CXX || 'c++';
  const cpp = run(cxx, ['-fsyntax-only', '-Wall', '-Wextra', '-Werror', '-std=c++17',
    '-I' + gen, join(root, 'tests/ultrags/protocol/check-wire.cpp')]);
  cpp.code === 0 ? ok('check-wire.cpp C++ consumer compile')
                 : bad('check-wire.cpp C++ consumer compile', cpp.out);
}
// ---- 4. vectors.json vs schema cross-checks (drift guard) ----
{
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));
  const opByHex = new Map(schema.opcodes.map((o) => [parseInt(o.hex, 16), o]));
  let sub = 0, subok = 0;
  const t = (cond, name) => { sub++; cond ? subok++ : bad(`vector-drift:${name}`); };

  for (const f of vectors.frames) {
    const op = opByHex.get(parseInt(f.opcode, 16));
    t(!!op, `frame ${f.name}: opcode ${f.opcode} exists in schema`);
    if (op) {
      if (f.payload_seq) {
        const m = f.payload_seq.match(/^(\d+)\.\.(\d+)$/);
        t(!!m, `frame ${f.name}: payload_seq grammar`);
        if (m) {
          const lo = +m[1], hi = +m[2];
          const pre = toBytes(f.expect_request_prefix || '');
          const trl = toBytes(f.expect_request_trailer || '');
          t(pre[0] === (parseInt(f.opcode, 16) | (f.frame_crc ? 0x80 : 0)),
            `frame ${f.name}: prefix opcode/crcbit`);
          t(pre[1] === (hi - lo + 1), `frame ${f.name}: prefix payload_length`);
          if (f.expect_total_len !== undefined)
            t(2 + (hi - lo + 1) + trl.length === f.expect_total_len,
              `frame ${f.name}: total length ${f.expect_total_len}`);
        }
      } else if (f.payload_len_repeat !== undefined) {
        const n = f.payload_len_repeat;
        const pre = toBytes(f.expect_request_prefix || '');
        const trl = toBytes(f.expect_request_trailer || '');
        t(n >= 0 && n <= 128, `frame ${f.name}: payload_len_repeat in range`);
        t(pre[0] === (parseInt(f.opcode, 16) | (f.frame_crc ? 0x80 : 0)),
          `frame ${f.name}: prefix opcode/crcbit`);
        t(pre[1] === n, `frame ${f.name}: prefix payload_length`);
        t(2 + n + trl.length <= 134, `frame ${f.name}: total <= 134`);
      } else {
        const plBytes = toBytes(f.payload);
        const expBytes = f.expect_request ? toBytes(f.expect_request) : null;
        if (expBytes) {
          t(expBytes.length === 2 + plBytes.length + (f.frame_crc ? 4 : 0),
            `frame ${f.name}: expected length consistent (2+${plBytes.length}${f.frame_crc ? '+4' : ''})`);
          t(expBytes[0] === (parseInt(f.opcode, 16) | (f.frame_crc ? 0x80 : 0)),
            `frame ${f.name}: header byte0 opcode/crcbit`);
          t(expBytes[1] === plBytes.length, `frame ${f.name}: header byte1 payload_length`);
          t(expBytes.slice(2, 2 + plBytes.length).join(',') === plBytes.join(','),
            `frame ${f.name}: payload bytes`);
        }
      }
      if (f.expect_resp_header) {
        const rh = toBytes(f.expect_resp_header);
        t(rh[0] === 0, `frame ${f.name}: resp status OK`);
        if (f.resp_payload_len !== undefined) t(rh[1] === f.resp_payload_len, `frame ${f.name}: resp len`);
      }
    }
  }
  for (const e of vectors.le_encoding) {
    const bytes = toBytes(e.expect);
    const v = BigInt(e.value);
    const sz = { u16: 2, u32: 4, u64: 8 }[e.type];
    t(bytes.length === sz, `le ${e.name}: length ${sz}`);
    let okLE = true;
    for (let i = 0; i < sz; i++) if (bytes[i] !== Number((v >> BigInt(8 * i)) & 0xFFn)) okLE = false;
    t(okLE, `le ${e.name}: LE order`);
  }
  // struct offset assertions vs generated header values
  const inc = readFileSync(join(gen, 'ug_wire.inc'), 'utf8');
  for (const s of vectors.struct_offsets) {
    const re = new RegExp(`UG_${s.struct}_${s.field.toUpperCase()}_OFF\\s+EQU\\s+0x([0-9A-F]+)`, 'i');
    const m = inc.match(re);
    t(!!m, `struct_offsets ${s.struct}.${s.field}: emitted`);
    if (m) t(parseInt(m[1], 16) === s.off, `struct_offsets ${s.struct}.${s.field} off=${s.off} (got ${m[1]})`);
    if (s.size !== undefined) {
      const rs = new RegExp(`UG_${s.struct}_LEN\\s+EQU\\s+0x([0-9A-F]+)`, 'i');
      const ms = inc.match(rs);
      t(!!ms && parseInt(ms[1], 16) === s.size, `struct_offsets ${s.struct} size=${s.size}`);
    }
    if (s.vsize !== undefined) {
      const rs = new RegExp(`UG_${s.struct}_VLEN\\s+EQU\\s+0x([0-9A-F]+)`, 'i');
      const ms = inc.match(rs);
      t(!!ms && parseInt(ms[1], 16) === s.vsize, `struct_offsets ${s.struct} vsize=${s.vsize}`);
    }
  }
  // emitted-symbol uniqueness in both outputs (generator itself also checks)
  {
    const incSyms = [...inc.matchAll(/^([A-Z0-9_]+)\s+EQU/gm)].map((m) => m[1]);
    const incDup = incSyms.filter((s, i) => incSyms.indexOf(s) !== i);
    t(incDup.length === 0, `ug_wire.inc duplicate symbols: ${incDup.join(',') || 'none'}`);
    const h = readFileSync(join(gen, 'ug_wire.h'), 'utf8');
    // UG_STATIC_ASSERT is intentionally defined twice under #ifdef __cplusplus
    const hSyms = [...h.matchAll(/^#define\s+(UG_[A-Z0-9_]+)/gm)].map((m) => m[1])
      .filter((s) => s !== 'UG_STATIC_ASSERT');
    const hDup = hSyms.filter((s, i) => hSyms.indexOf(s) !== i);
    t(hDup.length === 0, `ug_wire.h duplicate defines: ${hDup.join(',') || 'none'}`);
  }
  // legacy vs EXT handle distinctness: D2 returns legacy u8 (1 byte), not u16
  {
    const d2 = schema.gsCommands.find((g) => g.name === 'GS_LOAD_CLOSE');
    t(d2 && d2.out === 1, 'GS D2 reply is legacy u8 handle (out=1)');
    const li = schema.opcodes.find((o) => o.name === 'LEGACY_INFO');
    t(li && li.respStruct === 'LEGACY_INFO_RESP', 'EXT handle mapping via LEGACY_INFO');
    // CAPS/CLEAR_STATS are NOT in the active-transfer whitelist (spec 5)
    const caps = schema.opcodes.find((o) => o.name === 'CAPS');
    const clr = schema.opcodes.find((o) => o.name === 'CLEAR_STATS');
    t(!caps.transferOk && !clr.transferOk, 'CAPS/CLEAR_STATS excluded from transfer whitelist');
    for (const n of ['INFO', 'MEM_INFO', 'STATS', 'OBJECT_INFO', 'LEGACY_INFO',
                     'SNAPSHOT', 'FX_STATUS', 'WRITE_END', 'READ_END', 'TRANSFER_CANCEL']) {
      const o = schema.opcodes.find((x) => x.name === n);
      t(o && o.transferOk === true, `${n} in transfer whitelist`);
    }
  }
  ok('vectors-vs-schema cross-check', `${subok}/${sub} subchecks`);
  if (subok !== sub) fail += 0; // individual failures already counted
}
// ---- 5. negative schema probes: generator must reject WITH the specific diagnostic ----
{
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const probes = [
    ['dup-opcode', /duplicate hex/, (s) => { s.opcodes.push({ ...s.opcodes[0], name: 'DUPX' }); }],
    ['opcode-out-of-range', /out of range/, (s) => { s.opcodes[0].hex = '0x80'; }],
    ['fractional-opcode', /non-integer/, (s) => { s.opcodes[0].hex = 0.5; }],
    ['dup-error-value', /duplicate value/, (s) => { s.errors[1].value = '0x00'; }],
    ['error-out-of-range', /out of range/, (s) => { s.errors[1].value = '0x80'; }],
    ['dup-config-selector', /duplicate selector value/, (s) => {
      s.configPorts.selectors.FW_ACTIVE.value = s.configPorts.selectors.FW_CATALOG.value; }],
    ['gs-opcode-out-of-u8', /out of range/, (s) => { s.gsCommands[0].hex = '0x100'; }],
    ['gs-range-overlap', /overlaps/, (s) => { s.gsCommands.push({ hex: '0x81', name: 'EVILGS', pre: 0, post: 0, out: 0 }); }],
    ['object-kind-out-of-u8', /out of range/, (s) => { s.objects.kinds[0].value = 256; }],
    ['dup-object-kind', /duplicate value/, (s) => { s.objects.kinds[1].value = 0; }],
    ['struct-size-drift', /declared size .* != computed/, (s) => { s.structs.INFO.size = 35; }],
    ['field-offset-drift', /declared off .* != computed/, (s) => { s.structs.SNAPSHOT.fields[3].off = 21; }],
    ['reg-overlap', /overlapping offsets/, (s) => { s.registers.push({ off: '0x01', name: 'EVIL', read: 'zero', write: 'bad_register' }); }],
    ['reg-unknown-read', /unknown read kind/, (s) => { s.registers[0].read = 'psychic' }],
    ['unknown-field-type', /unknown\/ill-formed type/, (s) => { s.structs.MEM_INFO.fields[0].type = 'u128'; }],
    ['field-bytes-invalid-suffix', /unknown\/ill-formed type/, (s) => { s.structs.INFO.fields[0].type = 'bytes:4junk'; }],
    ['const-out-of-domain', /does not fit/, (s) => { s.structs.INFO.fields[1].const = 300; }],
    ['const-bad-bytes-len', /const must be 4-char/, (s) => { s.structs.INFO.fields[0].const = 'UGS'; }],
    ['bad-verify-field', /verified field in struct without a VERIFIED layout/, (s) => { s.structs.INFO.fields.push({ name: 'x', type: 'u8', verifiedOnly: true }); }],
    ['verify-not-trailing', /verified field must be the trailing last field/, (s) => {
      const f = s.structs.WRITE_BEGIN_REQ.fields;
      f.unshift(f.pop()); }],
    ['verify-bad-name', /verified suffix field must be named/, (s) => {
      s.structs.WRITE_BEGIN_REQ.fields.at(-1).name = 'sum'; }],
    ['crc-poly-fraction', /crc\.poly.*non-integer/, (s) => { s.crc.poly = 0.5; }],
    ['crc-init-overflow', /crc\.init.*out of range/, (s) => { s.crc.init = '0x100000000'; }],
    ['crc-refin-string', /crc\.refin.*boolean true/, (s) => { s.crc.refin = 'true'; }],
    ['crc-refout-false', /crc\.refout.*boolean true/, (s) => { s.crc.refout = false; }],
    ['bad-hex-string', /bad numeric value/, (s) => { s.limits.MAX_PAYLOAD.value = '0xGG'; }],
    ['na-numeric', /bad numeric value/, (s) => { s.errors[0].value = null; }],
    ['both-req-reqstruct', /both req and reqStruct/, (s) => { s.opcodes[0].req = []; s.opcodes[0].reqStruct = 'INFO'; }],
    ['name-case-struct', /must be UPPER_SNAKE/, (s) => { s.structs.info = { size: 1, fields: [] }; }],
    ['bad-field-name', /ill-formed field name/, (s) => { s.structs.INFO.fields[0].name = 'Magic X'; }],
    ['untrusted-derived-size', /reserved derived key _size/, (s) => { s.structs.INFO._size = 36; }],
    ['non-ascii-constant', /const must be 4-char/, (s) => { s.structs.INFO.fields[0].const = 'UGSЖ'; }],
    ['verified-string', /verifiedOnly not boolean/, (s) => { s.structs.WRITE_BEGIN_REQ.fields.at(-1).verifiedOnly = 'yes'; }],
    ['variable-prefix-drift', /declared size .* != computed prefix/, (s) => {
      s.structs.TESTVAR = { size: 2, fields: [{ name: 'count', type: 'u8' }, { name: 'records', type: 'varray:FXREC' }] }; }],
  ];
  let rej = 0;
  const detail = [];
  for (const [name, expectRe, mut] of probes) {
    const copy = JSON.parse(JSON.stringify(schema));
    mut(copy);
    const tmp = join(build, 'gen', `_neg_${name}.json`);
    writeFileSync(tmp, JSON.stringify(copy));
    const r = run(process.execPath, [genWire, tmp, join(build, 'gen', '_neg_out')]);
    if (r.code === 0) {
      bad(`neg-schema:${name}`, 'generator accepted defective schema');
      detail.push(`${name}:ACCEPTED`);
    } else if (!expectRe.test(r.out)) {
      bad(`neg-schema:${name}`, `rejected but missing diagnostic ${expectRe}: ${r.out.split('\n').slice(0, 4).join(' | ')}`);
      detail.push(`${name}:WRONGDIAG`);
    } else rej++;
  }
  rej === probes.length ? ok('negative schema probes', `${rej}/${probes.length} rejected w/ specific diagnostics`)
                        : bad('negative schema probes', `${rej}/${probes.length}: ${detail.join(' ')}`);
}

// ---- 6. Z80 machine-code vectors on the pinned instruction-level core ----
// Assembles the production ASM lib (ugcrc/ugle/ugframe) + z80-vectors.asm,
// executes instruction-by-instruction, compares OUT deposits against the
// handwritten vectors.json expectations.
{
  const r = run(process.execPath, [join(root, 'tests/ultrags/dss/run-z80-vectors.mjs'), root, build]);
  r.code === 0 ? ok('Z80 vectors on pinned core', r.out.trim().split('\n').pop())
               : bad('Z80 vectors on pinned core', r.out.trim().split('\n').slice(-6).join(' | '));
}

// ---- 7. card model unit tests (port-level, includes reviewer-fixed MUSTs) ----
{
  const r = run(process.execPath, [join(root, 'tests/ultrags/dss/ug-card-test.mjs'), root, build]);
  r.code === 0 ? ok('card model unit tests', r.out.trim().split('\n').pop())
               : bad('card model unit tests', r.out.trim().split('\n').slice(-8).join(' | '));
}

// ---- 8. DSS EXE vertical: real header load + pinned-core ISA roundtrip ----
{
  const r = run(process.execPath, [join(root, 'tests/ultrags/dss/run-ugdiag.mjs'), root, build]);
  r.code === 0 ? ok('UGDIAG vertical (EXE + ISA window + card)', r.out.trim().split('\n').pop())
               : bad('UGDIAG vertical (EXE + ISA window + card)', r.out.trim().split('\n').slice(-10).join(' | '));
}

// ---- 9/10. independent reviewer probes (files owned by the reviewer,
//      never edited here; outputs to build/ultrags/{model,schema}-review) ----
{
  const r = run(process.execPath, [
    join(root, 'tests/ultrags/reports/S0b-review-2026-10-07/model-extra-probes.mjs'),
    root, join(build, 'model-review')]);
  r.code === 0 ? ok('reviewer model probes', r.out.trim().split('\n').pop() || 'all pass')
               : bad('reviewer model probes', r.out.trim().split('\n').slice(-10).join(' | '));
}
{
  const r = run(process.execPath, [
    join(root, 'tests/ultrags/reports/S0b-review-2026-10-07/schema-extra-probes.mjs'),
    root, join(build, 'schema-review')]);
  r.code === 0 ? ok('reviewer schema probes', r.out.trim().split('\n').pop() || 'all pass')
               : bad('reviewer schema probes', r.out.trim().split('\n').slice(-10).join(' | '));
}

// summary
const summary = { pass, fail, results };
writeFileSync(join(build, 'logs', 'protocol-tests.json'), JSON.stringify(summary, null, 2));
for (const r of results) console.log(`${r.result === 'PASS' ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' -- ' + r.detail : ''}`);
console.log(`PROTOCOL-TESTS ${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
