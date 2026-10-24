// SPDX-License-Identifier: GPL-2.0-or-later
// Publication requires current source/binary/runner identities, not log text.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {sha256,executionInputs,repoRoot} from './build-evidence.mjs';
const hash=p=>sha256(readFileSync(p));
export function verifyS3m(b,assembly,{readJson=p=>JSON.parse(readFileSync(p))}={}) {
 b=resolve(b);const dir=join(b,'host/s3m');
 const paths=['host-evidence.json','dss-evidence.json','arm-evidence.json'];
 const [host,exe,arm]=paths.map(p=>readJson(join(dir,p)));
 for(const e of [host,arm]) {
  assert(Object.keys(e.inputs).length>10);
  for(const [p,h]of Object.entries(e.inputs))assert.equal(hash(resolve(repoRoot,p)),h,'stale S3M input '+p);
  for(const p of ['sw/ultrags/ug_s3m.c','sw/ultrags/ug_tracker.c','sw/ultrags/ug_storage.c','sw/ultrags/ug_render.c','sw/ultrags/ug_store.c'])assert(e.inputs[join(repoRoot,p)]);
 }
 assert.equal(host.status,'HOST_PASS / REAL_PENDING');assert.equal(host.reference,'libxmp 4.7.0');
 assert(host.comparisons.length>=79 && host.comparisons.reduce((n,r)=>n+r.ticks,0)>=7408);
 assert(host.inputs[join(repoRoot,'tests/ultrags/unit/test_s3m_pitch.c')] && host.artifacts.pitch);
 for(const n of ['A','A255','D','E','F','G','H','I','J','K','L','O','Q','R','T','U','V','X','SD','SC','SE','ST300','GLISS','LOOP','FLOW','DUP','SPARSE','MEMORY','M32','S16','AMIGA0','AMIGA128'])assert(host.comparisons.some(r=>r.fixture===n+'.S3M'&&r.transport_note_volume_pan==='EXACT'));
 for(const [n,h]of Object.entries(host.artifacts))assert.equal(hash(join(dir,n)),h,'substituted S3M artifact '+n);
 assert.equal(exe.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.equal(exe.runnerSha256,hash(join(repoRoot,'tests/ultrags/dss/run-s3m.mjs')));
 assert.deepEqual(exe.assembly,assembly);assert.deepEqual(exe.inputs,executionInputs(repoRoot));
 const adapter=readJson(join(b,'native/native-card-build.json'));
 for(const [p,h]of Object.entries(adapter.inputs))assert.equal(hash(p),h);
 assert.equal(adapter.artifact,hash(join(b,'native/native-card.node')));assert.equal(exe.adapterSha256,hash(join(b,'native/native-card-build.json')));
 assert(exe.results.length>=252&&exe.results.every(r=>r.maxDiUs<10000&&r.maxWindowUs<10000));
 for(const [n,h]of Object.entries(exe.images))assert.equal(hash(join(b,'ultrags/dss',n+'.EXE')),h);
 for(const slot of [0,1])for(const iff of [0,1])for(const n of ['MOU8','STU16','M32','S16'])for(const gs of [false,true])assert(exe.results.some(r=>r.slot===slot&&r.iff===iff&&r.app==='UGPLAY'&&r.cli.startsWith(n+'.S3M')&&r.cli.includes('/GS')===gs&&r.exit===0));
 assert.equal(arm.status,'LINKED_ARM_PASS / REAL_PENDING');assert.equal(arm.results.length,6);assert(arm.sram.free_main>=16384);
 assert(arm.inputs[join(b,'multifw-release/pg-ultrags-multifw.elf')]);
 for(const n of ['MOU8','STU16']){const r=arm.results.find(r=>r.profile===n);assert(r&&r.frames===3072&&r.stack<=2048);assert.equal(r.sha256,hash(join(dir,n+'.s16le')));}
 for(const [ch,stereo,voices,fx]of [[4,false,4,2],[4,true,8,2],[32,false,32,0],[16,true,32,0]])assert(arm.results.some(r=>r.profile==='S3M/FX/OPL2'&&r.channels===ch&&r.stereo===stereo&&r.voices===voices&&r.fx_voices===fx&&r.frames>=1024&&r.stack<=2048));
 const examples=readJson(join(b,'host/docs/examples-check.json'));
 assert.deepEqual(examples.build,assembly.inputs);assert.equal(examples.runner,hash(join(repoRoot,'tools/ultrags/docs-examples-check.mjs')));
 for(const slot of [0,1])for(const iff of [0,1])for(const name of ['S3M','GSS3M']){
  const r=examples.results.find(r=>r.name===name+slot&&r.slot===slot&&r.iff===iff&&r.expected===0);
  assert(r&&r.maxDiUs<10000);assert.equal(r.sha256,hash(join(b,'host/docs/examples',r.name+'.EXE')));
 }
 for(const name of ['S3M0','S3M1','GSS3M0','GSS3M1'])for(const code of [5,21])assert(examples.results.some(r=>r.name===name&&r.expected===code));
 const stack=readJson(join(b,'s7-stack.json'));assert.equal(stack.status,'PASS');assert.equal(stack.s3m_with_reserve.length,3);assert(Math.max(...stack.s3m_with_reserve)<=2048);
 for(const [p,h]of Object.entries(stack.inputs))assert.equal(hash(p),h);
 const budgets=readJson(join(b,'host/budgets/budgets.json'));assert.equal(budgets.status,'LINKED_BUDGETS_PASS / REAL_PENDING');
 assert.equal(budgets.legacy_images.length,6);assert.equal(budgets.legacy_code_mutations_rejected,6);
 for(const [p,h]of Object.entries(budgets.inputs))assert.equal(hash(p),h);
 return {status:'HOST_PASS / REAL_PENDING',reference:host.reference,fixtures:host.comparisons.length,ticks:host.comparisons.reduce((n,r)=>n+r.ticks,0),exeCases:exe.results.length,armProfiles:arm.results.length,freeMainSRAM:arm.sram.free_main,stackWithReserve:Math.max(...stack.s3m_with_reserve),inputs:Object.fromEntries([...paths.map(p=>join(dir,p)),join(b,'host/docs/examples-check.json'),join(b,'s7-stack.json'),join(b,'host/budgets/budgets.json')].map(p=>[p,hash(p)])),limits:['Physical sound/deadline/underrun tests pending','libxmp period tolerance 0.3%, minimum one ST3 unit; inactive/disabled channel display excluded; random waveform sequence not compared','Extreme C2SPD/note combinations checked analytically; libxmp transposition limits differ']};
}
