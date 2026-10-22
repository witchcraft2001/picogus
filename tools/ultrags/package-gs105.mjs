// SPDX-License-Identifier: GPL-2.0-or-later
// Fail closed on stale inputs, missing mandatory software proofs or mismatched
// independent binaries. Publish CURRENT only after ZIP/FAT re-extraction.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,cpSync,lstatSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyBuild,verifyExecution,executionInputs,sha256,repoRoot} from './build-evidence.mjs';
import {buildKit} from './gs105-kit.mjs';
import {verifyTurbo} from './gs-turbo-evidence.mjs';
const turbo=process.argv.includes('--gs-turbo');
const out=join(repoRoot,'build'),builds=[out,join(out,'reproducibility')];
const json=p=>JSON.parse(readFileSync(p)),hash=p=>sha256(readFileSync(p));
function current(e){for(const [p,h]of Object.entries(e.inputs??{}))assert.equal(hash(resolve(repoRoot,p)),h,'stale input '+p);}
const assembly=builds.map(b=>verifyBuild(repoRoot,join(b,'ultrags/dss')));assert.deepEqual(assembly[0].files,assembly[1].files);
const fw=readFileSync(join(out,'multifw-release/picogus.uf2'));assert.deepEqual(fw,readFileSync(join(builds[1],'multifw-release/picogus.uf2')));
const turboReports=turbo?builds.map((b,i)=>verifyTurbo(b,assembly[i])):[];
if(!turbo){
 execFileSync('python3',[join(repoRoot,'tools/ultrags/compat-linked.py'),...builds],{stdio:'pipe'});
 const gsFast=json(join(out,'host/gs-fast-linked.json'));current(gsFast);assert.equal(gsFast.status,'LINKED_GS_FAST_PASS / REAL_PENDING');
}
const proofs=[];
for(const [index,b]of builds.entries()){
 execFileSync('python3',[join(repoRoot,'tools/ultrags/gs105-report.py'),'--build',b],{stdio:'pipe'});
 const report=json(join(b,'GS105-CONFORMANCE.json'));assert.equal(report.status,'HOST_PASS / DSS_EXE_PASS / REAL_PENDING');current(report);
 execFileSync('python3',[join(repoRoot,'tests/ultrags/unit/test_gs105_evidence.py'),'--build',b],{stdio:'pipe'});
 const gs=json(join(b,'evidence/gs-exe.json'));assert.deepEqual(gs.inputs,executionInputs(repoRoot));assert.deepEqual(gs.assembly,assembly[index]);
 assert(gs.results.length>=202);assert(gs.results.some(r=>r.corruptRead&&r.exit===9));assert(gs.results.some(r=>r.delayPolls>262000));
 const adapter=json(join(b,'native/native-card-build.json'));current(adapter);assert.equal(hash(join(b,'native/native-card.node')),adapter.artifact);
 assert.equal(gs.adapterSha256,hash(join(b,'native/native-card-build.json')));
 const fast=json(join(b,'ultrags/dss/fast-asm.json'));current(fast);assert.equal(hash(join(b,'ultrags/dss/UGPF.EXE')),fast.sha256);
 for(const dir of ['host/f00']){
  const e=json(join(b,dir,'host-evidence.json'));current(e);assert.equal(e.status,'HOST_PASS / REAL_PENDING');
  for(const [name,h]of Object.entries(e.artifacts))assert.equal(hash(join(b,dir,name)),h);
 }
 const bruno=json(join(b,'host/f00/bruno-evidence.json'));current(bruno);assert.equal(bruno.ticks_compared,7557);assert.equal(bruno.ignore_eof_seconds,151.14);assert.equal(bruno.pause_seconds,19.04);
 for(const [p,h]of Object.entries(bruno.artifacts))assert.equal(hash(join(b,'host/f00',p)),h);
 for(const [name,minimum]of [['f00-exe',94],['s8a-exe',47]]){
  const e=json(join(b,'evidence',name+'.json'));assert.equal(e.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.deepEqual(e.inputs,executionInputs(repoRoot));assert.deepEqual(e.assembly.inputs,assembly[index].inputs);
  assert.equal(e.adapterSha256,hash(join(b,'native/native-card-build.json')));assert(e.results.length>=minimum);
  assert.equal(e.runnerSha256,hash(join(repoRoot,'tests/ultrags/dss',name==='f00-exe'?'run-f00.mjs':'run-s8a.mjs')));
  for(const [app,v]of Object.entries(e.images))assert.equal(hash(join(b,'ultrags/dss',app+'.EXE')),typeof v==='string'?v:v.sha256);
 }
 // These run on actual linked binaries in addition to the host SDK model.
 const cache=readFileSync(join(b,'multifw-release/CMakeCache.txt'),'utf8');
 const prefix=cache.match(/^CMAKE_C_COMPILER:[^=]+=(.*)gcc$/m)[1];
 for(const name of ['bootloader',...['gus','adlib','mpu','psg','sb','usb','ultrags'].map(n=>'pg-'+n+'-multifw')]){
  execFileSync('python3',[join(repoRoot,'sw/scripts/check_printf_leak.py'),prefix+'objdump',prefix+'addr2line',join(b,'multifw-release',name+'.elf')]);
 }
 proofs.push({report,gs,fastSha256:fast.sha256,hostSha256:hash(join(b,'host/gs105/host-evidence.json'))});
}
assert.equal(proofs[0].fastSha256,proofs[1].fastSha256);
const regression=json(join(out,'ultrags/logs/ugdiag-run.json'));assert.equal(regression.fail,0);assert(regression.pass>=1900);
let regressionIdentity;
if(turbo){
 // The general DSS runner deliberately enforces Turbo OFF. The two explicit
 // Turbo diagnostics execute in their production-C runner, validated above.
 // Require an exact partition: every other EXE must occur in the general run.
 const standard=assembly[0].files.filter(e=>!/^UGGST[01]\.EXE$/.test(e.name));
 assert.deepEqual(regression.buildInputs,assembly[0].inputs);
 assert.deepEqual(regression.executionInputs,executionInputs(repoRoot));
 assert(regression.results.length&&regression.results.every(r=>r.ok));
 assert.deepEqual(regression.executed,standard.map(({name,size,sha256})=>({name,size,sha256})));
 regressionIdentity={assembly:hash(join(out,'ultrags/dss/asm-manifest.json')),execution:hash(join(out,'ultrags/logs/ugdiag-run.json')),turbo:hash(join(out,'evidence/gs-turbo-exe.json'))};
}else regressionIdentity=verifyExecution(repoRoot,join(out,'ultrags/dss'));
execFileSync('python3',['-c',"import json,sys;sys.path.insert(0,'tools/ultrags');from s6_inputs import validate;from pathlib import Path;validate(json.loads(Path('build/host/s6/s6-host-evidence.json').read_text()),Path('build/host/s6'))"],{cwd:repoRoot});
execFileSync('python3',[join(repoRoot,'tools/ultrags/s7-host.py'),'--build',join(out,'host/s7'),'--verify-only'],{stdio:'pipe'});
for(const path of ['host/s8a/host-evidence.json','host/s8c/host-evidence.json']){
 const e=json(join(out,path));current(e);assert.equal(e.status,'HOST_PASS / REAL_PENDING');
 for(const [p,h]of Object.entries(e.artifacts))assert.equal(hash(join(out,path.slice(0,path.lastIndexOf('/')),p)),h);
}
for(const name of ['actual-exe','actual-exe-fast']){
 const e=json(join(out,'evidence',name+'.json'));assert.equal(e.status,'HOST_ACTUAL_EXE_PASS / REAL_PENDING');assert.deepEqual(e.inputs,executionInputs(repoRoot));assert.deepEqual(e.assembly.inputs,assembly[0].inputs);assert(e.results.length>=175);assert.equal(e.runnerSha256,hash(join(repoRoot,'tests/ultrags/dss/run-stream.mjs')));assert.equal(e.adapterSha256,hash(join(out,'native/native-card.node')));
 const app=name==='actual-exe'?'UGPLAY.EXE':'UGPF.EXE';assert.equal(e.exeSha256,hash(join(out,'ultrags/dss',app)));
}
const stack=json(join(out,'s7-stack.json'));current(stack);assert.equal(stack.status,'PASS');assert(stack.subtotal+stack.unprofiled_and_irq_reserve<=2048);
const budgets=json(join(out,'host/budgets/budgets.json'));current(budgets);assert.equal(budgets.legacy_images.length,6);assert(budgets.sram['pg-ultrags'].free_main>=16384);
for(const [name,count]of [['s8a-arm',4],['stream-arm',12]]){const e=json(join(out,'evidence',name+'.json'));current(e);assert.equal(e.results.length,count);assert(e.status.includes('PASS'));}
const kitA=buildKit(repoRoot,builds[0],assembly[0],{turbo}),kitB=buildKit(repoRoot,builds[1],assembly[1],{turbo});
assert.deepEqual(kitA,kitB);const entries=kitA.entries;
// Verify-only always reconstructs the exact current ZIP/FAT and checks bytes.
if(process.argv.includes('--verify-only')){
 for(const [i,b]of builds.entries()){const kit=i?kitB:kitA;assert.deepEqual(readFileSync(join(b,'CURRENT.UF2')),fw);assert.deepEqual(readFileSync(join(b,'CURRENT.ZIP')),kit.zip);assert.deepEqual(readFileSync(join(b,'CURRENT.IMG')),kit.img);}
 const delivery=json(join(out,'DELIVERY.json'));current(delivery);assert.equal(delivery.specSha256,hash(join(repoRoot,'ultra-gs-docs/ultra-gs.md')));assert.equal(delivery.packagerSha256,sha256(readFileSync(new URL(import.meta.url))));
 for(const f of delivery.files)assert.equal(hash(join(out,f.name)),f.sha256);
 console.log((turbo?'GS Turbo R15':'GS105')+' current proof freshness, independent UF2/EXE/ZIP/IMG identity and re-extraction PASS');process.exit(0);
}
const evidence=join(out,'delivery-evidence',turbo?'gs-turbo':'gs105');mkdirSync(evidence,{recursive:true});
for(const [i,b]of builds.entries()){
 const dest=join(evidence,i?'B':'A');mkdirSync(dest,{recursive:true});
 if(turbo)for(const path of ['host/gs-turbo','host/config-read-arm.json','evidence/gs-turbo-exe.json','GS-TURBO.json','GS-TURBO.txt'])cpSync(join(b,path),join(dest,path.replaceAll('/','-')),{recursive:true});
 for(const [source,target]of [['GS105-CONFORMANCE.json','conformance.json'],['GS105-CONFORMANCE.md','conformance.md'],['evidence/gs-exe.json','gs-exe.json'],['evidence/lowram-exe.json','lowram-exe.json'],['host/gs105','host'],['ultrags/dss/asm-manifest.json','assembly.json'],['native/native-card-build.json','adapter.json'],['host/native/actual-exe.json','native-exe.json'],['s7-dss-evidence.json','s7-exe.json'],['host/s7/s7-host-evidence.json','s7-host.json'],['evidence/f00-exe.json','f00-exe.json'],['evidence/s8a-exe.json','s8a-exe.json']])cpSync(join(b,source),join(dest,target),{recursive:true});
}
for(const name of ['s8a-arm','stream-arm','f00-exe','s8a-exe','actual-exe','actual-exe-fast'])cpSync(join(out,'evidence',name+'.json'),join(evidence,name+'.json'));
const physical=proofs[0].report.physical;
if(physical){cpSync(join(out,'real/gs105/owner-pass.json'),join(evidence,'owner-pass.json'));}
const files=[['CURRENT.UF2',fw],['CURRENT.ZIP',kitA.zip],['CURRENT.IMG',kitA.img]].map(([name,v])=>({name,bytes:v.length,sha256:sha256(v)}));
const report={status:(turbo?'UGS-GS-TURBO/R15':'UGS-GS105/1')+' HOST_PASS / DSS_EXE_PASS / REAL_PENDING',S7:'IN_PROGRESS',gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).trim(),dirty:true,
 specSha256:hash(join(repoRoot,'ultra-gs-docs/ultra-gs.md')),packagerSha256:sha256(readFileSync(new URL(import.meta.url))),independentBuilds:builds,commandCoverage:proofs[0].report.command_coverage.length,tickCases:proofs[0].report.tick_cases,fxProfiles:1344,gsExeCases:proofs.map(p=>p.gs.results.length),regressionPass:regression.pass,freeMainSRAM:budgets.sram['pg-ultrags'].free_main,stack:stack.subtotal+stack.unprofiled_and_irq_reserve,files,
 inputs:{[join(repoRoot,'tests/ultrags/unit/test_gs105_evidence.py')]:hash(join(repoRoot,'tests/ultrags/unit/test_gs105_evidence.py')),[join(repoRoot,'tools/ultrags/gs105-kit.mjs')]:hash(join(repoRoot,'tools/ultrags/gs105-kit.mjs')),[join(repoRoot,'tools/ultrags/disk-formats.mjs')]:hash(join(repoRoot,'tools/ultrags/disk-formats.mjs')),[join(repoRoot,'tools/ultrags/verify-package.mjs')]:hash(join(repoRoot,'tools/ultrags/verify-package.mjs')),[join(repoRoot,'tools/ultrags/package-gs105.mjs')]:sha256(readFileSync(new URL(import.meta.url))),[join(repoRoot,'host/sprinter/ultrags/docs/GS105-README.md')]:hash(join(repoRoot,'host/sprinter/ultrags/docs/GS105-README.md'))},evidence:turbo?'delivery-evidence/gs-turbo/':'delivery-evidence/gs105/',turboReports,physical,REAL:turbo?'R15 REAL_PENDING; R14 CONFIG/mode-switch REAL_FAIL with Turbo enabled; prior GS Turbo OFF owner PASS and R13 Turbo ON REAL_FAIL retained; S7 IN_PROGRESS':physical?'Reported GS series REAL_PASS; full S7 hardware acceptance PENDING; GS Turbo ON and S8c throughput REAL_FAIL retained':'PENDING; GS Turbo ON known REAL_FAIL; S8c throughput REAL_FAIL retained',limits:proofs[0].report.limits};
// Publication happens only after every validation, including both independently
// assembled images and byte-for-byte ZIP/FAT round trips, has completed.
for(const [i,b]of builds.entries())for(const [name,v]of [['CURRENT.UF2',readFileSync(join(b,'multifw-release/picogus.uf2'))],['CURRENT.ZIP',i?kitB.zip:kitA.zip],['CURRENT.IMG',i?kitB.img:kitA.img]]){writeFileSync(join(b,name+'.tmp'),v);renameSync(join(b,name+'.tmp'),join(b,name));}
for(const [n,v]of entries){writeFileSync(join(out,n+'.tmp'),v);renameSync(join(out,n+'.tmp'),join(out,n));}
writeFileSync(join(out,'DELIVERY.json.tmp'),JSON.stringify(report,null,2)+'\n');renameSync(join(out,'DELIVERY.json.tmp'),join(out,'DELIVERY.json'));
const latest=join(out,'latest');if(existsSync(latest))assert(lstatSync(latest).isSymbolicLink());
const linkTemp=join(out,'latest-gs-turbo.tmp');symlinkSync('.',linkTemp,'dir');renameSync(linkTemp,latest);
console.log(report.status);for(const f of files)console.log(f.name,f.bytes,f.sha256);
