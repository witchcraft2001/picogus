// SPDX-License-Identifier: GPL-2.0-or-later
// Fresh machine bytes against production C. Delays/lost acknowledgements are
// explicit host fault injections, never evidence for physical bus timing.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {NativeCard} from './native-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {crc32} from './config-card.mjs';
import {verifyBuild,executionInputs,sha256} from '../../../tools/ultrags/build-evidence.mjs';
import {makeF00Mod} from '../../../tools/ultrags/gen-f00.mjs';
const root=resolve(process.argv[2]??'.'),build=resolve(process.argv[3]??'build');
const assembly=verifyBuild(root,join(build,'ultrags/dss')),before=executionInputs(root),results=[],images={};
const runnerSha256=sha256(readFileSync(new URL(import.meta.url))),fixtureGeneratorSha256=sha256(readFileSync(join(root,'tools/ultrags/gen-f00.mjs')));
const manifestPath=join(build,'native/native-card-build.json'),manifest=JSON.parse(readFileSync(manifestPath));
for(const [p,h]of Object.entries(manifest.inputs))assert.equal(sha256(readFileSync(p)),h);
assert.equal(sha256(readFileSync(join(build,'native/native-card.node'))),manifest.artifact);
const Z80=loadZ80(root),catalog=readFileSync(join(build,'host/s2-catalog.bin'));
function card(){return new NativeCard(catalog,{addon:join(build,'native/native-card.node')});}
function run(app,cli,o={}) {
 const c=o.card??card(),bytes=readFileSync(join(build,'ultrags/dss',app+'.EXE')),h=parseExe(bytes);images[app]=sha256(bytes);
 const m=new SprinterMachine({card:c,cardSlot:o.slot??0,commandLine:cli,movingClock:o.clock!==false,files:o.files??{},disk:o.disk??{},page3Init:0x71+(o.slot??0),turboInit:o.turbo??true,logLimit:100,escAfter:o.escAfter??Infinity});
 const wr=c.writePort.bind(c),rd=c.readPort.bind(c),requests=[],commands=[];let post=0,loading=false;let packet=[],delayedDB=0,delayPolls=0,lost=false,started=false,waitKeys=0,replacementId=0;
 let timeoutRecovered=false;let readOffset=0,readCount=0,checkedRead=0;let nativeOp=0,replyIndex=0,replyLength=0,nativeLost=false,changed=false;
 c.writePort=(p,v)=>{
  if(p===c.base+0x13)assert.equal(delayedDB,0,'client overwrote a busy DATA latch');
  if(o.timeout&&!timeoutRecovered&&(nativeOp&127)===49&&p===c.base+2&&v===0xa0)timeoutRecovered=true;
  const r=wr(p,v);
  if(p===c.base+0x1b){if([0x30,0x38,0x3e].includes(v))loading=true;if(v===0xd2)loading=false;post=[0x48,0x49].includes(v)?2:v===0x6b?1:0;commands.push(v);if(v===o.loseAck)lost=true;if(v===0x31)started=true;if(v===0x30&&o.cancelUpload)m.escAfter=m.keyCalls+3;}
  if(p===c.base+0x13&&o.delayDB&&(loading||post)){delayedDB=11;if(post)post--;}
  if(p===c.base+3){packet.push(v);if(packet.length===2+packet[1]+((packet[0]&128)?4:0)){nativeOp=packet[0];if((nativeOp&127)===49)started=true;replyIndex=0;requests.push({op:packet[0]&127,request:Buffer.from(packet.slice(2,2+packet[1])).toString('hex')});if((nativeOp&127)===34){readOffset=Buffer.from(packet).readUInt32LE(4);readCount=Buffer.from(packet).readUInt16LE(8);}packet=[];}}
  return r;
 };
 c.readPort=p=>{let v=rd(p);if(app==='UGTEST'&&p===c.base&&readCount){assert.equal(v,fixture[readOffset++],'independent DSS generator/readback byte');readCount--;checkedRead++;}if(o.timeout&&!timeoutRecovered&&(nativeOp&127)===49&&p===c.base+1)v=0;if(o.corruptRead&&p===c.base)v^=1;if(p===c.base+0x1b){if(delayedDB){if(!o.stallDB)--delayedDB;delayPolls++;v|=128;}if(lost)v|=1;}
  if(p===c.base+3){if(replyIndex===1)replyLength=v;if((o.losePcmAck||o.loseNativeAck)&&!nativeLost&&(nativeOp&127)===(o.loseNativeAck??48)&&(nativeOp&128)&&replyIndex===2+replyLength+3){v^=1;nativeLost=true;}replyIndex++;}return v;};
 const fn=m.dssCall.bind(m);m.dssCall=st=>{
  if(st.c===0x12&&o.changeModule&&!changed&&commands.includes(0xd2)){
   changed=true;if(o.changeModule==='session'){c.powerCycle();c.session=c.backend.command(0,Buffer.alloc(0))[1].readBigUInt64LE(12);}
   function gs(v){wr(c.base+0x1b,v);for(let i=0;rd(c.base+0x1b)&1;i++){assert(i<100000);c.tickUs(1000);}}
   gs(0x30);gs(0xd1);for(const v of makeF00Mod(4)){wr(c.base+0x13,v);c.tickUs(10);}gs(0xd2);assert(rd(c.base+0x13));
   replacementId=c.command(22)[1].readUInt16LE();
  }
  if(st.c===0x21&&(lost||o.virtualPause&&m.text.includes('LOAD_PAUSE_120S')&&m.mem[0xbc4e]===120))m.clockStart++;
  if(st.c===0x31&&started&&o.waitEscape&&++waitKeys===3)m.escAfter=m.keyCalls;
  if(st.c===0x31&&started&&o.waitReplace&&++waitKeys===3){
   const handle=c.command(22)[1].readUInt16LE();c.command(50,Buffer.from([0,0,0]));c.tickUs(4000);
   const [e,v]=c.command(49,Buffer.from([handle&255,handle>>8,1]));assert.equal(e,0);replacementId=v.readUInt16LE();c.tickUs(4000);
  }
  const r=fn(st);if(r!=='exit'){if(st.c!==0x15)st.ix=0xdead;st.iy=0xbeef;}return r;
 };
 const resident=m.mem.slice(0x100,0x4000);m.mem.set(bytes,h.loadAddr);const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:o.iff??1,budget:o.budget??500000000});
 c.writePort=wr;c.readPort=rd;
 assert.equal(r.exitCode,o.expected??0,app+' '+cli+'\n'+m.text+'\n'+JSON.stringify(requests.slice(-6)));assert.deepEqual(m.violations,[]);
 assert.equal(m.residentWrites,0);assert.deepEqual(m.mem.slice(0x100,0x4000),resident);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!r.end.iff1,!!(o.iff??1));assert.equal(r.end.sp,h.stack-2);assert.equal(m.fileHandles.size,0);
 assert(m.maxDiUs<10000&&m.maxWindowUs<10000);assert(m.minSpSeen>=0xbd90,'stack entered library workspace');
 if(o.expected===1){assert.equal(m.turboWrites,0);assert.equal(requests.length,0);}
 if(cli.includes('/GS')&&app==='UGPLAY'&&!o.expected){assert.equal(requests.filter(r=>r.op===49).length,0);assert.equal(commands.filter(c=>c===0x31).length,1);}
 if(o.loseAck){assert(m.text.includes('UNKNOWN_NOT_RETRIED'));assert.equal(commands.filter(c=>c===o.loseAck).length,1);}
 if(o.delayDB)assert(delayPolls>0);
 if(replacementId&&!o.changeModule)assert.equal(c.command(80)[1].readUInt16LE(20),replacementId);
 if(o.changeModule){assert(changed);assert(!commands.includes(0x31));assert.equal(c.command(22)[1].readUInt16LE(),replacementId);}
 if(o.losePcmAck||o.loseNativeAck)assert(nativeLost,'PLAY_PCM ACK fault must execute');
 if(app==='UGPLAY')assert(!commands.some(v=>v===0xf3||v===0xf4));
 if(app==='UGTEST'&&!o.expected)assert(checkedRead>=7484);
 results.push({residentWrites:m.residentWrites,exitSP:r.end.sp,checkedRead,app,cli,exit:r.exitCode,text:m.text,requests,commands,delayPolls,slot:o.slot??0,iff:o.iff??1,turbo:o.turbo??true,virtualPause:!!o.virtualPause,corruptRead:!!o.corruptRead,loseAck:o.loseAck??null,losePcmAck:nativeLost,changeModule:o.changeModule??null,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs,minSp:m.minSpSeen,steps:r.steps});
 console.log('PASS GS actual EXE',app,cli);return {card:c,m};
}

