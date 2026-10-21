// SPDX-License-Identifier: GPL-2.0-or-later
// Shared executable-proof validation for the standalone conformance report.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {verifyBuild,executionInputs,sha256,repoRoot} from './build-evidence.mjs';
const b=resolve(process.argv[2]),json=p=>JSON.parse(readFileSync(p)),hash=p=>sha256(readFileSync(p));
const assembly=verifyBuild(repoRoot,join(b,'ultrags/dss')),inputs=executionInputs(repoRoot);
const adapterPath=join(b,'native/native-card-build.json'),adapter=json(adapterPath);
assert(Object.keys(adapter.inputs).length);for(const [p,h]of Object.entries(adapter.inputs))assert.equal(hash(resolve(repoRoot,p)),h,'stale adapter '+p);
assert.equal(hash(join(b,'native/native-card.node')),adapter.artifact);
for(const [name,runner,minimum]of [['evidence/gs-exe.json','run-gs.mjs',213],['host/native/actual-exe.json','run-native.mjs',197],['evidence/f00-exe.json','run-f00.mjs',94],['evidence/s8a-exe.json','run-s8a.mjs',47]]){
 const e=json(join(b,name));assert.equal(e.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.deepEqual(e.inputs,inputs);assert.deepEqual(e.assembly,assembly);assert.equal(e.adapterSha256,hash(adapterPath));assert(e.results.length>=minimum);
 if(e.runnerSha256)assert.equal(e.runnerSha256,hash(join(repoRoot,'tests/ultrags/dss',runner)));
 else assert.equal(e.inputs['tests/ultrags/dss/'+runner],hash(join(repoRoot,'tests/ultrags/dss',runner)));
 for(const [app,v]of Object.entries(e.images))assert.equal(hash(join(b,'ultrags/dss',app+'.EXE')),typeof v==='string'?v:v.sha256);
}
const gs=json(join(b,'evidence/gs-exe.json'));
assert.equal(gs.fixtureGeneratorSha256,hash(join(repoRoot,'tools/ultrags/gen-f00.mjs')));
for(const kind of ['module','session'])assert(gs.results.some(r=>r.changeModule===kind&&r.exit===(kind==='session'?3:7)));
for(const policy of [0,1])assert(gs.results.filter(r=>r.inheritedF00===policy).length===2);
for(const cmd of ['MOD4','GS'])assert(gs.results.some(r=>r.cli===cmd+' /VERIFY'&&r.losePcmAck&&r.exit===9));
assert(gs.results.some(r=>r.app==='UGMON'&&r.text.includes('GS LOAD active')));
const s7=json(join(b,'s7-dss-evidence.json'));assert.equal(s7.status,'PASS');assert.deepEqual(s7.inputs,inputs);assert.deepEqual(s7.buildInputs,assembly.inputs);assert(s7.results.length>=82&&s7.results.every(r=>r.pass));
assert.equal(s7.sharedSha256,hash(join(b,'host/s7/s7-commands.jsonl')));assert.equal(s7.catalogSha256,hash(join(b,'host/s2-catalog.bin')));
for(const f of s7.executed)assert.equal(hash(join(b,'ultrags/dss',f.name)),f.sha256);
const low=json(join(b,'evidence/lowram-exe.json'));assert.equal(low.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');
assert.deepEqual(low.inputs,inputs);assert.deepEqual(low.assembly,assembly);assert.equal(low.adapterSha256,hash(adapterPath));
assert.equal(low.runnerSha256,hash(join(repoRoot,'tests/ultrags/dss/run-lowram.mjs')));
for(const [app,h]of Object.entries(low.images))assert.equal(hash(join(b,'ultrags/dss',app+'.EXE')),h);
assert.equal(low.results.filter(r=>r.legacy&&r.residentWrites>0&&!r.residentUnchanged).length,4);
assert.equal(low.results.filter(r=>!r.legacy&&r.residentWrites===0&&r.residentUnchanged&&!r.violations.length).length,16);
console.log('Current production adapter, native/GS/F00/S8a EXEs and S7 regressions PASS');
