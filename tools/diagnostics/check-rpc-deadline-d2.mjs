// SPDX-License-Identifier: GPL-2.0-or-later
// Delayed SNAPSHOT visibility and fractional DSS clock boundary, actual EXE.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {NativeCard} from '../../tests/ultrags/dss/native-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {sha256,verifyBuild} from '../ultrags/build-evidence.mjs';
const build=resolve(process.argv[2]),onlyOld=process.argv.includes('--baseline-only'),root=resolve('.');
mkdirSync(build,{recursive:true});
const old=resolve('build/r12-audio-diag-delivery/UGTEST.EXE');
const addon=resolve('build/r12-audio-diag/native/native-card.node');
const cat=readFileSync('build/config-fast12-delivery/evidence/build-a/generated/multifw/catalog.bin');
const Z80=loadZ80(root),results=[],inputs={};
const binaries=[['D1',old],...onlyOld?[]:['a','b'].map(v=>[v,join(build,v,'ultrags/dss/UGTEST.EXE')])];
for(const [variant,path]of binaries){
 if(variant!=='D1')verifyBuild(root,join(build,variant,'ultrags/dss'));
 const exe=readFileSync(path),header=parseExe(exe);inputs[path]=sha256(exe);
 for(const phase of [0,.5,.999])for(const cli of ['PCM','FX','MIX /VOICES:32 /SECONDS:1']){
  const c=new NativeCard(cat,{addon});
  const m=new SprinterMachine({card:c,commandLine:cli,movingClock:true,page3Init:0x71,logLimit:100});
  let origin=null,submitted=null,received=null,resets=0;
  const realRead=c.readPort.bind(c),realWrite=c.writePort.bind(c),realDss=m.dssCall.bind(m);
  c.readPort=p=>{
   const v=realRead(p);
   if(origin!==null&&received===null&&p===c.base+1&&(v&4)&&m.mem[0xbc2f]===0x50){
    if(submitted===null)submitted=m.elapsedTicks;
    if((m.elapsedTicks-submitted)/21<5000)return (v&~4)|2;
   }
   if(origin!==null&&received===null&&p===c.base+3&&m.mem[0xbc2f]===0x50)received=m.elapsedTicks;
   return v;
  };
  c.writePort=(p,v)=>{if(p===c.base+2&&v===0xa0)resets++;realWrite(p,v);};
  m.dssCall=st=>{
   const fn=st.c;
   if(fn===0x21&&origin===null&&m.mem[0xbc2f]===0x50)origin=m.elapsedTicks;
   const ret=realDss(st);
   if(fn===0x21&&origin!==null){
    const sec=(86399+Math.floor((m.elapsedTicks-origin)/21000000+phase))%86400;
    st.h=Math.floor(sec/3600);st.l=Math.floor(sec/60)%60;st.b=sec%60;
   }
   if(ret!=='exit'){if(fn!==0x15)st.ix=0xdead;st.iy=0xbeef;}return ret;
  };
  m.mem.set(exe,header.loadAddr);
  const run=runImage(Z80,m,{entry:header.entry,stack:header.stack,iff:1,budget:100000000});
  const fails=variant==='D1'&&phase===.999;
  assert.equal(run.exitCode,fails?8:0,m.text);assert(origin!==null&&submitted!==null);
  if(fails){assert.equal(received,null);assert(m.text.includes('rpc_op=0x50'));assert(resets>0);}
  else {assert(received!==null);assert((received-submitted)/21>=5000);assert.equal(resets,0);}
  assert.deepEqual(m.violations,[]);assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);
  assert.equal(run.end.sp,header.stack-2);assert(run.end.iff1);assert(m.maxWindowUs<10000&&m.maxDiUs<10000);
  assert.equal(c.command(2)[1].readUInt16LE(16),0);
  results.push({variant,cli,phase,exit:run.exitCode,receivedAfterUs:received===null?null:(received-submitted)/21,
   resets,text:m.text,elapsedUs:(m.elapsedTicks-origin)/21});
  console.log('PASS',variant,phase,cli,'exit',run.exitCode);
 }
}
for(const p of [addon,'tools/diagnostics/check-rpc-deadline-d2.mjs','host/sprinter/ultrags/lib/ugwait.asm'])
 inputs[resolve(p)]=sha256(readFileSync(p));
writeFileSync(join(build,onlyOld?'baseline.json':'deadline.json'),JSON.stringify({status:onlyOld?'OLD_FALSE_TIMEOUT_REPRODUCED':'HOST_PASS / REAL_PENDING',
 inputs,results,limits:['Reply visibility delayed 5 ms by harness; not physical ISA timing.',
 'DSS fractional phase is controlled; this reproduces a host bug, not proof of the photographed failure mechanism.']},null,2)+'\n');
