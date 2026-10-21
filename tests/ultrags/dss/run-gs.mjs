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
 let nativeOp=0,replyIndex=0,replyLength=0,nativeLost=false,changed=false;
 c.writePort=(p,v)=>{
  if(p===c.base+0x13)assert.equal(delayedDB,0,'client overwrote a busy DATA latch');
  const r=wr(p,v);
  if(p===c.base+0x1b){if([0x30,0x38,0x3e].includes(v))loading=true;if(v===0xd2)loading=false;post=[0x48,0x49].includes(v)?2:v===0x6b?1:0;commands.push(v);if(v===o.loseAck)lost=true;if(v===0x31)started=true;if(v===0x30&&o.cancelUpload)m.escAfter=m.keyCalls+3;}
  if(p===c.base+0x13&&o.delayDB&&(loading||post)){delayedDB=11;if(post)post--;}
  if(p===c.base+3){packet.push(v);if(packet.length===2+packet[1]+((packet[0]&128)?4:0)){nativeOp=packet[0];replyIndex=0;requests.push({op:packet[0]&127,request:Buffer.from(packet.slice(2,2+packet[1])).toString('hex')});packet=[];}}
  return r;
 };
 c.readPort=p=>{let v=rd(p);if(o.corruptRead&&p===c.base)v^=1;if(p===c.base+0x1b){if(delayedDB){if(!o.stallDB)--delayedDB;delayPolls++;v|=128;}if(lost)v|=1;}
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
 m.mem.set(bytes,h.loadAddr);const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:o.iff??1,budget:o.budget??500000000});
 c.writePort=wr;c.readPort=rd;
 assert.equal(r.exitCode,o.expected??0,app+' '+cli+'\n'+m.text+'\n'+JSON.stringify(requests.slice(-6)));assert.deepEqual(m.violations,[]);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!r.end.iff1,!!(o.iff??1));assert.equal(r.end.sp,h.stack-2);assert.equal(m.fileHandles.size,0);
 assert(m.maxDiUs<10000&&m.maxWindowUs<10000);assert(m.minSpSeen>=0xbd90,'stack entered library workspace');
 if(o.expected===1){assert.equal(m.turboWrites,0);assert.equal(requests.length,0);}
 if(cli.includes('/GS')&&app==='UGPLAY'&&!o.expected){assert.equal(requests.filter(r=>r.op===49).length,0);assert.equal(commands.filter(c=>c===0x31).length,1);}
 if(o.loseAck){assert(m.text.includes('UNKNOWN_NOT_RETRIED'));assert.equal(commands.filter(c=>c===o.loseAck).length,1);}
 if(o.delayDB)assert(delayPolls>0);
 if(replacementId&&!o.changeModule)assert.equal(c.command(80)[1].readUInt16LE(20),replacementId);
 if(o.changeModule){assert(changed);assert(!commands.includes(0x31));assert.equal(c.command(22)[1].readUInt16LE(),replacementId);}
 if(o.losePcmAck)assert(nativeLost,'PLAY_PCM ACK fault must execute');
 if(app==='UGPLAY')assert(!commands.some(v=>v===0xf3||v===0xf4));
 results.push({app,cli,exit:r.exitCode,text:m.text,requests,commands,delayPolls,slot:o.slot??0,iff:o.iff??1,turbo:o.turbo??true,virtualPause:!!o.virtualPause,corruptRead:!!o.corruptRead,loseAck:o.loseAck??null,losePcmAck:nativeLost,changeModule:o.changeModule??null,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs,minSp:m.minSpSeen,steps:r.steps});
 console.log('PASS GS actual EXE',app,cli);return {card:c,m};
}
for(const channels of [4,8])for(const slow of ['', ' /SLOW'])for(const verify of ['', ' /VERIFY'])for(const slot of [0,1])for(const iff of [0,1]) {
 const data=makeF00Mod(channels);if(channels===4&&slot===1)data.write('M!K!',1080);
 const {card:c,m}=run('UGPLAY','F00.MOD /GS'+slow+verify+` /SLOT:${slot}`,{slot,iff,turbo:!!iff,files:{'F00.MOD':data}});
 const info=c.command(22)[1],h=info.readUInt16LE(0);assert(h);assert.equal(info.readUInt16LE(4),0);
 assert.equal(c.command(18,Buffer.from([h&255,h>>8]))[1].readUInt32LE(14),crc32(data));assert(!c.gs);
 assert(m.text.includes('GS PLAY repeat'));run('UGMON',`/GS /COUNT:1 /SLOT:${slot}`,{card:c,slot,iff});
 run('UGPLAY',`PAUSE /SLOT:${slot}`,{card:c,slot,iff});assert.equal(c.command(80)[1][24],2);
 run('UGPLAY',`RESUME /SLOT:${slot}`,{card:c,slot,iff});run('UGPLAY',`STOP /SLOT:${slot}`,{card:c,slot,iff});
}
for(const cli of ['F00.MOD /GS /F00:IGNORE','F00.MOD /GS /F00:PAUSE','A.WAV /GS','A.RAW /GS','STREAM A.WAV /GS','FX F00.MOD /GS','HANDLE 1 /GS','FXHANDLE 1 /GS','STOP /GS','PAUSE /GS','RESUME /GS','FXSTOP ALL /GS','F00.MOD /GS /VOICE:0','F00.MOD /GS /GAIN:64','PCM /RESET'])run(cli.startsWith('PCM')?'UGTEST':'UGPLAY',cli,{expected:1});
for(const slot of [0,1]){
 run('UGTEST',`MOD4 /SLOT:${slot}`,{slot,delayDB:true});
 const {m,card:c}=run('UGTEST',`GS /SLOT:${slot}`,{slot,virtualPause:true,delayDB:true});
 for(const name of ['STATUS_7E','SIGN_ROM','CHANNEL_ORDER','LOAD_PAUSE_120S','LOAD_IGNORE','REINIT_FREES_FX','FINETUNE','BUSY_MANUAL','POST_D0_ABORT','EXT_DURING_LOAD','LEGACY_FX_PCM_STATE'])assert(m.text.includes(name));
 assert.equal(c.command(2)[1].readUInt16LE(16),0);
}
const data=makeF00Mod(4),files={'F00.MOD':data};
for(const channels of [4,8])for(const policy of [0,1]){
 const c=card();c.writePort(c.base+0x13,policy);c.writePort(c.base+0x1b,0x6a);c.tickUs(1000);
 run('UGPLAY','F00.MOD /GS',{card:c,files:{'F00.MOD':makeF00Mod(channels)}});c.tickUs(65000);
 assert(!results.at(-1).commands.includes(0x6a),'GS launch must inherit 6A');
 assert.equal(c.command(80)[1][24],policy?1:2,'inherited F00 policy');results.at(-1).inheritedF00=policy;
}
for(const changeModule of ['module','session'])run('UGPLAY','F00.MOD /GS /REPLACE',{files,changeModule,expected:changeModule==='session'?3:7});
for(const cmd of ['MOD4','GS']){
 const {card:c}=run('UGTEST',cmd+' /VERIFY',{virtualPause:true,losePcmAck:true,expected:9});c.tickUs(10000);
 assert.equal(c.command(2)[1].readUInt16LE(16),0,'failed test must free its own PCM and legacy objects');assert.equal(c.command(80)[1].readUInt16LE(54),0);
}
{
 const c=card();c.writePort(c.base+0x1b,0x38);c.tickUs(1000);c.writePort(c.base+0x13,128);c.tickUs(1000);
 const pending=c.command(22)[1];const {m}=run('UGMON','/GS /COUNT:1',{card:c});
 assert(m.text.includes('GS LOAD active'));assert.deepEqual(c.command(22)[1],pending);
 assert(!results.at(-1).commands.some(v=>v>=0x60&&v<=0x64));
}
for(const cmd of [0xd2,0x31]){const {card:c}=run('UGPLAY','F00.MOD /GS',{files,loseAck:cmd,expected:8});assert.equal(c.command(22)[1].readUInt16LE(4),0);}
for(const slow of ['', ' /SLOW']){
 const {card:c}=run('UGPLAY','F00.MOD /GS'+slow,{files,cancelUpload:true,expected:10});assert.equal(c.command(2)[1].readUInt16LE(16),0);
}
run('UGPLAY','F00.MOD /GS /LOOP /WAIT',{files,waitEscape:true,expected:10});
run('UGPLAY','F00.MOD /GS /LOOP /WAIT',{files,waitReplace:true});
run('UGPLAY','F00.MOD /GS /SLOW',{files,delayDB:true,stallDB:true,clock:false,budget:2000000000,expected:8});
// Existing native asset/foreground survives test refusal and failed GS upload.
const {card:c}=run('UGPLAY','F00.MOD /LOOP',{files});c.tickUs(10000);const id=c.command(80)[1].readUInt16LE(20);
for(const cmd of ['GS','MOD4']){run('UGTEST',cmd,{card:c,expected:4});assert.equal(c.command(80)[1].readUInt16LE(20),id);}
run('UGPLAY','F00.MOD /GS',{card:c,files,expected:7});assert.equal(c.command(80)[1].readUInt16LE(20),id);
run('UGPLAY','F00.MOD /GS /REPLACE /VERIFY',{card:c,files,corruptRead:true,expected:9});assert.equal(c.command(80)[1].readUInt16LE(20),id);assert.equal(c.command(22)[1].readUInt16LE(0),0);assert.equal(c.command(2)[1].readUInt16LE(16),1);
run('UGPLAY','F00.MOD /GS /REPLACE',{card:c,files,waitEscape:true});assert.equal(c.command(2)[1].readUInt16LE(16),2);
// Legacy assets require /REPLACE even after STOP.
run('UGPLAY','STOP',{card:c});run('UGPLAY','F00.MOD /GS',{card:c,files,expected:7});
const replaced=run('UGPLAY','F00.MOD /GS /REPLACE',{card:c,files});assert(replaced.m.text.includes('WARNING GS 30'));assert.equal(c.command(2)[1].readUInt16LE(16),2);
run('UGTEST','MOD4 /RESET',{card:c});assert.equal(c.command(2)[1].readUInt16LE(16),0);
// Missing/short file errors precede replacement and never reset independent assets.
for(const disk of [{failFn:0x13},{shortRead:0}])run('UGPLAY','F00.MOD /GS /REPLACE',{card:c,files,disk,expected:5});
// A refused reservation still leaves LOAD open: close that owned empty
// stream without F3/F4 or deleting the independent extent consuming memory.
{
 const d=card(),q=Buffer.alloc(5);q.writeUInt32LE(8388608,1);assert.equal(d.command(16,q)[0],0);
 run('UGPLAY','F00.MOD /GS',{card:d,files,expected:4});assert.equal(d.command(2)[1].readUInt16LE(16),1);d.writePort(d.base+0x1b,0x23);d.tickUs(1000);assert.equal(d.readPort(d.base+0x13),255);
 // A second LOAD must return the same no-memory error, not ack+ignore as data.
 run('UGPLAY','F00.MOD /GS',{card:d,files,expected:4});
}
const originals=[];
for(const path of [process.env.UG_PROPLAY_MOD,process.env.UG_F00_MOD].filter(Boolean)){
 const source=readFileSync(path),hash=sha256(source);originals.push({path:resolve(path),sha256:hash});
 for(const slow of ['', ' /SLOW']){const {card:d}=run('UGPLAY','F00.MOD /GS /VERIFY'+slow,{files:{'F00.MOD':source}});const h=d.command(22)[1].readUInt16LE();assert.equal(d.command(18,Buffer.from([h&255,h>>8]))[1].readUInt32LE(14),crc32(source));}
 assert.equal(sha256(readFileSync(path)),hash);
}
assert.deepEqual(executionInputs(root),before);
assert.deepEqual(verifyBuild(root,join(build,'ultrags/dss')),assembly);
assert.equal(sha256(readFileSync(new URL(import.meta.url))),runnerSha256,'runner changed during execution');
assert.equal(sha256(readFileSync(join(root,'tools/ultrags/gen-f00.mjs'))),fixtureGeneratorSha256);
for(const [p,h]of Object.entries(manifest.inputs))assert.equal(sha256(readFileSync(p)),h);
assert.equal(sha256(readFileSync(join(build,'native/native-card.node'))),manifest.artifact);
mkdirSync(join(build,'evidence'),{recursive:true});
writeFileSync(join(build,'evidence/gs-exe.json'),JSON.stringify({status:'HOST_ACTUAL_EXE_PASS / REAL_PENDING',inputs:before,assembly,images,originals,adapterSha256:sha256(readFileSync(manifestPath)),runnerSha256,fixtureGeneratorSha256,results},null,2)+'\n');
console.log('PASS GS',results.length);
