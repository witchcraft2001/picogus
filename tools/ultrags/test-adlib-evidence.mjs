// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {verifyBuild,sha256,repoRoot} from './build-evidence.mjs';
import {verifyAdlib} from './adlib-evidence.mjs';
const b=resolve(process.argv[2]??'build'),dir=join(b,'host/adlib'),assembly=verifyBuild(repoRoot,join(b,'ultrags/dss'));
const hash=p=>sha256(readFileSync(p));
const positive=verifyAdlib(b,assembly),cases=[];
for(const [name,file,mutate]of [
 ['missing host proof','host-evidence.json',()=>{throw Error('missing proof');}],
 ['wrong status','host-evidence.json',e=>e.status='PENDING'],
 ['stale source','host-evidence.json',e=>e.inputs[join(repoRoot,'sw/ultrags/ug_opl.c')]='0'.repeat(64)],
 ['stale vector','host-evidence.json',e=>e.artifacts['vectors.s32le']='0'.repeat(64)],
 ['missing ELF binding','arm-evidence.json',e=>delete e.inputs[join(b,'multifw-release/pg-ultrags-multifw.elf')]],
 ['stale ELF','arm-evidence.json',e=>e.inputs[join(b,'multifw-release/pg-ultrags-multifw.elf')]='0'.repeat(64)],
 ['missing waveform','arm-evidence.json',e=>e.results.pop()],
 ['missing stereo MIX','arm-evidence.json',e=>e.mixed=e.mixed.filter(r=>r.fx_channels!==2)],
 ['wrong PCM','arm-evidence.json',e=>e.results[0].sha256='0'.repeat(64)],
 ['stale EXE','exe-evidence.json',e=>e.exe='0'.repeat(64)],
 ['stale adapter','exe-evidence.json',e=>e.adapter='0'.repeat(64)],
 ['long DI','exe-evidence.json',e=>e.results[0].maxDiUs=10000],
 ['resident corruption','exe-evidence.json',e=>e.results[0].residentWrites=1],
 ['missing slot','exe-evidence.json',e=>e.results=e.results.filter(r=>r.slot!==1)],
 ['missing dirty FM start','exe-evidence.json',e=>e.results.forEach(r=>r.dirty=false)],
 ['missing late MIX error','exe-evidence.json',e=>e.results.forEach(r=>r.statsErrorAfter=null)],
 ['missing timer failure diagnostics','exe-evidence.json',e=>e.results.forEach(r=>r.timerFault=null)],
 ['missing OPEN diagnostics','exe-evidence.json',e=>e.results.forEach(r=>r.openFault=null)],
 ['missing CAPS diagnostics','exe-evidence.json',e=>e.results.forEach(r=>r.caps=null)],
 ['missing INFO/CAPS CRC rejection','exe-evidence.json',e=>e.results.forEach(r=>r.corruptOpcode=null)],
 ['missing read reply proof','read-linked.json',()=>{throw Error('missing proof');}],
 ['missing scalar linked lane coverage','read-linked.json',e=>e.scalarCases=256],
 ['slow scalar getter','read-linked.json',e=>e.scalarInstructionsThroughFIFO=99],
 ['timer work before reply','read-linked.json',e=>e.noTimerOrCallsBeforeFIFO=false],
 ['FWSTRING pre-consume','read-linked.json',e=>e.streamAdvanceAfterFIFO=false],
 ['unverified legacy backend','legacy/evidence.json',e=>e.results[0].status='PENDING'],
]) {
 assert.throws(()=>verifyAdlib(b,assembly,{readJson:p=>{const e=JSON.parse(readFileSync(p));if(p===join(dir,file))mutate(e);return e;}}),undefined,name);
 cases.push(name);
}
writeFileSync(join(dir,'evidence-negative.json'),JSON.stringify({status:'PASS',cases,positive,checkerSha256:hash(new URL(import.meta.url)),gateSha256:hash(join(repoRoot,'tools/ultrags/adlib-evidence.mjs'))},null,2)+'\n');
console.log('AdLib fresh evidence PASS; '+cases.length+' missing/stale/corrupt controls rejected');
