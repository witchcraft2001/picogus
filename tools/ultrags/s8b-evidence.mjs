// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {sha256,executionInputs,repoRoot} from './build-evidence.mjs';
const hash=p=>sha256(readFileSync(p)),json=p=>JSON.parse(readFileSync(p));
export function verifyS8b(b,assembly){
 const paths=['host/s8b/host-evidence.json','host/s8b/fixtures/fixtures.json','evidence/s8b-exe.json','evidence/s8b-arm.json'];
 const [host,fixtures,exe,arm]=paths.map(p=>json(join(b,p)));
 for(const e of [host,arm]){assert(Object.keys(e.inputs).length);for(const[p,h]of Object.entries(e.inputs))assert.equal(hash(resolve(repoRoot,p)),h,'stale S8b input '+p);}
 assert.equal(host.status,'HOST_PASS / REAL_PENDING');for(const name of ['flt4','flt4-storage','flt8','flt8-storage','flt8-tail-storage','multimod','multimod-storage'])assert(host.commands[name],name);
 for(const[n,h]of Object.entries(host.artifacts))assert.equal(hash(join(b,'host/s8b',n)),h);
 assert.equal(fixtures.generatorSha256,hash(join(repoRoot,'tools/ultrags/gen-s8b.mjs')));
 for(const f of fixtures.files)assert.equal(hash(join(b,'host/s8b/fixtures',f.name)),f.sha256);
 assert.equal(exe.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.deepEqual(exe.assembly,assembly);assert.deepEqual(exe.inputs,executionInputs(repoRoot));
 assert.equal(exe.runnerSha256,hash(join(repoRoot,'tests/ultrags/dss/run-s8b.mjs')));
 assert.equal(exe.adapterSha256,hash(join(b,'native/native-card-build.json')));
 assert.equal(exe.fixtureSha256,hash(join(b,'host/s8b/fixtures/FLT8.MOD')));
 for(const[p,h]of Object.entries(exe.additionalFiles))assert.equal(hash(p),h,'stale additional module');
 for(const[n,h]of Object.entries(exe.images))assert.equal(hash(join(b,'ultrags/dss',n+'.EXE')),h);
 assert(exe.results.length>=40);assert(exe.results.every(r=>r.residentWrites===0&&r.exitSP===0xbffc&&r.minSp>=0xbd90));
 for(const slot of [0,1])for(const iff of [0,1])for(const turbo of [false,true])assert(exe.results.some(r=>r.app==='UGTEST'&&r.exit===0&&r.slot===slot&&r.iff===iff&&r.turbo===turbo&&r.checkedRead>=7484));
 for(const code of [1,4,6,8,9,10])assert(exe.results.some(r=>r.exit===code));
 assert(exe.results.some(r=>r.app==='UGPLAY'&&r.cli.includes('/WAIT')&&r.exit===0));
 assert(exe.results.some(r=>r.app==='UGPLAY'&&r.cli.includes('/GS')&&r.exit===0));
 assert.equal(arm.status,'LINKED_ARM_FLT8_PASS / REAL_PENDING');assert.equal(arm.results.length,4);
 for(const ch of [1,2])for(const loop of [4,128])assert(arm.results.some(r=>r.fx_channels===ch&&r.loop_bytes===loop&&r.orders===6&&r.exact_frames===4608&&r.observed_stack<=2048));
 assert.equal(arm.extended.length,16);
 const tailPath=resolve(b,'host/s8b/fixtures/FLT8TAIL.MOD');
 assert(arm.tails.some(t=>t.path===tailPath&&t.bytes===23868&&t.render_frames===3072&&t.observed_stack<=2048));
 assert.equal(exe.additionalFiles[tailPath],hash(tailPath));
 for(const t of arm.tails){assert.equal(hash(t.path),t.sha256);assert(t.render_frames>=3072&&t.observed_stack<=2048);}
 if(host.commands['gidion-storage']){
  const path='host/s8b/flt8-reference.json',ref=json(join(b,path));paths.push(path);
  assert.equal(ref.status,'HOST_PASS / REAL_PENDING');assert(ref.ticks_compared>0&&ref.order_row_tick_speed_bpm==='EXACT');
  assert.equal(hash(ref.path),ref.original_sha256);assert.equal(exe.additionalFiles[ref.path],ref.original_sha256);
  assert(arm.tails.some(t=>t.path===ref.path&&t.sha256===ref.original_sha256));
  for(const[p,h]of Object.entries(ref.inputs))assert.equal(hash(p),h);
  for(const[p,h]of Object.entries(ref.artifacts))assert.equal(hash(join(b,'host/s8b',p)),h);
  for(const slot of [0,1])for(const iff of [0,1])for(const gs of [false,true])assert(exe.results.some(r=>r.app==='UGPLAY'&&r.cli.startsWith('GIDION.MOD ')&&r.cli.includes('/GS')===gs&&r.exit===0&&r.slot===slot&&r.iff===iff));
 }
 for(const [signature,channels,file]of [['FLT4',4,'FLT4.MOD'],['28CH',28,'MOD28.MOD'],['31CH',31,'MOD31.MOD'],['32CH',32,'MOD32.MOD']]){
  for(const fx of [1,2])for(const loop of [4,128])assert(arm.extended.some(r=>r.signature===signature&&r.channels===channels&&r.fx_channels===fx&&r.loop_bytes===loop&&r.exact_frames===1536&&r.observed_stack<=2048&&r.fx_voices+channels<=32));
  assert(exe.additionalFiles[resolve(b,'host/s8b/fixtures',file)]);
  for(const slot of [0,1])for(const iff of [0,1])for(const gs of [false,true])assert(exe.results.some(r=>r.app==='UGPLAY'&&r.cli.startsWith(file+' ')&&r.cli.includes('/GS')===gs&&r.exit===0&&r.slot===slot&&r.iff===iff));
 }
 if(host.commands.dope){
  assert(host.commands['dope-audio'] && host.commands['dope-storage'] && arm.real && arm.real.render_frames>=3072);
  assert.equal(hash(arm.real.path),arm.real.sha256);assert.equal(exe.additionalFiles[arm.real.path],arm.real.sha256);
  assert(exe.results.some(r=>r.app==='UGPLAY'&&r.cli.startsWith('DOPE.MOD /WAIT')&&r.exit===10));
  for(const slot of [0,1])for(const iff of [0,1])for(const gs of [false,true])assert(exe.results.some(r=>r.app==='UGPLAY'&&r.cli.startsWith('DOPE.MOD ')&&r.cli.includes('/GS')===gs&&r.exit===0&&r.slot===slot&&r.iff===iff));
  const path='host/s8b/multimod-reference.json',ref=json(join(b,path));paths.push(path);
  assert.equal(ref.status,'HOST_PASS / REAL_PENDING');assert.equal(ref.original_sha256,arm.real.sha256);
  assert(ref.ticks_compared>0 && ref.order_row_tick_speed_bpm==='EXACT');
  for(const[p,h]of Object.entries(ref.inputs))assert.equal(hash(p),h);
  for(const[p,h]of Object.entries(ref.artifacts))assert.equal(hash(join(b,'host/s8b',p)),h);
 }
 assert(arm.inputs[resolve(b,'multifw-release/pg-ultrags-multifw.elf')]);assert(arm.inputs[resolve(b,'multifw-release/picogus.uf2')]);
 return {status:'HOST_PASS / REAL_PENDING',exeCases:exe.results.length,armProfiles:arm.results.length+arm.extended.length,original:arm.real?.sha256??null,inputs:Object.fromEntries(paths.map(p=>[resolve(b,p),hash(join(b,p))]))};
}
