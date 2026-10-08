// SPDX-License-Identifier: GPL-2.0-or-later
// Content-based provenance for the assembled and executed S0b artifacts.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export function treeFiles(root, dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? treeFiles(root, `${dir}/${e.name}`) : [`${dir}/${e.name}`]).sort();
}
export function buildInputs(root, exeDir) {
  const paths = [...treeFiles(root, 'host/sprinter/ultrags'),
    'tools/ultrags/wire-schema.json', 'tools/ultrags/gen-wire.mjs',
    'tools/ultrags/diag-schema.json', 'tools/ultrags/gen-diag.py',
    'tools/ultrags/build-evidence.mjs', 'tests/ultrags/dss/assemble.mjs'].sort();
  return { sources: Object.fromEntries(paths.map(p => [p, sha256(readFileSync(join(root, p)))])),
    generated: sha256(Buffer.concat(['ug_wire.inc','ug_diag_wire.inc'].map(p=>readFileSync(join(exeDir, '../gen',p))))) };
}
export function executionInputs(root) {
  return Object.fromEntries(['Z80core.js', 'ug-card.js', 'ug-harness.mjs', 'run-ugdiag.mjs', 'diag-card.mjs', 'run-s1.mjs']
    .map(p => [`tests/ultrags/dss/${p}`, sha256(readFileSync(join(root, 'tests/ultrags/dss', p)))]));
}
export function verifyBuild(root, exeDir) {
  const manifest = JSON.parse(readFileSync(join(exeDir, 'asm-manifest.json')));
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(buildInputs(root, exeDir)))
    throw new Error('stale assembly inputs: source/schema/generator/generated hashes differ; rebuild dss');
  const names = treeFiles(root, 'host/sprinter/ultrags').filter(p => p.endsWith('.asm') &&
    /\/(apps|selftest)\//.test(p)).map(p => p.split('/').at(-1).replace(/\.asm$/, '.EXE').toUpperCase()).sort();
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
