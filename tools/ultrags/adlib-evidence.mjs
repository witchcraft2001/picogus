// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {sha256,executionInputs,repoRoot} from './build-evidence.mjs';
const hash=p=>sha256(readFileSync(p));
export function verifyAdlib(b,assembly,{readJson=p=>JSON.parse(readFileSync(p))}={}) {
 b=resolve(b);const dir=join(b,'host/adlib');
 const paths=['host-evidence.json','arm-evidence.json','exe-evidence.json','legacy/evidence.json','read-linked.json'];
 const [host,arm,exe,legacy,reads]=paths.map(p=>readJson(join(dir,p)));
 for(const e of [host,arm,legacy,reads]) {
  assert(Object.keys(e.inputs).length>5);
  for(const [p,h] of Object.entries(e.inputs))assert.equal(hash(resolve(repoRoot,p)),h,'stale AdLib input '+p);
 }
 assert.equal(host.status,'HOST_PASS / REAL_PENDING');
 assert.equal(reads.status,'LINKED_READ_REPLY_PASS / REAL_PENDING');assert.equal(resolve(reads.build),b);
 assert(reads.inputs[join(b,'multifw-release/pg-ultrags-multifw.elf')]);
 assert(reads.inputs[join(repoRoot,'tools/ultrags/adlib-read-linked.py')]);
 assert.equal(reads.oplCases,256);assert(reads.fwstringCases>=280);
 assert.equal(reads.scalarCases,512);assert.equal(reads.scalarInstructionsThroughFIFO,8);
 // R3 uses the PIO-held OPL reply; match the executed R3 spans exactly.
 assert.equal(reads.oplInstructionsThroughFIFO,9);assert.equal(reads.fwstringInstructionsThroughFIFO,14);
 assert(reads.noTimerOrCallsBeforeFIFO&&reads.completionAfterFIFO&&reads.streamAdvanceAfterFIFO);
 for(const p of ['tests/ultrags/unit/test_adlib.c','sw/ultrags/ug_opl.c','sw/opl/emu8950.c','tools/ultrags/adlib-host.py','tools/ultrags/adlib_inputs.py'])assert(host.inputs[join(repoRoot,p)]);
 for(const name of ['adlib-test','vectors.s32le','release.s32le'])assert.equal(host.artifacts[name],hash(join(dir,name)));
 const vectors=readFileSync(join(dir,'vectors.s32le'));assert.equal(vectors.length,19*51200);
 assert.equal(arm.status,'LINKED_ARM_PASS / REAL_PENDING');
 for(const p of [join(b,'multifw-release/pg-ultrags-multifw.elf'),join(repoRoot,'tools/ultrags/adlib-arm.py'),join(dir,'vectors.s32le')])assert(arm.inputs[p]);
 assert.equal(arm.results.length,19);
 for(let profile=0;profile<19;profile++) {
  const r=arm.results.find(r=>r.profile===profile);assert(r&&r.frames===1024&&r.stack<=2048&&r.interp_reads>0);
  assert.equal(r.sha256,sha256(vectors.subarray(profile*51200,profile*51200+4096)));
 }
 assert.equal(arm.release.frames,1024);assert(arm.release.idle);assert.equal(arm.release.sha256,hash(join(dir,'release.s32le')));
 assert.equal(arm.mixed.length,6);
 for(const ch of [8,32])for(const fx of ch===8?[1,2]:[1])for(const rhythm of [false,true]) {
  const r=arm.mixed.find(r=>r.mod_channels===ch&&r.fx_channels===fx&&r.rhythm===rhythm);
  assert(r&&r.exact_frames>=3712&&r.observed_stack<=2048&&r.worst_quantum_instructions>0);
  assert.equal(r.fx_instances,ch===8?4/fx:0);
 }
 assert.equal(exe.status,'ACTUAL_EXE_PASS / REAL_PENDING');assert.deepEqual(exe.assembly,assembly);assert.deepEqual(exe.inputs,executionInputs(repoRoot));
 assert.equal(exe.runner,hash(join(repoRoot,'tests/ultrags/dss/run-adlib.mjs')));
 assert.equal(exe.exe,hash(join(b,'ultrags/dss/UGOPL.EXE')));
 const adapter=readJson(join(b,'native/native-card-build.json'));assert(adapter.adlib);
 for(const [p,h]of Object.entries(adapter.inputs))assert.equal(hash(p),h);
 assert.equal(adapter.artifact,hash(join(b,'native/native-card.node')));assert.equal(exe.adapter,hash(join(b,'native/native-card-build.json')));
 assert(exe.results.length>=84);assert(exe.results.every(r=>r.residentWrites===0&&r.maxDiUs<2000&&r.maxWindowUs<2000));
 for(const slot of [0,1])for(const iff of [0,1])for(const turbo of ['ON','OFF'])for(const command of ['TEST','MIX /FX:MONO','MIX /FX:STEREO'])assert(exe.results.some(r=>r.slot===slot&&r.iff===iff&&r.cli.startsWith(command+' ' )&&r.cli.includes('/TURBO:'+turbo)&&r.exit===0));
 for(const code of [1,4,7,8,9,10])assert(exe.results.some(r=>r.exit===code));
 for(const statsError of [28,36,40])assert(exe.results.some(r=>r.statsError===statsError&&r.exit===9));
 for(const statsError of [28,36,40])assert(exe.results.some(r=>r.statsError===statsError&&r.statsErrorAfter===2&&r.statsReads>=3&&r.exit===9));
 for(const slot of [0,1])for(const command of ['TEST','MIX /FX:MONO','MIX /FX:STEREO'])assert(exe.results.some(r=>r.dirty&&r.slot===slot&&r.cli.startsWith(command+' ')&&r.exit===0));
 for(const statsMax of [2667,2668,65536])assert(exe.results.some(r=>r.statsMax===statsMax&&r.exit===(statsMax<=2667?0:7)));
 for(const timerFault of [1,2,3])for(const turbo of ['ON','OFF'])assert(exe.results.some(r=>r.timerFault===timerFault&&r.cli.includes('/TURBO:'+turbo)&&r.exit===9&&r.text.includes('OPL TIMER stage=0'+timerFault)));
 for(const slot of [0,1]){
  for(const openFault of ['magic','protocol','active','major','minor'])assert(exe.results.some(r=>r.slot===slot&&r.openFault===openFault&&r.exit===3&&r.fmWrites===0&&r.text.includes('OPL OPEN stage=')));
  for(const caps of [128,8192])assert(exe.results.some(r=>r.slot===slot&&r.caps===caps&&r.exit===3&&r.fmWrites===0&&r.text.includes(caps===128?'ADLIB_CAP_MISSING':'MEMORY_CAP_MISSING')));
  for(const corruptOpcode of [0,1])assert(exe.results.some(r=>r.slot===slot&&r.corruptOpcode===corruptOpcode&&r.exit===9&&r.fmWrites===0&&r.text.includes('NATIVE_FRAME_CRC')));
 }
 assert.equal(legacy.resources.tll_base.bytes,1024);assert.equal(legacy.resources.queue.bytes,520);
 assert.equal(legacy.status,'LEGACY_OPL_BACKENDS_EXACT');assert.equal(legacy.base,'7877c4e');assert.equal(legacy.results.length,5);assert(legacy.results.every(r=>r.status==='EXACT'));
 return {status:'HOST_PASS / REAL_PENDING',oplProfiles:19,mixProfiles:6,exeCases:exe.results.length,maxDiUs:Math.max(...exe.results.map(r=>r.maxDiUs)),inputs:Object.fromEntries(paths.map(p=>[join(dir,p),hash(join(dir,p))])),limits:['Previous AdLib read/test REAL_FAIL retained; new candidate REAL_PENDING. Functional ARM interpolator/PSRAM and Z80/DSS models; physical sound, deadlines and electrical timing pending; S8c REAL_FAIL retained']};
}
