#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// run-z80-vectors.mjs - standalone execution of the production Ultra GS
// ASM routines (ugcrc.asm / ugle.asm / ugframe.asm) on the PINNED Z80
// instruction-level core. This is the milestone-1 ASM vector proof:
// real Z80 machine code is assembled by sjasmplus, executed
// instruction-by-instruction, and every result byte is compared against
// the HANDWRITTEN expectations in tests/ultrags/protocol/vectors.json
// ("z80" section) - never against generated equates or the generator.
//
// Scope note: this is the small standalone runner only. The full
// DSS/MMU/card harness is the next milestone.
//
// Usage:
//   node tests/ultrags/dss/run-z80-vectors.mjs <repo> [build_dir]
// Exit 0 iff every check passes.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const REPO = resolve(process.argv[2] || '.');
// The pinned Z80core.js is a browser-era module: its constructor guard reads
// the global `window`. Provide a host shim here; the pinned file stays
// byte-identical to the donor revision.
globalThis.window = globalThis;
const require = createRequire(import.meta.url);
const Z80 = require(join(REPO, 'tests/ultrags/dss/Z80core.js'));

const BUILD = process.argv[3] || 'build/ultrags';
const SRC = join(REPO, 'tests/ultrags/protocol/z80-vectors.asm');
const VECTORS = join(REPO, 'tests/ultrags/protocol/vectors.json');
const LIBDIR = join(REPO, 'host/sprinter/ultrags/lib');
const INCDIR = join(REPO, 'host/sprinter/ultrags/include');
const GENDIR = join(BUILD, 'gen');
const OUTDIR = join(BUILD, 'z80vec');
const BIN = join(OUTDIR, 'z80-vectors.bin');
const LST = join(OUTDIR, 'z80-vectors.lst');
const LOGS = join(BUILD, 'logs');
const SJASM = process.env.SJASMPLUS || 'sjasmplus';

const OUT = 0xA000;
const ORG = 0x8000;
const STACK = 0xBFFE;
const BUDGET = 2_000_000;

