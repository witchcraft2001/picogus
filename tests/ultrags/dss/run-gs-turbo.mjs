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
function card(){const c=new NativeCard(catalog,{addon:join(build,'native/native-card.node')});c.gs=true;c.syncMap();return c;}
function run(app,cli,o={}) {
 const c=o.card??card(),bytes=readFileSync(join(build,'ultrags/dss',app+'.EXE')),h=parseExe(bytes);images[app]=sha256(bytes);
 const m=new SprinterMachine({card:c,cardSlot:o.slot??0,commandLine:cli,movingClock:o.clock!==false,files:o.files??{},disk:o.disk??{},page3Init:0x71+(o.slot??0),turboInit:o.turbo??true,rejectTurboIsa:false,logLimit:100,escAfter:o.escAfter??Infinity});
 const wr=c.writePort.bind(c),rd=c.readPort.bind(c),requests=[],commands=[];let post=0,loading=false;let packet=[],delayedDB=0,delayPolls=0,lost=false,started=false,waitKeys=0,replacementId=0;
 let nativeOp=0,replyIndex=0,replyLength=0,nativeLost=false,changed=false;
 c.writePort=(port,v)=>{
  assert.equal(m.turbo,port===0xb3||port===0xbb,`wrong speed on write ${port.toString(16)}`);
  const p=port===0xb3?c.base+0x13:port===0xbb?c.base+0x1b:port;
  if(p===c.base+0x13)assert.equal(delayedDB,0,'client overwrote a busy DATA latch');
  const r=wr(port,v);
  if(p===c.base+0x1b){if([0x30,0x38,0x3e].includes(v))loading=true;if(v===0xd2)loading=false;post=[0x48,0x49].includes(v)?2:v===0x6b?1:0;commands.push(v);if(lost&&v!==o.loseAck)lost=false;if(v===o.loseAck)lost=true;if(v===0x31)started=true;if(v===0x30&&o.cancelUpload)m.escAfter=m.keyCalls+3;}
  if(p===c.base+0x13&&o.delayDB&&(loading||post)){delayedDB=11;if(post)post--;}
  if(p===c.base+3){packet.push(v);if(packet.length===2+packet[1]+((packet[0]&128)?4:0)){nativeOp=packet[0];replyIndex=0;requests.push({op:packet[0]&127,request:Buffer.from(packet.slice(2,2+packet[1])).toString('hex')});packet=[];}}
  return r;
 };
 c.readPort=port=>{assert.equal(m.turbo,port===0xb3||port===0xbb,`wrong speed on read ${port.toString(16)}`);const p=port===0xb3?c.base+0x13:port===0xbb?c.base+0x1b:port;let v=rd(port);if(o.corruptRead&&p===c.base)v^=1;if(p===c.base+0x1b){if(delayedDB){if(!o.stallDB)--delayedDB;delayPolls++;v|=128;}if(lost)v|=1;}
  if(p===c.base+3){if(replyIndex===1)replyLength=v;if(o.losePcmAck&&!nativeLost&&(nativeOp&127)===48&&(nativeOp&128)&&replyIndex===2+replyLength+3){v^=1;nativeLost=true;}replyIndex++;}return v;};
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
 m.mem.set(bytes,h.loadAddr);const resident=Buffer.from(m.mem.slice(0x100,0x4000));const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:o.iff??1,budget:o.budget??500000000});
 c.writePort=wr;c.readPort=rd;
 assert.equal(r.exitCode,o.expected??0,app+' '+cli+'\n'+m.text+'\n'+JSON.stringify(requests.slice(-6)));assert.deepEqual(m.violations,[]);assert.deepEqual(Buffer.from(m.mem.slice(0x100,0x4000)),resident);assert.equal(m.residentWrites,0);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!r.end.iff1,!!(o.iff??1));assert.equal(r.end.sp,h.stack-2);assert.equal(m.fileHandles.size,0);
 assert(m.maxDiUs<10000&&m.maxWindowUs<10000);assert(m.minSpSeen>=0xbd90,'stack entered library workspace');
 if(o.expected===1){assert.equal(m.turboWrites,0);assert.equal(requests.length,0);}
 if(cli.includes('/GS')&&app==='UGPLAY'&&!o.expected){assert.equal(requests.filter(r=>r.op===49).length,0);assert.equal(commands.filter(c=>c===0x31).length,1);}
 if(o.loseAck)assert.equal(commands.filter(c=>c===o.loseAck).length,1);
 if(o.delayDB)assert(delayPolls>0);
 if(replacementId&&!o.changeModule)assert.equal(c.command(80)[1].readUInt16LE(20),replacementId);
 if(o.changeModule){assert(changed);assert(!commands.includes(0x31));assert.equal(c.command(22)[1].readUInt16LE(),replacementId);}
 if(o.losePcmAck)assert(nativeLost,'PLAY_PCM ACK fault must execute');
 if(app==='UGPLAY')assert(!commands.some(v=>v===0xf3||v===0xf4));
 results.push({app,cli,exit:r.exitCode,text:m.text,requests,commands,delayPolls,slot:o.slot??0,iff:o.iff??1,turbo:o.turbo??true,virtualPause:!!o.virtualPause,corruptRead:!!o.corruptRead,loseAck:o.loseAck??null,losePcmAck:nativeLost,changeModule:o.changeModule??null,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs,minSp:m.minSpSeen,steps:r.steps,residentWrites:m.residentWrites,exitSP:r.end.sp,clock:o.clock!==false,cancelUpload:!!o.cancelUpload,stallDB:!!o.stallDB,aliases:c.gs});
 console.log('PASS GS actual EXE',app,cli);return {card:c,m};
}

