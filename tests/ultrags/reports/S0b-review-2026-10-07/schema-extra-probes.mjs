// SPDX-License-Identifier: GPL-2.0-or-later
// Independent review probes. Expected diagnostics are explicit and separate
// from the implementation's own negative-schema tests.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(process.argv[2] || '.');
const out = resolve(process.argv[3] || 'build/ultrags/evidence/S0b/schema-extra');
mkdirSync(out, { recursive: true });
const source = JSON.parse(readFileSync(join(root, 'tools/ultrags/wire-schema.json')));
const cases = [
  ['crc-fraction', s => { s.crc.poly = 0.5; }, /crc.*(?:integer|numeric|range)/i],
  ['crc-overflow', s => { s.crc.init = '0x100000000'; }, /crc.*range/i],
  ['crc-reflection-type', s => { s.crc.refin = 'true'; }, /crc\.refin.*(?:boolean|true|reflection|unsupported)/i],
  ['verified-middle', s => {
    const st = s.structs.WRITE_BEGIN_REQ;
    const i = st.fields.findIndex(f => f.verifiedOnly);
    st.fields.unshift(st.fields.splice(i, 1)[0]);
  }, /verified.*(?:trailing|last|position|suffix)/i],
];
const results = cases.map(([name, mutate, diagnostic]) => {
  const s = structuredClone(source); mutate(s);
  const file = join(out, `${name}.json`); writeFileSync(file, JSON.stringify(s));
  const run = spawnSync(process.execPath, [join(root, 'tools/ultrags/gen-wire.mjs'), file, join(out, name)], { encoding: 'utf8' });
  const text = run.stdout + run.stderr;
  return { name, exit: run.status, expected: String(diagnostic), rejectedAsExpected: run.status !== 0 && diagnostic.test(text), output: text };
});
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
for (const r of results) console.log(`${r.rejectedAsExpected ? 'PASS' : 'FAIL'} ${r.name}: exit=${r.exit}`);
process.exit(results.every(r => r.rejectedAsExpected) ? 0 : 1);
