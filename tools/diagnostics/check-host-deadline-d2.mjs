// SPDX-License-Identifier: GPL-2.0-or-later
// Smoke the shared timed RPC callers, including the default 60-second MIX.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {NativeCard} from '../../tests/ultrags/dss/native-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {sha256,verifyBuild} from '../ultrags/build-evidence.mjs';
const root=resolve('.'),build=resolve(process.argv[2]),Z80=loadZ80(root);
const catalog=readFileSync('build/config-fast12-delivery/evidence/build-a/generated/multifw/catalog.bin');
const inputs={},results=[],addon=join(build,'native/native-card.node');
for(const variant of ['a','b']){
 const dir=join(build,variant,'ultrags/dss');verifyBuild(root,dir);
 const c=new NativeCard(catalog,{addon}),raw=Buffer.alloc(512,192);
 for(const[app,cli]of [
  ['UGMEM','INFO'],['UGLOAD','T.RAW /TYPE:RAW /RATE:48000 /CH:1 /BITS:8 /FMT:U8 /VERIFY'],
  ['UGPLAY','HANDLE 1 /LOOP'],['UGMON','/COUNT:1'],['UGPLAY','STOP'],
  ['UGDUMP','1 BACK.RAW /VERIFY'],['UGMEM','FREE 1'],
  ['UGBENCH','/BYTES:512 /LOOPS:1 /METHOD:FIXED /CHECK:CRC /DIRECTION:BOTH'],
  ['UGTEST','MIX'],['UGMEM','INFO']
 ]){
  const path=join(dir,app+'.EXE'),exe=readFileSync(path),h=parseExe(exe);inputs[path]=sha256(exe);
  const m=new SprinterMachine({card:c,commandLine:cli,movingClock:true,clockStart:86399,
   files:{'T.RAW':raw},page3Init:0x71,logLimit:100});
  const dss=m.dssCall.bind(m);m.dssCall=st=>{const r=dss(st);if(r!=='exit'){if(st.c!==0x15)st.ix=0xdead;st.iy=0xbeef;}return r;};
  m.mem.set(exe,h.loadAddr);
  const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:1,budget:350000000});
  assert.equal(run.exitCode,0,m.text);assert.deepEqual(m.violations,[]);
  assert.equal(m.system,m.systemInit);assert.equal(m.page3,m.page3Init);
  assert.equal(run.end.sp,h.stack-2);assert(run.end.iff1);assert(m.maxDiUs<10000&&m.maxWindowUs<10000);
  if(app==='UGDUMP')assert.deepEqual(m.files.get('BACK.RAW'),raw);
  if(app==='UGTEST'){
   assert(m.elapsedTicks/21>=60000000,'default MIX did not run 60 seconds');
   assert.equal(c.command(2)[1].readUInt16LE(16),0);
  }
  results.push({variant,app,cli,text:m.text,exit:run.exitCode,elapsedUs:m.elapsedTicks/21});
  console.log('PASS',variant,app,cli);
 }
 assert.equal(c.command(2)[1].readUInt16LE(16),0);
}
for(const p of [addon,'tools/diagnostics/check-host-deadline-d2.mjs'])inputs[resolve(p)]=sha256(readFileSync(p));
writeFileSync(join(build,'host-smoke.json'),JSON.stringify({status:'HOST_PASS / REAL_PENDING',inputs,results,
 limits:['Functional SDK model; 60 seconds are virtual, not a physical audio measurement.']},null,2)+'\n');