const fixturePath=join(build,'host/s8b/fixtures/FLT8.MOD'),fixture=readFileSync(fixturePath);
for(const slot of [0,1])for(const iff of [0,1])for(const turbo of [false,true]){
 const {card:c}=run('UGTEST',`FLT8 /VERIFY /SLOT:${slot}`,{slot,iff,turbo});
 assert.equal(c.command(2)[1].readUInt16LE(16),0);
 assert.equal(c.command(80)[1].readUInt16LE(52),0);
}
run('UGTEST','flt8');
for(const cli of ['FLT8 /SECONDS:1','FLT8 /RESET','FLT8x'])run('UGTEST',cli,{expected:1});
for(const escAfter of [10,40,70]){const {card:c}=run('UGTEST','FLT8 /VERIFY',{escAfter,expected:10});c.tickUs(10000);assert.equal(c.command(2)[1].readUInt16LE(16),0);}
for(const option of [{loseNativeAck:49,expected:9},{timeout:true,expected:8}]){
 const {card:c}=run('UGTEST','FLT8 /VERIFY',option);c.tickUs(10000);assert.equal(c.command(2)[1].readUInt16LE(16),0);
}
{
 const c=card(),q=Buffer.from([0,16,0,0,0]),[status,reply]=c.command(16,q);assert.equal(status,0);
 const h=reply.readUInt16LE();run('UGTEST','FLT8 /VERIFY',{card:c});
 assert.equal(c.command(2)[1].readUInt16LE(16),1);assert.equal(c.command(18,reply.subarray(0,2))[0],0);
 assert.equal(c.command(17,Buffer.from([h&255,h>>8]))[0],0);
}
const files={'FLT8.MOD':fixture};
for(const loseAck of [0xd2,0x31])run('UGPLAY','FLT8.MOD /GS',{files,loseAck,expected:8});
for(const slot of [0,1])for(const iff of [0,1]){
 const {card:c}=run('UGPLAY',`FLT8.MOD /WAIT /VERIFY /SLOT:${slot}`,{files,slot,iff});
 assert.equal(c.command(80)[1][24],3);assert.equal(c.command(2)[1].readUInt16LE(16),1);
 const {m}=run('UGDUMP',`1 BACK.MOD /VERIFY /SLOT:${slot}`,{card:c,slot,iff});assert(m.files.get('BACK.MOD').equals(fixture));
 run('UGMEM',`FREE 1 /SLOT:${slot}`,{card:c,slot,iff});assert.equal(c.command(2)[1].readUInt16LE(16),0);
}
for(const slow of ['', ' /SLOW'])for(const slot of [0,1])for(const iff of [0,1]){
 const opts={files,slot,iff},suffix=` /SLOT:${slot}`;
 const {card:c}=run('UGPLAY','FLT8.MOD /GS /VERIFY'+slow+suffix,opts);
 assert.equal(c.command(80)[1].readUInt16LE(26),8);
 const handle=c.command(22)[1].readUInt16LE();
 const {m}=run('UGDUMP',handle+' BACK.MOD /VERIFY'+suffix,{card:c,slot,iff});assert(m.files.get('BACK.MOD').equals(fixture));
 run('UGPLAY','STOP'+suffix,{card:c,slot,iff});run('UGMEM','FREE '+handle+suffix,{card:c,slot,iff});
}
{
 const {card:c}=run('UGPLAY','FLT8.MOD /LOOP',{files});c.tickUs(10000);const id=c.command(80)[1].readUInt16LE(20);
 run('UGTEST','FLT8',{card:c,expected:4});assert.equal(c.command(80)[1].readUInt16LE(20),id);assert.equal(c.command(2)[1].readUInt16LE(16),1);
 run('UGPLAY','STOP',{card:c});run('UGMEM','FREE 1',{card:c});
}
for(const data of [fixture.subarray(0,7000),fixture.subarray(0,7483)])run('UGLOAD','BAD.MOD /TYPE:MOD',{files:{'BAD.MOD':data},expected:6});
const additionalFiles={};
for(const [name,channels]of [['FLT4.MOD',4],['MOD1.MOD',1],['MOD2.MOD',2],['MOD3.MOD',3],['MOD28.MOD',28],['MOD31.MOD',31],['MOD32.MOD',32],...(process.env.UG_MULTIMOD?[['DOPE.MOD',28]]:[])]){
 const path=name==='DOPE.MOD'?resolve(process.env.UG_MULTIMOD):join(build,'host/s8b/fixtures',name),data=readFileSync(path);
 additionalFiles[path]=sha256(data);
 for(const slot of [0,1])for(const iff of [0,1]){
  const files={[name]:data},suffix=` /SLOT:${slot}`;
  const opts={files,slot,iff,turbo:!!iff,budget:1500000000};
  const {card:c}=run('UGPLAY',name+' /VERIFY'+suffix,opts);c.tickUs(10000);
  assert.equal(c.command(80)[1].readUInt16LE(26),channels);
  const {m}=run('UGDUMP','1 BACK.MOD /VERIFY'+suffix,{card:c,slot,iff,budget:1500000000});assert(m.files.get('BACK.MOD').equals(data));
  run('UGPLAY','STOP'+suffix,{card:c,slot,iff});run('UGMEM','FREE 1'+suffix,{card:c,slot,iff});
  const {card:gs}=run('UGPLAY',name+' /GS /VERIFY'+suffix,opts);gs.tickUs(10000);
  assert.equal(gs.command(80)[1].readUInt16LE(26),channels);
  const handle=gs.command(22)[1].readUInt16LE();
  const dump=run('UGDUMP',handle+' BACK.MOD /VERIFY'+suffix,{card:gs,slot,iff,budget:1500000000});assert(dump.m.files.get('BACK.MOD').equals(data));
  run('UGPLAY','STOP'+suffix,{card:gs,slot,iff});run('UGMEM','FREE '+handle+suffix,{card:gs,slot,iff});
 }
 if(name==='DOPE.MOD')run('UGPLAY',name+' /WAIT',{files:{[name]:data},waitEscape:true,expected:10,budget:1500000000});
 else run('UGPLAY',name+' /WAIT',{files:{[name]:data}});
}
assert.deepEqual(executionInputs(root),before);assert.deepEqual(verifyBuild(root,join(build,'ultrags/dss')),assembly);
mkdirSync(join(build,'evidence'),{recursive:true});writeFileSync(join(build,'evidence/s8b-exe.json'),JSON.stringify({status:'HOST_ACTUAL_EXE_PASS / REAL_PENDING',assembly,inputs:before,images,runnerSha256,fixtureGeneratorSha256,fixtureSha256:sha256(fixture),adapterSha256:sha256(readFileSync(manifestPath)),additionalFiles,results},null,2)+'\n');
console.log('S8b',results.length,'actual EXE scenarios PASS');
