// SPDX-License-Identifier: GPL-2.0-or-later
// Execute the delivered Z80 tool against production C; inject wire lengths.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {NativeCard} from '../../tests/ultrags/dss/native-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {sha256,verifyBuild} from '../ultrags/build-evidence.mjs';
const root=resolve('.'),build=resolve(process.argv[2]),prior=resolve('build/config-fast12-delivery');
const deadlineFix=process.argv.includes('--deadline-fix'),label=deadlineFix?'UGTEST-D2':'UGTEST-D1';
const Z80=loadZ80(root),catalog=readFileSync(join(prior,'evidence/build-a/generated/multifw/catalog.bin'));
const adapter=join(build,'native/native-card.node'),meta=JSON.parse(readFileSync(join(build,'native/native-card-build.json')));
for(const[p,h]of Object.entries(meta.inputs))assert.equal(sha256(readFileSync(p)),h);
assert.equal(sha256(readFileSync(adapter)),meta.artifact);
const results=[],inputs={};
for(const variant of ['a','b']){
 const dir=join(build,variant,'ultrags/dss'),manifest=verifyBuild(root,dir);
 for(const e of manifest.files.filter(e=>!e.name.startsWith('ST-'))){
  const bytes=readFileSync(join(dir,e.name));
  if(e.name!=='UGTEST.EXE'&&!deadlineFix)assert.deepEqual(bytes,readFileSync(join(prior,e.name)));
  if(variant==='b')assert.deepEqual(bytes,readFileSync(join(build,'a/ultrags/dss',e.name)));
 }
 const exe=readFileSync(join(dir,'UGTEST.EXE')),h=parseExe(exe);
 inputs[join(dir,'UGTEST.EXE')]=sha256(exe);
 for(const cli of ['PCM','FX','MIX /VOICES:32 /SECONDS:1'])for(const fault of [null,'headerFF','length63','snapshotStatus','configLength']){
  const c=new NativeCard(catalog,{addon:adapter});
  const m=new SprinterMachine({card:c,commandLine:cli,movingClock:true,page3Init:0x71,logLimit:100});
  let count=0,injected=false;const op=fault==='configLength'?0x14:0x50,read=c.readPort.bind(c);
  c.readPort=p=>{
   const v=read(p);
   if(fault&&!injected&&p===c.base+3&&m.mem[0xbc2f]===op){
    count++;
    if(count===(fault==='snapshotStatus'?1:2)){
     injected=true;
     return fault==='headerFF'?255:fault==='length63'?63:fault==='snapshotStatus'?2:1;
    }
   }
   return v;
  };
  const dss=m.dssCall.bind(m);m.dssCall=st=>{const ret=dss(st);if(ret!=='exit'){if(st.c!==0x15)st.ix=0xdead;st.iy=0xbeef;}return ret;};
  m.mem.set(exe,h.loadAddr);
  const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:1,budget:100000000});
  assert.equal(run.exitCode,fault?3:0,m.text);
  assert.deepEqual(m.violations,[]);assert.equal(m.page3,m.page3Init);
  assert.equal(m.system,m.systemInit);assert.equal(run.end.sp,h.stack-2);assert(run.end.iff1);
  assert(m.maxDiUs<10000&&m.maxWindowUs<10000);
  if(fault){
   assert(injected);
   const head=fault==='headerFF'?'00:FF':fault==='length63'?'00:3F':fault==='snapshotStatus'?'02:40':'00:01';
   const wrapper=['length63','configLength'].includes(fault)?'02':'01';
   const expected=fault==='configLength'?'00':'40';
   const got=fault==='length63'?'003F':fault==='configLength'?'0001':'FFFF';
   assert(m.text.includes(`${label} rpc_op=0x${op.toString(16).toUpperCase()} frame_status:len=0x${head} wrapper=0x${wrapper} expected=0x${expected} got=0x${got}`),m.text);
  }else assert(!m.text.includes(label));
  c.tickUs(10000);
  const [status,mem]=c.command(2);
  assert.equal(status,0);assert.equal(mem.readUInt16LE(16),0,'temporary object leaked');
  assert.equal(mem.readUInt32LE(8),8388608);
  results.push({variant,cli,fault,exit:run.exitCode,text:m.text,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs});
  console.log('PASS',variant,cli,fault??'normal');
 }
}
for(const p of ['tools/diagnostics/check-ugtest-rpc-d1.mjs','host/sprinter/ultrags/lib/ugtestpcm.asm',
 'host/sprinter/ultrags/apps/ugmem.asm','tests/ultrags/dss/native-card.mjs','tests/ultrags/dss/ug-harness.mjs',
 adapter,join(build,'native/native-card-build.json')])inputs[resolve(p)]=sha256(readFileSync(p));
writeFileSync(join(build,'actual-exe.json'),JSON.stringify({status:'HOST_PASS / REAL_PENDING',inputs,results,
 limits:['Production C with functional SDK; no electrical timing or real audio verification.',
 deadlineFix?'Shared host RPC deadline corrected; firmware remains R12.':
 'Only UGTEST changed; firmware and eight other tools remain byte-identical to R12.']},null,2)+'\n');
