// SPDX-License-Identifier: GPL-2.0-or-later
// Real assembled EXEs and unchanged private PROPLAY against production C.
// Functional SDK model: no electrical, PIO or physical audio timing claims.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {crc32} from './config-card.mjs';
import {NativeCard} from './native-card.mjs';
import {LegacyMachine} from './legacy-machine.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {verifyBuild,executionInputs} from '../../../tools/ultrags/build-evidence.mjs';
const root=resolve(process.argv[2]??'.'),build=resolve(process.argv[3]??'build/voices-work');
rmSync(join(build,'host/native/actual-exe.json'),{force:true});
const sha=b=>createHash('sha256').update(b).digest('hex'),before=executionInputs(root),assembly=verifyBuild(root,join(build,'ultrags/dss'));
const manifestPath=join(build,'native/native-card-build.json'),manifest=JSON.parse(readFileSync(manifestPath));
for(const [path,hash] of Object.entries(manifest.inputs))assert.equal(sha(readFileSync(path)),hash,'stale C adapter input '+path);
assert.equal(sha(readFileSync(join(build,'native/native-card.node'))),manifest.artifact);
const catalog=readFileSync(join(build,'host/s2-catalog.bin')),Z80=loadZ80(root),results=[],images={};
function card(o={}){return new NativeCard(catalog,{addon:join(build,'native/native-card.node'),...o});}
function run(app,cli,o={}){
 const bytes=readFileSync(join(build,'ultrags/dss',app+'.EXE')),h=parseExe(bytes),c=o.card??card(o);
 images[app]={sha256:sha(bytes),size:bytes.length};
 const m=new SprinterMachine({card:c,cardSlot:o.slot??0,commandLine:cli,movingClock:true,files:o.files??{},disk:o.disk??{},turboInit:o.turbo??true,page3Init:0x71+(o.slot??0),logLimit:100,escAfter:o.escAfter??Infinity});
 const fn=m.dssCall.bind(m);m.dssCall=st=>{const r=fn(st);if(r!=='exit'){if(st.c!==0x15)st.ix=0xdead;st.iy=0xbeef;}return r;};
 m.mem.set(bytes,h.loadAddr);const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:o.iff??1,budget:100000000});
 assert.equal(r.exitCode,o.expected??0,app+' '+cli+'\n'+m.text);assert.deepEqual(m.violations,[]);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!r.end.iff1,!!(o.iff??1));assert.equal(r.end.sp,h.stack-2);
 assert(m.maxDiUs<10000&&m.maxWindowUs<10000);assert.equal(m.fileHandles.size,0);
 if(o.expected===1){assert.equal(m.turboWrites,0);assert.equal(c.nativeWrites,0);}
 results.push({app,cli,exit:r.exitCode,steps:r.steps,text:m.text,slot:o.slot??0,iff:o.iff??1,turbo:o.turbo??true,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs});
 console.log('PASS native-C actual EXE',app,cli);return {card:c,m};
}
const opts='/TYPE:RAW /RATE:48000 /CH:1 /BITS:8 /FMT:U8';
for(const app of ['UGCFG','UGMEM','UGLOAD','UGDUMP','UGPLAY','UGMON','UGTEST'])run(app,'/?');
for(const cli of ['PCM /VOICES:32','FX /SECONDS:1','MIX /VOICES:0','MIX /VOICES:257','MIX /SECONDS:0','MIX /VOICES:2 /VOICES:3'])run('UGTEST',cli,{expected:1});
for(const slot of [0,1])for(const iff of [0,1])for(const turbo of [false,true]){
 const c=card({mode:1});run('UGCFG',`ULTRAGS /GSALIAS ON /SLOT:${slot}`,{card:c,slot,iff,turbo});assert(c.gs);
 run('UGCFG',`/GSALIAS OFF /SLOT:${slot}`,{card:c,slot,iff,turbo});assert(!c.gs);
 run('UGCFG',`GSALIAS ON /SLOT:${slot}`,{card:c,slot,iff,turbo});assert(c.gs);
 run('UGMEM',`INFO /SLOT:${slot}`,{card:c,slot,iff,turbo});
 run('UGTEST',`PCM /SLOT:${slot}`,{card:c,slot,iff,turbo});run('UGTEST',`FX /SLOT:${slot}`,{card:c,slot,iff,turbo});
 run('UGTEST',`MIX /VOICES:32 /SECONDS:1 /SLOT:${slot}`,{card:c,slot,iff,turbo});
 const [status,mem]=c.command(2);assert.equal(status,0);assert.equal(mem.readUInt16LE(16),0);assert.equal(mem.readUInt32LE(8),8388608);
}
for(const n of [1,2,3,16,255,256,257,511,512,1023,1024,1025,2051]){
 const data=Buffer.from(Array.from({length:n},(_,i)=>(i*73+(i>>8)*31)&255));
 const {card:c}=run('UGLOAD','T.RAW '+opts+' /VERIFY',{files:{'T.RAW':data}});
 for(const verify of ['', ' /VERIFY']){
  const {m}=run('UGDUMP','1 BACK.RAW'+verify,{card:c,disk:{shortWrite:7}});assert(m.files.get('BACK.RAW').equals(data));if(verify)assert(m.text.includes('host_crc=0x'+crc32(data).toString(16).toUpperCase().padStart(8,'0')),m.text);
 }
 run('UGPLAY','HANDLE 1 /LOOP',{card:c});
 run('UGPLAY','FXHANDLE 1 /LOOP /VOICE:31 /GAIN:1',{card:c});
 run('UGMON','/COUNT:1',{card:c});run('UGPLAY','FXSTOP ALL',{card:c});run('UGPLAY','STOP',{card:c});
 run('UGMEM','FREE 1',{card:c});assert.equal(c.command(2)[1].readUInt16LE(16),0);
}
// Partial disk failures retain an incomplete file and preserve the card object.
for(const disk of [{shortWrite:0},{failFn:0x14}]){
 const data=Buffer.alloc(1025,91),{card:c}=run('UGLOAD','T.RAW '+opts,{files:{'T.RAW':data}});
 run('UGDUMP','1 BACK.RAW /VERIFY',{card:c,disk,expected:5});assert.equal(c.command(2)[1].readUInt16LE(16),1);
}
const exe=process.env.UG_PROPLAY,mod=process.env.UG_PROPLAY_MOD;
if(exe&&mod){
 const bytes=readFileSync(exe),data=readFileSync(mod);assert.equal(sha(bytes),'0fac9cde2ac1490c947046a2ecd033f7d573c9ecdc41a277705ce82479225803');
 for(const slot of [0,1])for(const turbo of [false,true]){
  const c=card({gs:true}),m=new LegacyMachine({card:c,cardSlot:slot,commandLine:' ATDT.MOD',movingClock:true,files:{'ATDT.MOD':data},turboInit:turbo,page3Init:0x71+slot,logLimit:100});
  m.mem.set(bytes,0x8100-22);const r=runImage(Z80,m,{entry:0x8100,stack:0xbfff,budget:30000000});
  assert.equal(r.exitCode,0,m.text);assert.deepEqual(m.violations,[]);assert(m.text.includes('General Sound found at slot: '+slot));
  assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!m.turbo,!!turbo);assert.equal(m.fileHandles.size,0);assert.equal(m.videoMode,3);
  const [e,info]=c.command(22);assert.equal(e,0);const handle=info.readUInt16LE();assert(handle);
  const dump=run('UGDUMP',`${handle} BACK.MOD /VERIFY /SLOT:${slot}`,{card:c,slot,turbo});assert(dump.m.files.get('BACK.MOD').equals(data));assert(dump.m.text.includes('host_crc=0x'+crc32(data).toString(16).toUpperCase().padStart(8,'0')),dump.m.text);
  // The unchanged guest leaves its DSS memory block allocated at EXIT.
  // This harness does not model process teardown; do not claim FREE_MEM.
  results.push({app:'unchanged PROPLAY.EXE',sha256:sha(bytes),modSha256:sha(data),slot,turbo,steps:r.steps,text:m.text,memoryBlockAtExit:m.memoryBlock});
  console.log('PASS unchanged PROPLAY / exact native readback',slot,turbo);
 }
}else console.log('SKIP private PROPLAY: set UG_PROPLAY and UG_PROPLAY_MOD; required for release conformance');
assert.deepEqual(executionInputs(root),before,'ASM changed during actual EXE test');
for(const [path,hash] of Object.entries(manifest.inputs))assert.equal(sha(readFileSync(path)),hash,'C adapter input changed during execution '+path);
mkdirSync(join(build,'host/native'),{recursive:true});
writeFileSync(join(build,'host/native/actual-exe.json'),JSON.stringify({status:'HOST_ACTUAL_EXE_PASS / REAL_PENDING',assembly,adapterSha256:sha(readFileSync(manifestPath)),images,inputs:before,privateProplay:!!(exe&&mod),results},null,2)+'\n');
console.log('PASS',results.length,'actual EXE scenarios against production C');
