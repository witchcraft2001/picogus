// SPDX-License-Identifier: GPL-2.0-or-later
// S8c adds to the R17/S8b gates; it never replaces their proofs.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {sha256,executionInputs,repoRoot} from './build-evidence.mjs';
const hash=p=>sha256(readFileSync(p)),json=p=>JSON.parse(readFileSync(p));
function current(e){assert(Object.keys(e.inputs??{}).length);for(const[p,h]of Object.entries(e.inputs))assert.equal(hash(resolve(repoRoot,p)),h,'stale S8c proof '+p);}
export function verifyS8c(b,assembly){
 const paths=['host/s8c/host-evidence.json','host/s8c-performance/comparison.json','evidence/actual-exe.json','evidence/actual-exe-fast.json','evidence/stream-arm.json'];
 const [host,performance,standard,fast,arm]=paths.map(p=>json(join(b,p)));
 current(host);assert.equal(host.status,'HOST_PASS / REAL_PENDING');
 for(const name of ['stream','stream-storage']){
  assert(host.commands[name].includes('-fsanitize=undefined'));
  assert(host.artifacts[name]&&host.artifacts[name+'.log']);
 }
 for(const[p,h]of Object.entries(host.artifacts))assert.equal(hash(join(b,'host/s8c',p)),h);
 for(const [run,exe]of [[standard,'UGPLAY.EXE'],[fast,'UGPF.EXE']]){
  assert.equal(run.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.deepEqual(run.assembly,assembly);assert.deepEqual(run.inputs,executionInputs(repoRoot));
  assert.equal(run.runnerSha256,hash(join(repoRoot,'tests/ultrags/dss/run-stream.mjs')));
  assert.equal(run.exeSha256,hash(join(b,'ultrags/dss',exe)));assert.equal(run.adapterSha256,hash(join(b,'native/native-card.node')));
  assert(run.results.length>=210);
  assert(run.results.some(r=>r.immediate&&r.feedClockCalls===0&&r.exit===0));
  assert(run.results.some(r=>r.loseClose&&r.exit===8&&r.feedPackets===1));
  assert(run.results.every(r=>r.residentWrites===0&&r.minSp>=0xbd90&&r.exitSP===0xbffc&&r.maxDiUs<10000&&r.maxWindowUs<10000&&r.maxServiceBytes<=32));
  for(const slot of [0,1])for(const iff of [0,1])for(const turbo of [false,true])assert(run.results.some(r=>r.cli.includes('/BENCH:ALL')&&r.slot===slot&&r.iff===iff&&r.turbo===turbo&&r.exit===0&&r.text.includes('BENCH PIPE')));
  for(const clock of [false,true]){
   assert(run.results.some(r=>r.stallGrant&&r.clock===clock&&r.exit===3&&r.feedPackets===1));
   assert(run.results.some(r=>r.stallAck&&r.clock===clock&&r.exit===0));
  }
  assert(run.results.some(r=>r.changeSession&&r.exit===3&&r.feedPackets===1));
  assert(run.results.some(r=>r.payloadBytes===6148&&r.cli.includes('/VERIFY')));
  assert(run.results.some(r=>r.cli.includes('/BENCH:PIPE')&&r.payloadBytes===1048576));
 }
 assert(standard.results.some(r=>r.payloadBytes>8388608),'missing larger-than-PSRAM actual EXE');
 current(arm);assert.equal(arm.status,'LINKED_ARM_STREAM_PASS / REAL_PENDING');assert.equal(arm.results.length,12);
 current(performance);assert.equal(performance.status,'HOST_PERFORMANCE_PASS / REAL_PENDING');assert(performance.baseline.startsWith('94447e0'));
 for(const p of ['tools/ultrags/s8c-performance.py','tests/ultrags/dss/run-stream.mjs'])assert.equal(performance.inputs[join(repoRoot,p)],hash(join(repoRoot,p)));
 for(const name of ['UGPLAY.EXE','UGPF.EXE'])assert.equal(performance.inputs[resolve(b,'ultrags/dss',name)],hash(join(b,'ultrags/dss',name)));
 assert.equal(performance.results.length,8);
 for(const [profile,exe]of [['standard','UGPLAY.EXE'],['fast','UGPF.EXE']]){
  const pipe=performance.pipe[profile];assert.equal(pipe.bytes,131072);assert(pipe.delta_frames>=6000);
  assert.equal(pipe.Bps,Math.floor(pipe.bytes*48000/pipe.delta_frames));
  assert.equal(pipe.exeSha256,hash(join(b,'ultrags/dss',exe)));
  assert.equal(pipe.Bps>=220500,profile==='fast');
 }
 for(const r of performance.results){
  assert.equal(r.before.payloadBytes,r.after.payloadBytes);
  for(const k of ['payloadReads','clockCalls','dssCalls','windowCount','elapsedTicks'])assert(r.after[k]<r.before[k]);
  if(r.after.payloadBytes===131072){assert(r.after.steps<r.before.steps);assert(r.after.z80Tstates<r.before.z80Tstates);assert(r.after.z80Ticks21MHz<r.before.z80Ticks21MHz);}
  if(r.profile==='fast'&&r.after.payloadBytes===131072)assert(r.after.modeledBytesPerSecond>=220500);
 }
 return {status:'HOST_PASS / REAL_PENDING',scope:'Host instruction/disk model only; previous S8c REAL_FAIL retained',
  cases:[standard.results.length,fast.results.length],maxDiUs:Math.max(...standard.results.map(r=>r.maxDiUs),...fast.results.map(r=>r.maxDiUs)),
  performance:performance.results,pipe:performance.pipe,inputs:Object.fromEntries([...paths.map(p=>resolve(b,p)),join(repoRoot,'tools/ultrags/s8c-evidence.mjs'),join(repoRoot,'host/sprinter/ultrags/docs/S8C-README.md')].map(p=>[p,hash(p)]))};
}
