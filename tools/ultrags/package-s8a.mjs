// SPDX-License-Identifier: GPL-2.0-or-later
// Release only independently reproduced binaries with current executed evidence.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,symlinkSync,renameSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyBuild,verifyExecution,executionInputs,sha256,repoRoot} from './build-evidence.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
import {readZip,readFat12} from './verify-package.mjs';
const out=join(repoRoot,'build'),builds=[out,join(out,'reproducibility')];
const read=p=>JSON.parse(readFileSync(p)),current=e=>{for(const [p,h]of Object.entries(e.inputs??{}))assert.equal(sha256(readFileSync(resolve(repoRoot,p))),h,'stale proof '+p);};
const asm=builds.map(b=>verifyBuild(repoRoot,join(b,'ultrags/dss')));assert.deepEqual(asm[0].files,asm[1].files);
const execution=verifyExecution(repoRoot,join(out,'ultrags/dss')),proofs=[];
const fw=readFileSync(join(out,'multifw-release/picogus.uf2'));assert.deepEqual(fw,readFileSync(join(builds[1],'multifw-release/picogus.uf2')));
execFileSync('python3',[join(repoRoot,'tools/ultrags/compat-linked.py'),...builds],{stdio:'pipe'});
for(const b of builds){
 const host=read(join(b,'host/s8a/host-evidence.json'));assert.equal(host.status,'HOST_PASS / REAL_PENDING');current(host);
 assert.deepEqual(Object.keys(host.commands).sort(),['mod8','mod8-storage']);
 for(const [p,h]of Object.entries(host.artifacts))assert.equal(sha256(readFileSync(join(b,'host/s8a',p))),h);
 const exe=read(join(b,'evidence/s8a-exe.json'));assert.equal(exe.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.deepEqual(exe.inputs,executionInputs(repoRoot));
 assert.equal(exe.runnerSha256,sha256(readFileSync(join(repoRoot,'tests/ultrags/dss/run-s8a.mjs'))));
 assert.equal(exe.deliveryFixtureSha256,sha256(readFileSync(join(b,'s8a-test-audio/EIGHT.MOD'))));
 assert.deepEqual(exe.assembly.inputs,asm[0].inputs);assert.equal(exe.adapterSha256,sha256(readFileSync(join(b,'native/native-card-build.json'))));
 const adapter=read(join(b,'native/native-card-build.json'));current(adapter);assert.equal(adapter.artifact,sha256(readFileSync(join(b,'native/native-card.node'))));
 assert(exe.results.length>=47 && exe.results.every(r=>r.maxDiUs<10000&&r.maxWindowUs<10000));
 assert(exe.results.some(r=>r.loseAck&&r.exit!==0));assert(exe.results.filter(r=>r.exit===10).length>=5);
 for(const [name,r]of Object.entries(exe.images))assert.equal(r.sha256,sha256(readFileSync(join(b,'ultrags/dss',name+'.EXE'))));
 const fast=read(join(b,'ultrags/dss/fast-asm.json'));current(fast);assert.equal(fast.sha256,sha256(readFileSync(join(b,'ultrags/dss/UGPF.EXE'))));
 const f00Host=read(join(b,'host/f00/host-evidence.json'));current(f00Host);assert.equal(f00Host.status,'HOST_PASS / REAL_PENDING');
 for(const [p,h]of Object.entries(f00Host.artifacts))assert.equal(sha256(readFileSync(join(b,'host/f00',p))),h);
 const bruno=read(join(b,'host/f00/bruno-evidence.json'));current(bruno);assert.equal(bruno.status,'HOST_PASS / REAL_PENDING');
 assert.equal(bruno.ticks_compared,7557);assert.equal(bruno.ignore_eof_seconds,151.14);assert.equal(bruno.pause_seconds,19.04);
 assert.equal(bruno.original_sha256,'024f4b4a2c4ab31524243dfaa389b7dd38b3af4d2cdd37d6cbf6efab03d70a8a');
 for(const [p,h]of Object.entries(bruno.artifacts))assert.equal(sha256(readFileSync(join(b,'host/f00',p))),h);
 const f00=read(join(b,'evidence/f00-exe.json'));assert.equal(f00.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.deepEqual(f00.inputs,executionInputs(repoRoot));
 assert.deepEqual(f00.assembly.inputs,asm[0].inputs);assert.equal(f00.adapterSha256,sha256(readFileSync(join(b,'native/native-card-build.json'))));
 assert.equal(f00.runnerSha256,sha256(readFileSync(join(repoRoot,'tests/ultrags/dss/run-f00.mjs'))));
 assert.equal(f00.fixtureGeneratorSha256,sha256(readFileSync(join(repoRoot,'tools/ultrags/gen-f00.mjs'))));
 assert.equal(f00.original.sha256,bruno.original_sha256);assert.equal(sha256(readFileSync(f00.original.path)),f00.original.sha256);
 for(const [app,h]of Object.entries(f00.images))assert.equal(sha256(readFileSync(join(b,'ultrags/dss',app+'.EXE'))),h);
 assert(f00.results.length>=94 && f00.results.every(r=>r.maxDiUs<10000&&r.maxWindowUs<10000));
 for(const app of ['UGPLAY','UGPF']) {
  const rows=f00.results.filter(r=>r.app===app);assert(rows.some(r=>r.cli==='BST.MOD')&&rows.some(r=>r.cli==='BST.MOD /F00:PAUSE'));
  assert(rows.filter(r=>r.text.includes('MOD_F00_POLICY_REQUIRES_NEW_FIRMWARE')).length===2);
 }
 proofs.push({build:b,host,exe,fast,f00,f00Host,bruno});
}
assert.equal(proofs[0].fast.sha256,proofs[1].fast.sha256);
const arm=read(join(out,'evidence/s8a-arm.json'));assert.equal(arm.status,'LINKED_ARM_MOD8_PASS / REAL_PENDING');current(arm);assert.equal(arm.results.length,4);
const stack=read(join(out,'s7-stack.json'));current(stack);assert.equal(stack.status,'PASS');assert(stack.subtotal+stack.unprofiled_and_irq_reserve<=2048);
const budgets=read(join(out,'host/budgets/budgets.json'));current(budgets);assert(budgets.sram['pg-ultrags'].free_main>=16384);
const native=read(join(out,'host/native/actual-exe.json'));assert.equal(native.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.deepEqual(native.inputs,executionInputs(repoRoot));assert.equal(native.adapterSha256,sha256(readFileSync(join(out,'native/native-card-build.json'))));
const stream=read(join(out,'host/s8c/host-evidence.json'));current(stream);assert.equal(stream.status,'HOST_PASS / REAL_PENDING');
for(const [p,h]of Object.entries(stream.artifacts))assert.equal(sha256(readFileSync(join(out,'host/s8c',p))),h);
for(const name of ['actual-exe','actual-exe-fast']){
 const e=read(join(out,'evidence',name+'.json')),exe=name==='actual-exe'?'UGPLAY.EXE':'UGPF.EXE';
 assert.equal(e.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.deepEqual(e.inputs,executionInputs(repoRoot));assert.deepEqual(e.assembly.inputs,asm[0].inputs);
 assert.equal(e.runnerSha256,sha256(readFileSync(join(repoRoot,'tests/ultrags/dss/run-stream.mjs'))));assert.equal(e.exeSha256,sha256(readFileSync(join(out,'ultrags/dss',exe))));assert(e.results.length>=170);
}
const compat=read(join(out,'evidence/compat/compat.json'));current(compat);
const fixtureDir=join(out,'s8a-test-audio'),fixtures=read(join(fixtureDir,'fixtures.json'));
assert.equal(fixtures.generatorSha256,sha256(readFileSync(join(repoRoot,'tools/ultrags/gen-s8a.mjs'))));
const payload=new Map(asm[0].files.filter(e=>!e.name.startsWith('ST-')).map(e=>[e.name,readFileSync(join(out,'ultrags/dss',e.name))]));
payload.set('UGPF.EXE',readFileSync(join(out,'ultrags/dss/UGPF.EXE')));
payload.set('TESTER.TXT',readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/S8A-README.md')));
payload.set('S8C.TXT',readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/S8C-README.md')));
payload.set('F00.TXT',readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/F00-README.md')));
for(const name of ['F00MOD4.MOD','F00MOD8.MOD']) {
 const bytes=readFileSync(join(out,'host/f00/fixtures',name));assert.deepEqual(bytes,readFileSync(join(builds[1],'host/f00/fixtures',name)));payload.set(name,bytes);
}
for(const f of fixtures.files){const bytes=readFileSync(join(fixtureDir,f.name));assert.equal(sha256(bytes),f.sha256);payload.set(f.name,bytes);}
payload.set('FIXTURES.TXT',readFileSync(join(fixtureDir,'fixtures.json')));
// Preserve the original-format short streaming clips and diagnostics in the kit.
const clips=read(join(out,'s8c-test-audio/original-clips.json'));
for(const f of clips.clips){const bytes=readFileSync(join(out,'s8c-test-audio',f.name));assert.equal(sha256(bytes),f.sha256);payload.set(f.name,bytes);}
payload.set('CLIPS.TXT',readFileSync(join(out,'s8c-test-audio/original-clips.json')));
const d4=join(out,'gs-clock-d4-delivery'),preservedDiagnostics=[];
if(existsSync(join(d4,'D4.json'))){const old=read(join(d4,'D4.json'));for(const name of ['UGGS0.EXE','UGGS1.EXE','UGGSC0.EXE','UGGSC1.EXE']){const bytes=readFileSync(join(d4,name));assert.equal(sha256(bytes),old.files[name].sha256);payload.set(name,bytes);preservedDiagnostics.push({name,sha256:sha256(bytes),scope:'Prior D4 diagnostic, unchanged'});}}
payload.set('HASHES.TXT',Buffer.from([...payload].map(([n,b])=>sha256(b)+'  '+n).join('\r\n')+'\r\n'));
const entries=[...payload].sort(([a],[b])=>a.localeCompare(b)),imgEntries=entries.filter(([n])=>!clips.clips.some(c=>c.name===n));
assert(entries.every(([n])=>! /\.(UF2|IMG)$/i.test(n)));
const zip=makeZip(entries),img=makeImg(imgEntries);assert.deepEqual([...readZip(zip)],entries);assert.deepEqual([...readFat12(img)],imgEntries);
// Construct the second kit from independently assembled/validated artifacts.
const independent=new Map(entries.filter(([n])=>n!=='HASHES.TXT').map(([n,bytes])=>{
 if(asm[1].files.some(f=>f.name===n)||n==='UGPF.EXE')bytes=readFileSync(join(builds[1],'ultrags/dss',n));
 else if(['F00MOD4.MOD','F00MOD8.MOD'].includes(n))bytes=readFileSync(join(builds[1],'host/f00/fixtures',n));
 else if(fixtures.files.some(f=>f.name===n))bytes=readFileSync(join(builds[1],'s8a-test-audio',n));
 else if(n==='FIXTURES.TXT')bytes=readFileSync(join(builds[1],'s8a-test-audio/fixtures.json'));
 return [n,bytes];
}));
// HASHES.TXT preserves the established payload insertion order.
independent.set('HASHES.TXT',Buffer.from([...payload.keys()].filter(n=>n!=='HASHES.TXT').map(n=>sha256(independent.get(n))+'  '+n).join('\r\n')+'\r\n'));
const independentEntries=[...independent].sort(([a],[b])=>a.localeCompare(b));
const independentZip=makeZip(independentEntries),independentImg=makeImg(independentEntries.filter(([n])=>!clips.clips.some(c=>c.name===n)));
assert.deepEqual(independentZip,zip);assert.deepEqual(independentImg,img);
if(process.argv.includes('--verify-only')){console.log('S8a current evidence, independent binary identity and ZIP/FAT readback PASS');process.exit(0);}
const evidence=join(out,'delivery-evidence/s8a');mkdirSync(evidence,{recursive:true});
for(const [i,b]of builds.entries()){
 const dest=join(evidence,i?'B':'A');mkdirSync(dest,{recursive:true});
 for(const [source,name]of [['evidence/s8a-exe.json','actual-exe.json'],['host/s8a','host'],['host/f00','f00'],['evidence/f00-exe.json','f00-exe.json'],['native/native-card-build.json','adapter.json'],['ultrags/dss/asm-manifest.json','asm-manifest.json'],['ultrags/dss/fast-asm.json','fast-asm.json']])cpSync(join(b,source),join(dest,name),{recursive:true});
}
for(const [source,name]of [['evidence/s8a-arm.json','arm.json'],['s7-stack.json','stack.json'],['host/budgets/budgets.json','budgets.json'],['ultrags/logs/ugdiag-run.json','dss-regression.json'],['host/native/actual-exe.json','native-regression.json'],['evidence/actual-exe.json','stream.json'],['evidence/actual-exe-fast.json','stream-fast.json'],['host/compat-linked.json','compat-linked.json'],['evidence/compat/compat.json','compat.json'],['real/s8c/real-20261021-1316.json','s8c-real.json']])cpSync(join(out,source),join(evidence,name));
const status='MOD F00 policy + S8a MOD8_8CHN / HOST_PASS / REAL_PENDING; S8c optimization deferred, confirmed REAL_FAIL retained';
const delivery=[...entries,['CURRENT.UF2',fw],['CURRENT.ZIP',zip],['CURRENT.IMG',img]];
const files=delivery.map(([name,bytes])=>({name,bytes:bytes.length,sha256:sha256(bytes)}));
const armCompiler=readFileSync(join(out,'multifw-release/CMakeCache.txt'),'utf8').match(/^CMAKE_C_COMPILER:[^=]+=(.*)$/m)[1];
const report={status,api:'1.0 VLS1',gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).trim(),dirty:true,
 specSha256:sha256(readFileSync(join(repoRoot,'ultra-gs-docs/ultra-gs.md'))),packagerSha256:sha256(readFileSync(new URL(import.meta.url))),
 independentBuilds:builds,versions:{arm:execFileSync(armCompiler,['--version'],{encoding:'utf8'}).split('\n')[0],python:execFileSync('python3',['--version'],{encoding:'utf8'}).trim(),node:process.version,assembler:asm[0].assembler,cc:execFileSync('cc',['--version'],{encoding:'utf8'}).split('\n')[0]},
 execution,f00Scenarios:proofs.map(p=>p.f00.results.length),f00:{originalSha256:proofs[0].bruno.original_sha256,ticksCompared:7557,ignoreEOF:151.14,pauseSeconds:19.04},mod8Scenarios:proofs.map(p=>p.exe.results.length),nativeScenarios:native.results.length,privateProplay:native.privateProplay,arm:arm.results,stack:{parser:stack.subtotal+stack.unprofiled_and_irq_reserve,render:stack.render_with_reserve},freeMainSRAM:budgets.sram['pg-ultrags'].free_main,fixtures,preservedDiagnostics,imgEntries:imgEntries.map(([n])=>n),files,
 REAL:'PENDING for S8a; S8c 44100/S16LE/stereo REAL_FAIL',MAME:'NOT_RUN',limits:['No physical render deadline, listening or 10/30-minute acceptance','S8b FLT8 and S9 playlist not implemented','S8c producer optimization deferred; required176400 and useful220500 B/s unchanged'],evidence:'delivery-evidence/s8a/'};
// Publish only after all byte/provenance/ZIP/FAT checks have succeeded.
for(const [name,bytes]of delivery){const temp=join(out,name+'.tmp');writeFileSync(temp,bytes);renameSync(temp,join(out,name));}
for(const [name,bytes]of [['CURRENT.UF2',readFileSync(join(builds[1],'multifw-release/picogus.uf2'))],['CURRENT.ZIP',independentZip],['CURRENT.IMG',independentImg]]) {
 const temp=join(builds[1],name+'.tmp');writeFileSync(temp,bytes);renameSync(temp,join(builds[1],name));
}
writeFileSync(join(out,'DELIVERY.json.tmp'),JSON.stringify(report,null,2)+'\n');renameSync(join(out,'DELIVERY.json.tmp'),join(out,'DELIVERY.json'));
const latest=join(out,'latest');if(existsSync(latest))assert(lstatSync(latest).isSymbolicLink());else symlinkSync('.',latest,'dir');
console.log(status);for(const f of files.filter(f=>f.name.startsWith('CURRENT.')))console.log(f.name,f.bytes,f.sha256);
