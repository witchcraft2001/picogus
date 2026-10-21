// SPDX-License-Identifier: GPL-2.0-or-later
// Freeze byte-identical independently built firmware/EXEs and executed evidence.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync,lstatSync,symlinkSync,renameSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyBuild,verifyExecution,sha256,repoRoot,executionInputs} from './build-evidence.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
import {readZip,readFat12} from './verify-package.mjs';
const buildRoot=join(repoRoot,'build');
const a=resolve(process.argv[2]??buildRoot),b=resolve(process.argv[3]??join(buildRoot,'reproducibility')),out=resolve(process.argv[4]??buildRoot);
assert.equal(out,buildRoot,'deliver current artifacts directly to build/');
assert.notEqual(a,b,'independent build directories required');
function currentInputs(e){for(const [p,h]of Object.entries(e.inputs??{}))assert.equal(sha256(readFileSync(p)),h,'stale proof '+p);}
const asm=[a,b].map(x=>verifyBuild(repoRoot,join(x,'ultrags/dss')));assert.deepEqual(asm[0].files,asm[1].files);
const execution=verifyExecution(repoRoot,join(a,'ultrags/dss'));
execFileSync('python3',[join(repoRoot,'tools/ultrags/compat-linked.py'),a,b],{stdio:'pipe'});
const fw=readFileSync(join(a,'multifw-release/picogus.uf2'));assert.deepEqual(fw,readFileSync(join(b,'multifw-release/picogus.uf2')));
const proofs=[];
for(const build of [a,b]){
 const fast=JSON.parse(readFileSync(join(build,'ultrags/dss/fast-asm.json')));currentInputs(fast);assert.equal(sha256(readFileSync(join(build,'ultrags/dss/UGPF.EXE'))),fast.sha256);
 const host=JSON.parse(readFileSync(join(build,'host/s8c/host-evidence.json')));assert.equal(host.status,'HOST_PASS / REAL_PENDING');currentInputs(host);
 for(const [p,h]of Object.entries(host.artifacts))assert.equal(sha256(readFileSync(join(build,'host/s8c',p))),h,'stale unit artifact '+p);
 const runs=['actual-exe','actual-exe-fast'].map(name=>{
  const e=JSON.parse(readFileSync(join(build,'evidence',name+'.json'))),exe=name==='actual-exe'?'UGPLAY.EXE':'UGPF.EXE';
  assert.equal(e.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.equal(e.runnerSha256,sha256(readFileSync(join(repoRoot,'tests/ultrags/dss/run-stream.mjs'))));assert.equal(e.exeSha256,sha256(readFileSync(join(build,'ultrags/dss',exe))));
  assert.deepEqual(e.inputs,executionInputs(repoRoot));assert.deepEqual(e.assembly.inputs,asm[build===a?0:1].inputs);
  assert(e.results.length>=39);assert(e.results.every(x=>x.maxDiUs<10000));return e;
 });
 proofs.push({build,host,runs,fast});
}
assert.equal(proofs[0].fast.sha256,proofs[1].fast.sha256);
assert(proofs[0].runs[0].results.some(x=>x.payloadBytes>8388608),'missing file larger than PSRAM');
const arm=JSON.parse(readFileSync(join(a,'evidence/stream-arm.json')));assert.equal(arm.status,'LINKED_ARM_STREAM_PASS / REAL_PENDING');currentInputs(arm);assert.equal(arm.results.length,12);
const budget=JSON.parse(readFileSync(join(a,'host/budgets/budgets.json'))),stack=JSON.parse(readFileSync(join(a,'s7-stack.json')));
currentInputs(budget);currentInputs(stack);assert(budget.sram['pg-ultrags'].free_main>=16384);assert(stack.stream_with_reserve<=2048);
const baseSpeed=proofs[0].runs[0].results.find(x=>x.payloadBytes===131072),fastSpeed=proofs[0].runs[1].results.find(x=>x.payloadBytes===131072);
assert(baseSpeed.modeledBytesPerSecond<220500);assert(fastSpeed.modeledBytesPerSecond>=220500);
const preservedDiagnostics=[];
const payload=new Map(asm[0].files.filter(x=>!x.name.startsWith('ST-')).map(x=>[x.name,readFileSync(join(a,'ultrags/dss',x.name))]));
const prior=resolve(process.argv[5]??join(buildRoot,'gs-clock-d4-delivery'));
if(process.argv[5]||existsSync(join(prior,'D4.json'))){
 const frozen=JSON.parse(readFileSync(join(prior,'D4.json')));
 for(const name of ['UGGS0.EXE','UGGS1.EXE','UGGSC0.EXE','UGGSC1.EXE']){
  const bytes=readFileSync(join(prior,name));assert.equal(sha256(bytes),frozen.files[name].sha256);payload.set(name,bytes);
  preservedDiagnostics.push({name,prior,sha256:sha256(bytes),scope:'Preserved prior diagnostic, not a new S8c acceptance claim'});
 }
}
payload.set('UGPF.EXE',readFileSync(join(a,'ultrags/dss/UGPF.EXE')));
payload.set('TESTER.TXT',readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/S8C-README.md')));
// Small deterministic stereo ramp for a quick smoke check; long files are user supplied.
const data=Buffer.alloc(44100*4);for(let i=0;i<44100;i++){data.writeInt16LE((i*73)%30000-15000,i*4);data.writeInt16LE(15000-(i*31)%30000,i*4+2);}
const wave=Buffer.alloc(44+data.length);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(2,22);wave.writeUInt32LE(44100,24);wave.writeUInt32LE(176400,28);wave.writeUInt16LE(4,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(data.length,40);data.copy(wave,44);payload.set('PCM441.WAV',wave);
const clipsPath=join(buildRoot,'s8c-test-audio/original-clips.json');
const clips=JSON.parse(readFileSync(clipsPath));
assert.equal(clips.status,'SOURCE_PCM_UNCHANGED / REAL_PENDING');
assert.equal(clips.generator_sha256,sha256(readFileSync(join(repoRoot,'tools/ultrags/s8c-clips.py'))));
assert.equal(clips.clips.length,2);
for(const clip of clips.clips){
 const bytes=readFileSync(join(buildRoot,'s8c-test-audio',clip.name));
 assert.equal(sha256(bytes),clip.sha256);assert.equal(sha256(readFileSync(clip.source)),clip.source_sha256);
 assert.equal(clip.seconds,15);assert.equal(clip.rate,22050);assert.equal(clip.pcm_bytes,661500);
 assert.equal(bytes.readUInt32LE(40),clip.pcm_bytes);assert.equal(sha256(bytes.subarray(44)),clip.pcm_sha256);
 payload.set(clip.name,bytes);
}
payload.set('CLIPS.TXT',readFileSync(clipsPath));
const hashes=[...payload].map(([n,d])=>sha256(d)+'  '+n).join('\r\n')+'\r\n';payload.set('HASHES.TXT',Buffer.from(hashes));
// ZIP is the host kit. Firmware and disk image are separate downloads.
const hostEntries=[...payload].sort(([x],[y])=>x.localeCompare(y)),zipEntries=hostEntries;
assert(zipEntries.every(([name])=>! /\.(uf2|img)$/i.test(name)));
const imgEntries=hostEntries.filter(([name])=>!clips.clips.some(c=>c.name===name));
const zip=makeZip(zipEntries),img=makeImg(imgEntries);assert.deepEqual([...readZip(zip)],zipEntries);assert.deepEqual([...readFat12(img)],imgEntries);
mkdirSync(out,{recursive:true});for(const [name,bytes]of [...hostEntries,['CURRENT.UF2',fw],['CURRENT.ZIP',zip],['CURRENT.IMG',img]])writeFileSync(join(out,name),bytes);
for(const [i,build]of [a,b].entries()){
 const target=join(out,'delivery-evidence',i?'B':'A');mkdirSync(target,{recursive:true});
 for(const name of ['evidence/actual-exe.json','evidence/actual-exe-fast.json','ultrags/dss/asm-manifest.json','ultrags/dss/fast-asm.json','native/native-card-build.json','host/s8c','host/budgets/budgets.json','s7-stack.json']){mkdirSync(dirname(join(target,name)),{recursive:true});cpSync(join(build,name),join(target,name),{recursive:true});}
}
for(const name of ['stream-arm.json','compat/compat.json']){mkdirSync(dirname(join(out,'delivery-evidence',name)),{recursive:true});cpSync(join(a,'evidence',name),join(out,'delivery-evidence',name));}
cpSync(join(a,'host/compat-linked.json'),join(out,'delivery-evidence/compat-linked.json'));
cpSync(join(a,'ultrags/logs'),join(out,'delivery-evidence/regression'),{recursive:true});
const cache=readFileSync(join(a,'multifw-release/CMakeCache.txt'),'utf8');
const armCompiler=cache.match(/^CMAKE_C_COMPILER:[^=]+=(.*)$/m)[1];
const versions={node:process.version,assembler:asm[0].assembler,cc:execFileSync('cc',['--version'],{encoding:'utf8'}).split('\n')[0],arm:execFileSync(armCompiler,['--version'],{encoding:'utf8'}).split('\n')[0],python:execFileSync('python3',['--version'],{encoding:'utf8'}).trim()};
const native=JSON.parse(readFileSync(join(a,'host/native/actual-exe.json')));
assert.equal(native.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.deepEqual(native.inputs,executionInputs(repoRoot));assert.equal(native.adapterSha256,sha256(readFileSync(join(a,'native/native-card-build.json'))));
cpSync(join(a,'host/native/actual-exe.json'),join(out,'delivery-evidence/native-regression.json'));
cpSync(join(a,'native-regression.log'),join(out,'delivery-evidence/native-regression.log'));
const refillEvidence={};
for(const [name,path]of [['before',join(buildRoot,'stream-performance/before.json')],['after',join(a,'evidence/performance.json')],['priorRealFailure',join(buildRoot,'stream-performance/real-first-candidate.json')],['confirmedShortFailure',join(buildRoot,'stream-performance/real-short-r2.json')]]){
 if(!existsSync(path))continue;
 const bytes=readFileSync(path),report=JSON.parse(bytes);
 if(name==='after'){
  assert.equal(report.exeSha256,proofs[0].fast.sha256,'stale refill performance EXE');
  assert.equal(report.runnerSha256,sha256(readFileSync(join(repoRoot,'tests/ultrags/dss/run-stream.mjs'))));
  assert.deepEqual(report.inputs,executionInputs(repoRoot));
 }
 const destination='delivery-evidence/refill-'+name+'.json';writeFileSync(join(out,destination),bytes);
 refillEvidence[name]={path:destination,sha256:sha256(bytes),status:report.status};
}
const wavplay=JSON.parse(readFileSync(join(a,'evidence/wavplay.json')));
assert.equal(wavplay.checker_sha256,sha256(readFileSync(join(repoRoot,'tools/ultrags/s8c-wavplay.py'))));
assert.equal(wavplay.sha256,sha256(readFileSync(wavplay.exe)));
cpSync(join(a,'evidence/wavplay.json'),join(out,'delivery-evidence/wavplay.json'));
const status='PCM_FORMATS_BENCH / HOST_PASS / REAL_PENDING; prior 44100/S16LE/stereo REAL_FAIL remains open';
const files=[...payload.keys(),'CURRENT.UF2','CURRENT.ZIP','CURRENT.IMG'].map(name=>({name,sha256:sha256(readFileSync(join(out,name))),bytes:readFileSync(join(out,name)).length}));
writeFileSync(join(out,'DELIVERY.json'),JSON.stringify({status,versions,preservedDiagnostics,api:'1.0 VLS1 draft',hostRefillRevision:'R3: source PCM formats and card-clock DISK/FEED benchmarks; existing read/window sizes preserved',refillEvidence,gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).trim(),dirty:true,specSha256:sha256(readFileSync(join(repoRoot,'ultra-gs-docs/ultra-gs.md'))),MAME:'NOT_RUN',REAL:'PENDING for extension; confirmed prior REAL_FAIL: 10 and 5 underruns',wavplay,clips,imgEntries:imgEntries.map(([name])=>name),independentBuilds:[a,b],execution,standardModeledBytesPerSecond:baseSpeed.modeledBytesPerSecond,experimentalModeledBytesPerSecond:fastSpeed.modeledBytesPerSecond,requiredMinimum:220500,optimizationTarget:352800,arm,budget,stack,files,packagerSha256:sha256(readFileSync(new URL(import.meta.url))),limits:['Confirmed prior SHORT.WAV REAL_FAIL: 10 underruns at256/128 and5 at512/256 KiB; this extension requires flash and new REAL tests','No hardware stability/throughput or 30-minute acceptance','No physical delay headroom for any buffer size','S8a/S8b and final S8c acceptance remain open']},null,2)+'\n');
// Retain older download links without moving the actual delivery each time.
const latest=join(buildRoot,'latest'),temp=join(buildRoot,'latest.tmp');
if(existsSync(latest))assert(lstatSync(latest).isSymbolicLink(),'preserve an existing latest directory');
assert(!existsSync(temp),'temporary publication path already exists');
symlinkSync('.',temp,'dir');renameSync(temp,latest);
console.log(status);console.log('Independent UF2/EXE identity and ZIP/IMG readback PASS:',out);
