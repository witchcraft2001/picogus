// SPDX-License-Identifier: GPL-2.0-or-later
// Content-based provenance for the assembled and executed S0b artifacts.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
// Stable DSS 8.3 names, shared by assembly and actual-EXE runners. Never
// truncate automatically: a new long source name requires an explicit name.
const shortExeNames = {
  'ST-BADCRC': 'ST-BCRC', 'ST-BADSLOT': 'ST-BSLOT',
  'ST-BUDGET': 'ST-BUDGT', 'ST-CANCEL': 'ST-CANCL',
  'ST-CTXIFF': 'ST-CIFF', 'ST-CTXPG3': 'ST-CPG3', 'ST-CTXSYS': 'ST-CSYS',
  'ST-DSSGRANT': 'ST-DGRT', 'ST-DSSWIN': 'ST-DWIN',
  'ST-FRAMECRC': 'ST-FCRC', 'ST-NMIHAZ': 'ST-NHAZ',
  'ST-NMIUNSAFE': 'ST-NUNSF', 'ST-NOSESSION': 'ST-NSESS',
  'ST-OVERGRANT': 'ST-OGRT', 'ST-PENDING': 'ST-PEND',
  'ST-PROFILE': 'ST-PROF', 'ST-RESPBUF': 'ST-RBUF',
  'ST-S1-BENCH': 'ST-1BNCH', 'ST-S1-CLEANUP': 'ST-1CLN',
  'ST-S1-COUNTER': 'ST-1CNT', 'ST-S1-DROP': 'ST-1DROP',
  'ST-S1-DSSWIN': 'ST-1WIN', 'ST-S1-DUP': 'ST-1DUP',
  'ST-S1-FUSE': 'ST-1FUSE', 'ST-S1-OVERBLOCK': 'ST-1OBLK',
  'ST-TRANSFER': 'ST-XFER', 'ST-TRANSPORT': 'ST-TRANS',
  'ST-VERIFIED': 'ST-VER', 'ST-WRITEFAIL': 'ST-WFAIL',
};
export function dssExeName(sourceName) {
  const base = sourceName.toUpperCase().replace(/\.(ASM|EXE)$/, '');
  const name = `${shortExeNames[base] ?? base}.EXE`;
  if (!/^[A-Z0-9_-]{1,8}\.EXE$/.test(name))
    throw new Error(`DSS EXE needs an explicit 8.3 name: ${sourceName}`);
  return name;
}
export function treeFiles(root, dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? treeFiles(root, `${dir}/${e.name}`) : [`${dir}/${e.name}`]).sort();
}
export function buildInputs(root, exeDir) {
  // Only assembler inputs belong to EXE provenance. Tester Notes are hashed
  // by packaging; editing prose must not falsely invalidate machine code.
  const paths = [...treeFiles(root, 'host/sprinter/ultrags').filter(p=>/\.(asm|inc)$/.test(p)),
    'tools/ultrags/wire-schema.json', 'tools/ultrags/gen-wire.mjs',
    'tools/ultrags/diag-schema.json', 'tools/ultrags/gen-diag.py',
    'tools/ultrags/build-evidence.mjs', 'tests/ultrags/dss/assemble.mjs'].sort();
  return { sources: Object.fromEntries(paths.map(p => [p, sha256(readFileSync(join(root, p)))])),
    generated: sha256(Buffer.concat(['ug_wire.inc','ug_diag_wire.inc'].map(p=>readFileSync(join(exeDir, '../gen',p))))) };
}
export function executionInputs(root) {
  return Object.fromEntries(['Z80core.js', 'ug-card.js', 'ug-harness.mjs', 'run-ugdiag.mjs', 'diag-card.mjs', 'run-s1.mjs', 'config-card.mjs', 'run-s2.mjs', 'memory-card.mjs', 'run-s3.mjs', 'slow-card.mjs', 'run-s4.mjs', 'run-s5.mjs', 'pcm-card.mjs', 'mod-tracker.mjs', 'run-s6.mjs', 'run-s7.mjs', 'throughput.mjs','run-native.mjs','native-card.mjs','legacy-machine.mjs']
    .map(p => [`tests/ultrags/dss/${p}`, sha256(readFileSync(join(root, 'tests/ultrags/dss', p)))]));
}
export function verifyBuild(root, exeDir) {
  const manifest = JSON.parse(readFileSync(join(exeDir, 'asm-manifest.json')));
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(buildInputs(root, exeDir)))
    throw new Error('stale assembly inputs: source/schema/generator/generated hashes differ; rebuild dss');
  const names = treeFiles(root, 'host/sprinter/ultrags').filter(p => p.endsWith('.asm') &&
    /\/(apps|selftest)\//.test(p)).map(p => dssExeName(p.split('/').at(-1))).sort();
  if (new Set(names).size !== names.length) throw new Error('duplicate DSS 8.3 EXE names');
  if (JSON.stringify(names) !== JSON.stringify(manifest.files.map(e => e.name).sort()))
    throw new Error('assembly manifest EXE set differs from current sources');
  for (const e of manifest.files) {
    const bytes = readFileSync(join(exeDir, e.name));
    if (bytes.length !== e.size || sha256(bytes) !== e.sha256)
      throw new Error(`stale/substituted EXE: ${e.name}`);
  }
  return manifest;
}
export function verifyExecution(root, exeDir) {
  const build = verifyBuild(root, exeDir);
  const path = join(exeDir, '../logs/ugdiag-run.json');
  const execution = JSON.parse(readFileSync(path));
  if (execution.fail !== 0 || !execution.pass || !execution.results?.length ||
      execution.results.some(r => !r.ok)) throw new Error('execution evidence contains failed/missing checks');
  if (JSON.stringify(execution.buildInputs) !== JSON.stringify(build.inputs) ||
      JSON.stringify(execution.executionInputs) !== JSON.stringify(executionInputs(root)))
    throw new Error('stale execution inputs: rerun test-dss');
  if (JSON.stringify(execution.executed) !== JSON.stringify(build.files.map(e =>
      ({ name: e.name, size: e.size, sha256: e.sha256 }))))
    throw new Error('executed EXE hashes/set differ from assembly manifest');
  return { assembly: sha256(readFileSync(join(exeDir, 'asm-manifest.json'))),
    execution: sha256(readFileSync(path)) };
}