for(const slot of [0,1])for(const iff of [0,1]){
 const app='UGGST'+slot,common={slot,iff,virtualPause:true};
 const {card:c,m}=run(app,'',{...common,delayDB:true});
 assert.equal((m.text.match(/FULL_READBACK/g)||[]).length,4);
 assert(m.text.includes('STATUS_7E')&&m.text.includes('LEGACY_FX_PCM_STATE'));
 assert.equal(c.command(2)[1].readUInt16LE(16),0);
 for(const cli of ['/SLOT:0','GS','/VERIFY','/BASE:2A0'])run(app,cli,{...common,expected:1});
 run(app,'/?',common);
 const busy=card(),q=Buffer.alloc(5);q.writeUInt32LE(19,1);assert.equal(busy.command(16,q)[0],0);
 const before=busy.command(2)[1];run(app,'',{...common,card:busy,expected:4});assert.deepEqual(busy.command(2)[1],before);
 const reset=run(app,'/RESET',{...common,card:busy});assert(reset.m.text.includes('WARNING RESET'));assert.equal(busy.command(2)[1].readUInt16LE(16),0);
 for(const faults of [
  {losePcmAck:true,expected:9},{corruptRead:true,expected:9},{cancelUpload:true,expected:10},
  {loseAck:0xd2,expected:8},{delayDB:true,stallDB:true,clock:false,expected:8,budget:2000000000},
 ]){
  const {card:d,m:failedMachine}=run(app,'',{...common,...faults});d.tickUs(10000);
  assert.equal(d.command(2)[1].readUInt16LE(16),0,'cleanup own objects '+JSON.stringify({slot,iff,faults,text:failedMachine.text,commands:results.at(-1).commands.slice(-12),requests:results.at(-1).requests.slice(-12),state:Array.from(failedMachine.mem.slice(0x5930,0x5940)),session:Array.from(failedMachine.mem.slice(0xbb60,0xbb68))}));
 }
 const off=card();off.gs=false;off.syncMap();run(app,'',{...common,card:off,clock:false,expected:8,budget:2000000000});
}
assert.deepEqual(executionInputs(root),before);assert.deepEqual(verifyBuild(root,join(build,'ultrags/dss')),assembly);
assert.equal(sha256(readFileSync(new URL(import.meta.url))),runnerSha256);
for(const [p,h]of Object.entries(manifest.inputs))assert.equal(sha256(readFileSync(p)),h);
mkdirSync(join(build,'evidence'),{recursive:true});
writeFileSync(join(build,'evidence/gs-turbo-exe.json'),JSON.stringify({status:'DSS_EXE_PASS / REAL_PENDING',inputs:before,assembly,images,adapterSha256:sha256(readFileSync(manifestPath)),runnerSha256,results,limits:'Production C card model; exact EXE instruction execution and DSS RAM/return assertions. No electrical ISA timing simulation.'},null,2)+'\n');
console.log('PASS GS TURBO',results.length);