mkdirSync(OUTDIR, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const results = [];
let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; results.push({ name: n, ok: true, detail: d }); console.log(`PASS ${n}${d ? ' -- ' + d : ''}`); };
const bad = (n, d = '') => { fail++; results.push({ name: n, ok: false, detail: d }); console.log(`FAIL ${n} -- ${d}`); };
const toBytes = (s) => (s || '').trim().split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16));
const hex = (n, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');
const hexs = (a) => Array.from(a).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

// ---- 1. assemble the real Z80 binary ----
let bin;
let steps = 0, end = { halted: false, pc: 0, cycle_counter: 0 };
try {
  execFileSync(SJASM, [
    `--inc=${INCDIR}`, `--inc=${LIBDIR}`, `--inc=${GENDIR}`,
    `--raw=${BIN}`, `--lst=${LST}`, SRC,
  ], { stdio: 'pipe' });
} catch (e) {
  bad('sjasmplus assemble', String(e.stdout || e.stderr || e.message).split('\n').slice(0, 12).join(' | '));
  finish();
  process.exit(1);
}
bin = readFileSync(BIN);
if (bin.length > OUT - ORG) {
  bad('assemble size', `binary ${bin.length}B would overwrite OUT area at ${hex(OUT)}`);
  finish();
  process.exit(1);
}
ok('sjasmplus assemble', `${bin.length} bytes at ${hex(ORG)}`);

// ---- 2. execute on pinned Z80 core ----
const mem = new Uint8Array(0x10000);
mem.set(bin, ORG);
const ioLog = [];
const z = new Z80({
  mem_read: (a) => mem[a & 0xFFFF],
  mem_write: (a, v) => { mem[a & 0xFFFF] = v & 0xFF; },
  io_read: (p) => { ioLog.push(['in', p & 0xFFFF]); return 0xFF; },
  io_write: (p, v) => { ioLog.push(['out', p & 0xFFFF, v & 0xFF]); },
});
z.reset();
const st = z.getState();
st.pc = ORG; st.sp = STACK; st.iff1 = false; st.iff2 = false; st.imode = 1;
z.setState(st);

// pinned core: run_instruction() returns the instruction's T-states and
// resets its internal cycle_counter to 0 each call - sum the returns.
let cycles = 0;
while (!z.getState().halted && steps < BUDGET) {
  cycles += z.run_instruction();
  steps++;
}
end = z.getState();
if (!end.halted) {
  bad('execute', `never halted: budget ${BUDGET} exhausted at PC=${hex(end.pc)}`);
  finish();
  process.exit(1);
}
ok('execute on pinned Z80', `halted at PC=${hex(end.pc)} after ${steps} instructions, ${cycles}T`);

if (ioLog.length) bad('unexpected I/O', `${ioLog.length} port accesses: ${JSON.stringify(ioLog.slice(0, 4))}`);
else ok('no I/O performed', 'pure compute, as expected for serializer/crc/lib helpers');

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const binSha = sha256(BIN);
const coreSha = sha256(join(REPO, 'tests/ultrags/dss/Z80core.js'));

// ---- 3. compare OUT deposits against handwritten vectors.json ----
const vectors = JSON.parse(readFileSync(VECTORS, 'utf8'));
const zv = vectors.z80;
const frameByName = new Map(vectors.frames.map((f) => [f.name, f]));

const dump = (off, n) => Array.from(mem.slice(OUT + off, OUT + off + n));
const expectFrameBytes = (f) => {
  if (f.expect_request) return toBytes(f.expect_request);
  if (f.expect_request_prefix) {
    const pre = toBytes(f.expect_request_prefix);
    const trl = toBytes(f.expect_request_trailer || '');
    if (f.payload_seq) {
      const m = f.payload_seq.match(/^(\d+)\.\.(\d+)$/);
      const lo = +m[1], hi = +m[2];
      const body = [];
      for (let i = lo; i <= hi; i++) body.push(i & 0xFF);
      return [...pre, ...body, ...trl];
    }
    if (f.payload_len_repeat !== undefined) {
      return [...pre, ...new Array(f.payload_len_repeat).fill(0), ...trl];
    }
    return [...pre, ...trl];
  }
  return null;
};

let sub = 0, subok = 0;
const t = (cond, name, d = '') => { sub++; if (cond) subok++; else bad(`z80vec:${name}`, d); };

// CRC slots
for (const cs of zv.crc_slots) {
  const exp = toBytes(cs.expect);
  const got = dump(cs.off, exp.length);
  t(exp.join(',') === got.join(','), `crc@${cs.off}`, `expect ${cs.expect} got ${hexs(got)} (${cs.what})`);
}
// LE helpers
for (const key of ['le16', 'le32', 'le64', 'get16', 'get32']) {
  const it = zv[key];
  const exp = toBytes(it.expect);
  const got = dump(it.off, exp.length);
  t(exp.join(',') === got.join(','), key, `expect ${it.expect} got ${hexs(got)}`);
}
// frame slots
const fbase = zv.frame_base_off, fstride = zv.frame_stride;
for (const fs of zv.frame_slots) {
  const off = fbase + fs.slot * fstride;
  const err = mem[OUT + off], len = mem[OUT + off + 1];
  const got = dump(off + 2, len);
  if (fs.expect_err !== undefined) {
    t(err === fs.expect_err, `frame slot${fs.slot} errflag`, `expect err=${fs.expect_err} got ${err} (${fs.what})`);
    continue;
  }
  const f = frameByName.get(fs.vector);
  if (!f) { t(false, `frame slot${fs.slot}`, `unknown vector ${fs.vector}`); continue; }
  const exp = expectFrameBytes(f);
  if (!exp) { t(false, `frame slot${fs.slot}`, `vector ${fs.vector} lacks expected bytes`); continue; }
  t(err === 0, `frame slot${fs.slot}:${fs.vector} errflag`, `err=${err}`);
  t(len === exp.length, `frame slot${fs.slot}:${fs.vector} len`, `expect ${exp.length} got ${len}`);
  t(exp.join(',') === got.join(','), `frame slot${fs.slot}:${fs.vector} bytes`,
    `expect ${hexs(exp)} got ${hexs(got)}`);
}
subok === sub ? ok('OUT deposits vs vectors.json', `${subok}/${sub} byte comparisons`)
              : bad('OUT deposits vs vectors.json', `${subok}/${sub}`);

function finish() {
  writeFileSync(join(LOGS, 'z80-vectors.json'), JSON.stringify({
    binary: { path: BIN, bytes: bin ? bin.length : 0, org: ORG, sha256: binSha },
    core: { path: 'tests/ultrags/dss/Z80core.js', sha256: coreSha },
    execution: { steps, cycles, halted: end.halted, pc: end.pc },
    pass, fail, results,
  }, null, 2));
  console.log(`Z80-VECTORS ${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} pass, ${fail} fail`);
}
finish();
process.exit(fail ? 1 : 0);
