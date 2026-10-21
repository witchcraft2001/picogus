#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// test-stage-excerpt.mjs - self-tests for stage-excerpt.mjs per TZ 13.5:
//   * all 14 stages resolve and produce output
//   * mandatory 1/2/16/17 + 17.1 (D01/D02) present in every excerpt
//   * deterministic: two runs byte-identical
//   * source sha256 in header; changing the MD changes the hash line
//   * unknown stage -> hard fail; malformed/ambiguous ref -> hard fail
//   * missing section ref -> hard fail; overwrite-of-source -> refused
//   * the source MD is byte-identical before/after (no mutation)
//
//   node tools/ultrags/test-stage-excerpt.mjs [--out build/ultrags/excerpts]

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync, linkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const TOOL = resolve(here, '../stage-excerpt.mjs');
const SPEC = resolve(here, '../../../ultra-gs-docs/ultra-gs.md');
const outIdx = process.argv.indexOf('--out');
const OUTBASE = resolve(outIdx >= 0 ? process.argv[outIdx + 1] : 'build/ultrags/excerpts');
const STAGES = ['S0a', 'S0b', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8a', 'S8b', 'S8c', 'S9', 'S10', 'S11'];
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
let pass = 0, fail = 0;
const ok = (c, n) => c ? (pass++, console.log(`PASS ${n}`)) : (fail++, console.log(`FAIL ${n}`));

function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }; }
}

const specBefore = sha256(readFileSync(SPEC));
const tmp = mkdtempSync(join(tmpdir(), 'ugexc-'));

// 1. all 14 stages resolve; mandatory sections + 17.1 present
for (const s of STAGES) {
  const out = join(tmp, `e-${s}.md`);
  const r = run(['--stage', s, '--spec', SPEC, '--output', out]);
  if (r.code !== 0) { fail++; console.log(`FAIL stage ${s}: ${r.out.split('\n')[0]}`); continue; }
  const t = readFileSync(out, 'utf8');
  const hdr = t.slice(0, t.indexOf('-->'));
  const need = ['§1 ', '§2 ', '§16 ', '§17 ', '§17.1'];
  const missing = need.filter((m) => !hdr.includes('- ' + m));
  ok(missing.length === 0 && t.includes('### ' + s + '.'), `stage ${s}: mandatory sections${missing.length ? ' missing ' + missing : ''}`);
}

// 2. determinism: two runs of S0b identical
{
  const a = join(tmp, 'd1.md'), b = join(tmp, 'd2.md');
  run(['--stage', 'S0b', '--spec', SPEC, '--output', a]);
  run(['--stage', 'S0b', '--spec', SPEC, '--output', b]);
  ok(readFileSync(a).equals(readFileSync(b)), 'determinism: two S0b runs identical');
}

// 3. header has source sha256; a modified MD changes it
{
  const good = join(tmp, 'h.md');
  run(['--stage', 'S1', '--spec', SPEC, '--output', good]);
  const wantHash = sha256(readFileSync(SPEC));
  ok(readFileSync(good, 'utf8').includes(`source sha256: ${wantHash}`), 'header carries real source sha256');
  // mutate a copy -> hash line must differ
  const modSpec = join(tmp, 'spec-mod.md');
  writeFileSync(modSpec, readFileSync(SPEC).toString('utf8') + '\n');
  const r2 = run(['--stage', 'S1', '--spec', modSpec, '--output', join(tmp, 'h2.md')]);
  ok(r2.code === 0 && !readFileSync(join(tmp, 'h2.md'), 'utf8').includes(`source sha256: ${wantHash}`),
     'MD change changes recorded source hash');
}

// 4. hard failures
ok(run(['--stage', 'S42', '--spec', SPEC, '--output', join(tmp, 'x.md')]).code !== 0, 'unknown stage refused');
ok(run(['--stage', 'S1', '--spec', SPEC, '--output', SPEC]).code !== 0, 'overwrite source refused');
{
  // missing section: stage ref to nonexistent 99 -> error
  const bad = readFileSync(SPEC, 'utf8').replace('**Чтение:** §3 целиком,', '**Чтение:** §99,');
  const badSpec = join(tmp, 'spec-badref.md');
  writeFileSync(badSpec, bad);
  ok(run(['--stage', 'S1', '--spec', badSpec, '--output', join(tmp, 'y.md')]).code !== 0, 'missing section ref refused');
}
{
  // malformed: unparseable ref token
  const bad = readFileSync(SPEC, 'utf8').replace('**Чтение:** §3 целиком,', '**Чтение:** §3..9,');
  const badSpec = join(tmp, 'spec-malformed.md');
  writeFileSync(badSpec, bad);
  const r = run(['--stage', 'S1', '--spec', badSpec, '--output', join(tmp, 'z.md')]);
  ok(r.code !== 0, 'malformed reference refused');
}
// Source aliases, duplicate headings, and malformed references are real
// refusal tests. The temporary source itself must survive every refusal.
for (const kind of ['symbolic','hard']) {
  const source=join(tmp,`source-${kind}.md`), alias=join(tmp,`alias-${kind}.md`);
  writeFileSync(source,readFileSync(SPEC));
  if (kind==='symbolic') symlinkSync(source,alias); else linkSync(source,alias);
  const r=run(['--stage','S1','--spec',source,'--output',alias]);
  ok(r.code!==0 && /overwrite.*alias/.test(r.out) && sha256(readFileSync(source))===specBefore,`${kind} alias cannot overwrite source`);
}
for (const [name,mut,diag] of [
 ['duplicate heading',s=>s+'\n## 5. duplicate\n',/ambiguous section/],
 ['duplicate stage',s=>s+'\n### S1. duplicate\n',/ambiguous stage/],
 ['malformed section token',s=>s.replace('**Чтение:** §3 целиком,','**Чтение:** §nonsense,'),/malformed reference/],
 ['descending mixed range',s=>s.replace('**Чтение:** §3 целиком,','**Чтение:** §8.3–5,'),/descends/],
 ['unknown nested item',s=>s.replace('**Чтение:** §3 целиком,','**Чтение:** §8.3.999,'),/unresolved reference/],
 ['missing mandatory 17.1',s=>s.replace('### 17.1.','### 17.99.'),/mandatory section §17.1 missing/],
]) {
 const source=join(tmp,`negative-${name}.md`);writeFileSync(source,mut(readFileSync(SPEC,'utf8')));
 const r=run(['--stage','S1','--spec',source,'--output',join(tmp,'negative-output.md')]);
 ok(r.code!==0 && diag.test(r.out),`${name} refused with exact diagnostic`);
}
{
 const source=join(tmp,'full-parent.md');
 writeFileSync(source,readFileSync(SPEC,'utf8').replace('**Чтение:** §3 целиком,','**Чтение:** §15, §17.1,'));
 const dest=join(tmp,'full-parent-output.md'); const r=run(['--stage','S1','--spec',source,'--output',dest]);
 const out=r.code===0 ? readFileSync(dest,'utf8') : '';
 ok(r.code===0 && STAGES.every(st=>out.split(`### ${st}.`).length===2) && out.split('### 17.1.').length===2 && out.includes('D01') && out.includes('D02'),
   'parent section includes all stages and nested sections exactly once');
}
ok(sha256(readFileSync(SPEC)) === specBefore, 'source MD unchanged by all runs');

console.log(`stage-excerpt selftests: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
