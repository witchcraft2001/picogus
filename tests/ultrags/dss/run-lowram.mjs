// SPDX-License-Identifier: GPL-2.0-or-later
// Reproduce PASS-before-DSS-EXIT corruption with an old-allocation probe, then
// require every repaired fixture/FX/stream path to preserve resident memory.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {NativeCard} from './native-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {verifyBuild,executionInputs,sha256} from '../../../tools/ultrags/build-evidence.mjs';
const root=resolve(process.argv[2]??'.'),build=resolve(process.argv[3]??'build'),old=join(build,'lowram-probe');
const assembly=verifyBuild(root,join(build,'ultrags/dss')),inputs=executionInputs(root),Z80=loadZ80(root),results=[],images={};
const addon=join(build,'native/native-card.node'),manifestPath=join(build,'native/native-card-build.json'),manifest=JSON.parse(readFileSync(manifestPath));
for(const [p,h]of Object.entries(manifest.inputs))assert.equal(sha256(readFileSync(p)),h);
assert.equal(sha256(readFileSync(addon)),manifest.artifact);
// A deliberate old-allocation variant is built from current sources. This
// keeps the regression reproducible without requiring a prior CURRENT kit.
mkdirSync(old,{recursive:true});
for(const dir of ['apps','lib','include'])cpSync(join(root,'host/sprinter/ultrags',dir),join(old,dir),{recursive:true});
for(const [name,from,to,guard]of [
 ['ugtestmod8_data.inc','S8MOD_DATA EQU 0x4000','S8MOD_DATA EQU 0x3000','    ASSERT S8MOD_DATA >= 0x4000\n'],
 ['ugaudio.asm','AFXRECORDS EQU 0x4000','AFXRECORDS EQU 0x3000','    ASSERT AFXRECORDS >= 0x4000\n']]){
 const path=join(old,'lib',name),s=readFileSync(path,'utf8');assert(s.includes(from)&&s.includes(guard));writeFileSync(path,s.replace(from,to).replace(guard,''));
}
for(const app of ['UGTEST','UGPLAY'])execFileSync(process.env.SJASMPLUS??'sjasmplus',[
 ...['apps','lib','include'].map(dir=>'--inc='+join(old,dir)),'--inc='+join(build,'ultrags/gen'),
 '--raw='+join(old,app+'.EXE'),join(old,'apps',app.toLowerCase()+'.asm')],{stdio:'pipe'});
const cases=[['UGTEST','MOD4'],['UGTEST','MOD8'],['UGPLAY','FX A.RAW /RATE:48000 /BITS:8 /CH:1 /FMT:U8 /LOOP'],['UGPLAY','STREAM A.RAW /RATE:48000 /BITS:8 /CH:1 /FMT:U8 /BUFFER:8 /PREFILL:4 /LOW:2']];
function run(app,cli,legacy=false,slot=0,iff=1){
 const path=join(legacy?old:join(build,'ultrags/dss'),app+'.EXE');
 const bytes=readFileSync(path),h=parseExe(bytes),card=new NativeCard(readFileSync(join(build,'host/s2-catalog.bin')),{addon});
 if(app==='UGPLAY'&&cli.startsWith('FX ')){
  const seed=readFileSync(join(build,'ultrags/dss/UGPLAY.EXE')),sh=parseExe(seed),sm=new SprinterMachine({card,cardSlot:slot,commandLine:cli+` /SLOT:${slot}`,turboInit:false,files:{'A.RAW':Buffer.alloc(4096,160)},logLimit:0});
  sm.mem.set(seed,sh.loadAddr);assert.equal(runImage(Z80,sm,{entry:sh.entry,stack:sh.stack,iff,budget:100000000}).exitCode,0);assert.deepEqual(sm.violations,[]);
 }
 const m=new SprinterMachine({card,cardSlot:slot,commandLine:cli+` /SLOT:${slot}`,turboInit:false,files:{'A.RAW':Buffer.alloc(4096,160)},logLimit:20});
 const resident=m.mem.slice(0x100,0x4000);m.mem.set(bytes,h.loadAddr);
 const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff,budget:100000000});assert.equal(r.exitCode,0,cli+'\n'+m.text);
 const changed=!Buffer.from(m.mem.slice(0x100,0x4000)).equals(Buffer.from(resident));
 if(legacy){assert(m.residentWrites>0&&changed);assert(m.violations.some(v=>v.startsWith('write into resident DSS:')));}
 else {assert.equal(m.residentWrites,0);assert(!changed);assert.deepEqual(m.violations,[]);assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!r.end.iff1,!!iff);}
 const sha=sha256(bytes);if(!legacy)images[app]=sha;
 results.push({app,cli,legacy,sha256:sha,slot,iff,exit:r.exitCode,residentWrites:m.residentWrites,residentUnchanged:!changed,violations:m.violations});
 console.log('PASS',legacy?'old allocation reproduces resident corruption':'resident DSS preserved',app,cli,slot,iff);
}
for(const [app,cli]of cases){run(app,cli,true);for(const slot of [0,1])for(const iff of [0,1])run(app,cli,false,slot,iff);}
assert.deepEqual(executionInputs(root),inputs);assert.deepEqual(verifyBuild(root,join(build,'ultrags/dss')),assembly);
mkdirSync(join(build,'evidence'),{recursive:true});writeFileSync(join(build,'evidence/lowram-exe.json'),JSON.stringify({status:'HOST_ACTUAL_EXE_PASS / REAL_PENDING',inputs,assembly,images,adapterSha256:sha256(readFileSync(manifestPath)),runnerSha256:sha256(readFileSync(new URL(import.meta.url))),results},null,2)+'\n');
