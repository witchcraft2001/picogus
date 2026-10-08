#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// assemble.mjs - build all Ultra GS DSS EXEs for the `dss` make target.
// Assembles ugdiag.asm + every selftest/st-*.asm with sjasmplus into
// <out>/*.EXE + .lst and writes asm-manifest.json (sha256 per artifact).
//
//   node tests/ultrags/dss/assemble.mjs <repo> <out-dir>

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildInputs } from '../../../tools/ultrags/build-evidence.mjs';

const REPO = resolve(process.argv[2] || '.');
const OUT = resolve(process.argv[3] || 'build/ultrags/dss');
const SJASM = process.env.SJASMPLUS || 'sjasmplus';
const INCDIR = join(REPO, 'host/sprinter/ultrags/include');
const LIBDIR = join(REPO, 'host/sprinter/ultrags/lib');
const STDIR = join(REPO, 'host/sprinter/ultrags/selftest');
const GENDIR = join(OUT, '../gen'); // <UGBUILD>/gen regardless of BUILD=
mkdirSync(OUT, { recursive: true });

const sources = [
  join(REPO, 'host/sprinter/ultrags/apps/ugdiag.asm'),
  ...readdirSync(STDIR).filter((f) => f.endsWith('.asm')).sort().map((f) => join(STDIR, f)),
];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const manifest = { assembler: null, inputs: buildInputs(REPO, OUT), files: [] };
const version = spawnSync(SJASM, ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) throw version.error ?? new Error(version.stderr);
manifest.assembler = (version.stdout + version.stderr).trim().split('\n')[0];
if (!/\bv1\.22\.0\b/.test(manifest.assembler)) throw new Error(`sjasmplus 1.22.0 required: ${manifest.assembler}`);

let failed = 0;
for (const src of sources) {
  const name = src.split('/').pop().replace(/\.asm$/i, '');
  const exe = join(OUT, `${name.toUpperCase()}.EXE`);
  const lst = join(OUT, `${name}.lst`);
  try {
    execFileSync(SJASM, [
      `--inc=${INCDIR}`, `--inc=${LIBDIR}`, `--inc=${STDIR}`, `--inc=${GENDIR}`,
      `--raw=${exe}`, `--lst=${lst}`, src,
    ], { stdio: 'pipe' });
    const b = readFileSync(exe);
    manifest.files.push({ name: `${name.toUpperCase()}.EXE`, size: b.length, sha256: sha(b), src: src.slice(REPO.length + 1) });
    console.log(`  ${name.toUpperCase()}.EXE ${b.length}B`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${(String(e.stdout || '') + String(e.stderr || '') || e.message).split('\n').slice(0, 10).join(' | ')}`);
  }
}
writeFileSync(join(OUT, 'asm-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(failed ? `assemble: ${failed} FAILED` : `assemble: ${manifest.files.length} EXEs -> ${OUT}`);
process.exit(failed ? 1 : 0);
