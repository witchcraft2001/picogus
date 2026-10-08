#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Exercise the actual verifier/packer on isolated artifact copies. Negative
// tests require both nonzero exit and the intended diagnostic.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readZip, readFat12 } from './verify-package.mjs';
import { sha256, verifyBuild, repoRoot, executionInputs } from './build-evidence.mjs';
const arg=(flag,d)=> { const i=process.argv.indexOf(flag); return i>=0?process.argv[i+1]:d; };
const pkg=resolve(arg('--package','build/ultrags/package'));
const exe=resolve(arg('--exe-dir','build/ultrags/dss'));
const fixtures=resolve(arg('--fixtures','build/ultrags/fixtures'));
const tool=resolve(dirname(fileURLToPath(import.meta.url)),'verify-package.mjs');
const packer=join(repoRoot,'tools/ultrags/package-s0b.mjs');
const tmp=mkdtempSync(join(dirname(pkg),'package-tests-'));
const copyRoot=join(tmp,'source'), copyExe=join(tmp,'ultrags/dss'), copyPkg=join(tmp,'ultrags/package'), copyFx=join(tmp,'ultrags/fixtures');
const build=verifyBuild(repoRoot,exe);
for (const p of new Set([...Object.keys(build.inputs.sources),...Object.keys(executionInputs(repoRoot)),
  'tools/ultrags/gen-fixtures.mjs','tools/ultrags/package-s0b.mjs'])) {
  mkdirSync(dirname(join(copyRoot,p)),{recursive:true}); cpSync(join(repoRoot,p),join(copyRoot,p));
}
for (const [from,to] of [[exe,copyExe],[join(exe,'../gen'),join(copyExe,'../gen')],
  [join(exe,'../logs'),join(copyExe,'../logs')],[pkg,copyPkg],[fixtures,copyFx]]) cpSync(from,to,{recursive:true});
const args=['--package',copyPkg,'--exe-dir',copyExe,'--fixtures',copyFx,'--repo',copyRoot];
function run(script,args_) {
  const r=spawnSync(process.execPath,[script,...args_],{encoding:'utf8'});
  if (r.error) throw r.error;
  return {status:r.status,text:r.stdout+r.stderr};
}
let pass=0;
function passed(name) { pass++; console.log(`PASS ${name}`); }
const base=run(tool,args); assert.equal(base.status,0,base.text); passed('actual verifier accepts fresh executed package');
function mutate(name,path,change,diagnostic) {
  const before=readFileSync(path);
  try {
    writeFileSync(path,change(Buffer.from(before)));
    const r=run(tool,args);
    assert.notEqual(r.status,0,`${name}: accepted`);
    assert.match(r.text,diagnostic,`${name}: wrong defect`);
    passed(name);
  } finally {writeFileSync(path,before);}
}
const append=b=>Buffer.concat([b,Buffer.from('\n; review mutation\n')]);
const source=join(copyRoot,'host/sprinter/ultrags/lib/ugproto.asm');
mutate('source drift rejected before stale EXE acceptance',source,append,/stale assembly inputs/);
mutate('schema drift rejected',join(copyRoot,'tools/ultrags/wire-schema.json'),b=>Buffer.concat([b,Buffer.from('\n')]),/stale assembly inputs/);
mutate('generator drift rejected',join(copyRoot,'tools/ultrags/gen-wire.mjs'),append,/stale assembly inputs/);
mutate('generated ASM drift rejected',join(copyExe,'../gen/ug_wire.inc'),append,/stale assembly inputs/);
mutate('substituted EXE rejected',join(copyExe,'UGDIAG.EXE'),b=>{b[130]^=255;return b;},/stale\/substituted EXE/);
mutate('harness drift invalidates execution',join(copyRoot,'tests/ultrags/dss/ug-harness.mjs'),append,/stale execution inputs/);
mutate('failed execution evidence rejected',join(copyExe,'../logs/ugdiag-run.json'),b=>{
 const e=JSON.parse(b);e.fail=1;return JSON.stringify(e);},/execution evidence contains failed/);
mutate('executed self-test hash mismatch rejected',join(copyExe,'../logs/ugdiag-run.json'),b=>{
 const e=JSON.parse(b);e.executed[1].sha256='0'.repeat(64);return JSON.stringify(e);},/executed EXE hashes\/set differ/);
mutate('fixture generator drift rejected',join(copyRoot,'tools/ultrags/gen-fixtures.mjs'),append,/stale fixture generator inputs/);
mutate('packer drift rejected',join(copyRoot,'tools/ultrags/package-s0b.mjs'),append,/FAIL source\/build\/execution\/package provenance/);
mutate('IMG tamper rejected by actual verifier',join(copyPkg,'ug-s0b.img'),b=>{b[33*512+17]^=255;return b;},/FAIL img sha256/);
mutate('ZIP tamper rejected by actual verifier',join(copyPkg,'ug-s0b.zip'),b=>{b[50]^=255;return b;},/FAIL zip sha256|CRC mismatch|local\/central mismatch/);
// Independently forged filesystem metadata must also be structurally rejected.
const img=readFileSync(join(pkg,'ug-s0b.img'));
const signature=Buffer.from(img); signature[510]=0;
assert.throws(()=>readFat12(signature),/missing boot signature/); passed('FAT12 boot signature enforced');
const second=Buffer.from(img); second[10*512+100]^=1;
assert.throws(()=>readFat12(second),/FAT copies differ/); passed('both FAT copies enforced');
const cycle=Buffer.from(img); cycle[512+3]=2; cycle[512+4]&=0xF0;
cycle.copy(cycle,10*512,512,10*512);
assert.throws(()=>readFat12(cycle),/FAT chain/); passed('cyclic/truncated FAT chain rejected');
const zip=readFileSync(join(pkg,'ug-s0b.zip'));
const badZip=Buffer.from(zip); badZip[14]^=1;
assert.throws(()=>readZip(badZip),/local\/central mismatch/); passed('ZIP local and central headers must agree');
const repeat=join(tmp,'repeat');
const rerun=run(packer,['--exe-dir',exe,'--fixtures',fixtures,'--out',repeat]);
assert.equal(rerun.status,0,rerun.text);
for (const name of ['ug-s0b.zip','ug-s0b.img','package-manifest.json'])
  assert.deepEqual(readFileSync(join(pkg,name)),readFileSync(join(repeat,name)),`${name}: not reproducible`);
passed('independent second pack produces identical ZIP/IMG/manifest bytes');
console.log(`package tests: ${pass} pass, 0 fail`);
