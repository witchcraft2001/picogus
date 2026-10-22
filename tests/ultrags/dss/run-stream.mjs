// SPDX-License-Identifier: GPL-2.0-or-later
// Executes freshly assembled UGPLAY and production C. Functional SDK model;
// modeled CPU/DSS elapsed time is not a physical throughput measurement.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyBuild,executionInputs} from '../../../tools/ultrags/build-evidence.mjs';
import {NativeCard} from './native-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
const root=resolve(process.argv[2]??'.'),build=resolve(process.argv[3]??'build');
const assembly=verifyBuild(root,join(build,'ultrags/dss')),before=executionInputs(root);
const sha=x=>createHash('sha256').update(x).digest('hex');
const runnerSha256=sha(readFileSync(new URL(import.meta.url)));
const addon=join(build,'native/native-card.node'),catalog=readFileSync(process.env.UG_S2_CATALOG??join(build,'host/s2-catalog.bin'));
const exeName=process.env.UG_STREAM_EXE??'UGPLAY.EXE';
const bytes=readFileSync(join(build,'ultrags/dss',exeName)),h=parseExe(bytes),Z80=loadZ80(root),results=[];
if(exeName!=='UGPLAY.EXE'){const fast=JSON.parse(readFileSync(join(build,'ultrags/dss/fast-asm.json')));assert.equal(sha(bytes),fast.sha256);for(const [p,d]of Object.entries(fast.inputs))assert.equal(sha(readFileSync(p)),d,'stale fast EXE '+p);}
const manifest=JSON.parse(readFileSync(join(build,'native/native-card-build.json')));
for(const [p,d]of Object.entries(manifest.inputs))assert.equal(sha(readFileSync(p)),d,'stale adapter '+p);
function run(cli,o={}) {
 const card=o.card??new NativeCard(catalog,{addon});
 let bulk=[],frame=[],requests=[],current=0,responseIndex=0,responseLength=0,flipped=false,producerStart=null,producerEnd=null,cleanup=false,resetSeen=false,statusPolls=0,feedClockCalls=0,sessionChanged=false,closeRejected=false;
 const serviceWindows=new Map();let wireOp=0;
 function serviceByte(){const n=m.windowCount;const w=serviceWindows.get(n)??{bytes:0,op:wireOp};w.bytes++;serviceWindows.set(n,w);}
 const write=card.writePort.bind(card),read=card.readPort.bind(card);
 card.writePort=(p,v)=>{
  if(p===card.base+2 && v===0xa0 && (current&127)===0x47){resetSeen=true;if(o.changeSession&&!sessionChanged){card.powerCycle();card.session=card.backend.command(0,Buffer.alloc(0))[1].readBigUInt64LE(12);sessionChanged=true;}}
  if(p===card.base+2 && v===0xa0 && bulk.length)cleanup=true;
  if(p===card.base){bulk.push(v);if(o.corruptData&&bulk.length===5)v^=1;}
  if(p===card.base+3){if(!frame.length)wireOp=v&127;serviceByte();frame.push(v);if(frame.length>=2&&frame.length===2+frame[1]+((frame[0]&128)?4:0)){
   current=frame[0];requests.push(Buffer.from(frame));responseIndex=0;if((current&127)===0x48)producerEnd=m.elapsedTicks;frame=[];
  }}
  const result=write(p,v);
  if(o.immediate&&(current&127)===0x47&&((p===card.base+3&&!frame.length)||(p===card.base&&bulk.length%1024===0)))card.tickUs(1000);
  return result;
 };
 card.readPort=p=>{let v=read(p);
  if(p===card.base+1&&(current&127)===0x47&&!resetSeen){
   const commit=bulk.length>=1024;
   if((o.stallGrant&&!commit)||(o.stallAck&&commit)||(o.delayPolls&&statusPolls<o.delayPolls)) {statusPolls++;v=2;}
  }
  if(p===card.base+3){serviceByte();
  if(o.loseClose&&!closeRejected&&(current&127)===0x49&&responseIndex===0){v=3;closeRejected=true;}
  if(o.stalledSnapshot && (current&127)===0x50 && responseIndex>=14 && responseIndex<22)v=0;
  if(o.unknownState && cleanup && (current&127)===0x45 && responseIndex===0)v=3;
if(responseIndex===1)responseLength=v;
  if(o.loseAck&&!flipped&&(current&127)===0x47&&(current&128)&&responseIndex===2+responseLength+3){v^=1;flipped=true;}
  responseIndex++;
 }return v;};
 const m=new SprinterMachine({card,cardSlot:o.slot??0,commandLine:cli,movingClock:o.clock!==false,files:o.files??{},disk:o.disk??{},turboInit:o.turbo??true,turboHardware:o.turboHardware??true,page3Init:0x71+(o.slot??0),logLimit:100,allowTurboBulkWrites:exeName!=='UGPLAY.EXE',escAfter:o.escAfter??Infinity});
 let payloadReads=0,payloadReadBytes=0,clockCalls=0,dssCalls=0,delayCycles=0,delayTicks=0;
 const delay=us=>{const cycles=m.cycles,ticks=m.elapsedTicks;m.tick(us*m.cpuHz/1e6);delayCycles+=m.cycles-cycles;delayTicks+=m.elapsedTicks-ticks;};
 const fn=m.dssCall.bind(m);m.dssCall=st=>{dssCalls++;if(st.c===0x13){payloadReads++;payloadReadBytes+=(st.d<<8)|st.e;}if(st.c===0x21){clockCalls++;if(m.mem[0xbc00+47]===0x47)feedClockCalls++;}assert(!(card.transfer && [0x11,0x12,0x13,0x14,0x15,0x31].includes(st.c)),'disk/keyboard inside packet');if(st.c===0x13&&producerStart===null)producerStart=m.elapsedTicks;const r=fn(st);if(st.c===0x13 && o.readDelayUs)delay(o.readDelayUs);if([0x21,0x31].includes(st.c)&&o.serviceDelayUs)delay(o.serviceDelayUs);if(st.c===0x31&&o.cancelAfterFeed&&bulk.length>=1024)st.a=27;if(r!=='exit'){if(st.c!==0x15)st.ix=0xdead;st.iy=0xbeef;}return r;};
 m.mem.set(bytes,h.loadAddr);
 const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:o.iff??1,budget:o.budget??80000000});
 assert.equal(r.exitCode,o.expected??0,cli+'\n'+m.text);assert.deepEqual(m.violations,[]);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!r.end.iff1,!!(o.iff??1));assert.equal(r.end.sp,h.stack-2);assert.equal(m.residentWrites,0);assert(m.minSpSeen>=0xbd90);
 assert(m.maxDiUs<10000 && m.maxWindowUs<10000);assert.equal(m.fileHandles.size,0);
 if(o.expected===1){assert.equal(m.turboWrites,0);assert.equal(card.nativeWrites,0);}
 card.tickUs(10000); // CLOSE is applied at the next audio quantum.
 const [e,mem]=card.command(2);assert.equal(e,0);assert.equal(mem.readUInt16LE(16),o.remaining??0);assert(!card.transfer);
 if((o.expected??0)===0 && cli.startsWith('STREAM ') && !cli.includes('/BENCH:')){const name=cli.split(' ')[1],file=o.files[name];let expected=file;if(name.endsWith('.WAV')){const pos=file.indexOf(Buffer.from('data'));expected=file.subarray(pos+8,pos+8+file.readUInt32LE(pos+4));}assert.deepEqual(Buffer.from(bulk),expected,'exact bytes emitted by Z80');}
 for(const w of serviceWindows.values())assert(w.bytes<=(w.op===0x47?32:8),'service window cap');
 if(o.delayPolls||o.stallGrant||o.stallAck)assert(statusPolls>0,'status injection unused');
 if(o.clock===false)assert(statusPolls>=262144,'stopped-clock watchdog not exercised');
 if(o.immediate)assert.equal(feedClockCalls,0,'immediate FEED must not call SYSTIME');
 if(o.loseClose){assert(closeRejected);assert.equal(requests.filter(x=>(x[0]&127)===0x44).length,1,'continued benchmark after unconfirmed CLOSE');}
 if(o.changeSession)assert(sessionChanged,'session injection unused');
 const feeds=requests.filter(x=>(x[0]&127)===0x47);
 if(o.stallGrant||o.changeSession)assert.equal(feeds.length,1,'unconfirmed packet retried');
 if(o.descriptor){const c=requests.find(x=>(x[0]&127)===0x44);assert(c,'CREATE missing');assert.deepEqual([...c.subarray(2,10)],o.descriptor);}
 if(o.benchmark){
  assert(!requests.some(x=>(x[0]&127)===0x46),'benchmark started playback');
  for(const kind of o.benchmark){
   const match=m.text.match(new RegExp('BENCH '+kind+' bytes=(\\d+) delta_frames=(\\w+) READ_calls=(\\d+) packet_count=(\\d+) Bps=([^\\r\\n]+)'));
   assert(match,'benchmark report missing: '+m.text);
   const [,n,delta,reads,packets,bps]=match;
   if(o.benchBytes!==undefined)assert.equal(+n,o.benchBytes);
   if(kind==='FEED'){assert.equal(+reads,0);assert.equal(+packets,Math.ceil(+n/1024));}
   if(kind==='PIPE'){assert.equal(+packets,Math.ceil(+n/1024));if(o.benchReads)assert.equal(+reads,o.benchReads);const file=o.files[cli.split(' ')[1]];const offset=cli.includes('.WAV')?file.indexOf(Buffer.from('data'))+8:0;assert.deepEqual(Buffer.from(bulk).subarray(bulk.length-(+n)),file.subarray(offset,offset+(+n)),'PIPE exact file data');}
   if(kind==='DISK'){assert.equal(+packets,0);if(o.benchReads)assert.equal(+reads,o.benchReads);}
   if(/^\d+$/.test(bps)){assert(+delta>=6000);assert.equal(+bps,Math.floor(+n*48000/+delta));}
   else assert(bps.includes('unknown'));
  }
 }

 assert(requests.every(x=>![0x20,0x21].includes(x[0]&127)),'separate BEGIN/END in stream');
 for(const f of feeds){assert.equal(f[1],cli.includes('/VERIFY')?13:9);assert.equal(f[10],cli.includes('/VERIFY')?128:0);}
 if(o.unknownState)assert(m.text.includes('underruns=unknown'));
 if(o.loseAck)assert(flipped,'lost ACK injection not exercised');
 const producerSeconds=producerEnd!==null&&producerStart!==null?(producerEnd-producerStart)/21000000:null;
 results.push({loseClose:!!o.loseClose,turbo:o.turbo??true,turboHardware:o.turboHardware??true,dssCalls,z80Tstates:m.cycles-delayCycles,z80Ticks21MHz:m.elapsedTicks-delayTicks,immediate:!!o.immediate,statusPolls,feedClockCalls,stallGrant:!!o.stallGrant,stallAck:!!o.stallAck,clock:o.clock!==false,changeSession:!!o.changeSession,maxServiceBytes:[...serviceWindows.values()].reduce((n,w)=>Math.max(n,w.bytes),0),windowCount:m.windowCount,residentWrites:m.residentWrites,minSp:m.minSpSeen,exitSP:r.end.sp,elapsedTicks:m.elapsedTicks,exeName,payloadReads,payloadReadBytes,clockCalls,readDelayUs:o.readDelayUs??0,serviceDelayUs:o.serviceDelayUs??0,producerSeconds,modeledBytesPerSecond:producerSeconds?bulk.length/producerSeconds:null,feedPackets:feeds.length,payloadBytes:bulk.length,keyCalls:m.keyCalls,modeledSeconds:m.elapsedTicks/21000000,cli,text:m.text,exit:r.exitCode,steps:r.steps,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs,slot:o.slot??0,iff:o.iff??1});
 if(o.maxUnderruns!==undefined){const n=Number(m.text.match(/stream EOF underruns=(\d+)/)?.[1]);assert(Number.isFinite(n)&&n<=o.maxUnderruns,'unexpected rebuffer: '+m.text);}
 if(o.stalledSnapshot)assert(m.text.includes('Bps=unknown'));
 if(o.reliableSpeed)assert(/Bps=\d+/.test(m.text));
 if(o.expectedReadCalls!==undefined)assert.equal(payloadReads,o.expectedReadCalls,'read-ahead DSS call count');
 console.log('PASS stream actual EXE',cli);return {card,m,requests,feeds,bulk:Buffer.from(bulk),payloadReads};
}
function pcm(n){const b=Buffer.alloc(n);for(let i=0;i<n;i++)b[i]=(i*73+(i>>8))&255;return b;}
function wav(data,{before=false,junk=true,format=1,rate=44100,channels=2,bits=16,byteRate=rate*channels*bits/8,align=channels*bits/8}={}){
 const fmt=Buffer.alloc(24);fmt.write('fmt ');fmt.writeUInt32LE(16,4);fmt.writeUInt16LE(format,8);fmt.writeUInt16LE(channels,10);fmt.writeUInt32LE(rate,12);fmt.writeUInt32LE(byteRate,16);fmt.writeUInt16LE(align,20);fmt.writeUInt16LE(bits,22);
 const d=Buffer.alloc(8+data.length+(data.length&1));d.write('data');d.writeUInt32LE(data.length,4);data.copy(d,8);
 const j=Buffer.from('4a554e4b0300000001020300','hex'),body=Buffer.concat([...(before?[d,fmt]:[fmt,d]),...(junk?[j]:[])]),head=Buffer.alloc(12);head.write('RIFF');head.writeUInt32LE(body.length+4,4);head.write('WAVE',8);return Buffer.concat([head,body]);
}
if(process.env.UG_STREAM_PERF==='1'){
for(const readDelayUs of [0,1000,3000])run('STREAM A.RAW /BUFFER:512 /PREFILL:256',{files:{'A.RAW':pcm(131072)},readDelayUs,serviceDelayUs:50});
run('STREAM A.RAW /BUFFER:128 /PREFILL:64',{files:{'A.RAW':pcm(1024*1024)},readDelayUs:3000,serviceDelayUs:50,budget:100000000});
if(process.env.UG_STREAM_BASELINE!=='1')run('STREAM A.RAW /BENCH:PIPE /BUFFER:128',{files:{'A.RAW':pcm(131072)},benchmark:['PIPE'],benchBytes:131072,readDelayUs:3000,serviceDelayUs:50});
}else{
run('/?');
run('STREAM A.RAW /BENCH:ALL /BUFFER:1',{files:{'A.RAW':pcm(1024)},loseClose:true,expected:8});
run('STREAM A.RAW /BENCH:PIPE /BUFFER:1',{files:{'A.RAW':pcm(1024)},benchmark:['PIPE'],benchBytes:1024,immediate:true});
for(const delayPolls of [3,4,5,12])run('STREAM A.RAW /BUFFER:8 /PREFILL:4',{files:{'A.RAW':pcm(8192)},delayPolls});
for(const clock of [true,false]){
 run('STREAM A.RAW /BUFFER:8 /PREFILL:4',{files:{'A.RAW':pcm(8192)},stallGrant:true,clock,expected:3,budget:260000000});
 run('STREAM A.RAW /BUFFER:8 /PREFILL:4',{files:{'A.RAW':pcm(8192)},stallAck:true,clock,budget:260000000});
}
run('STREAM A.RAW /BUFFER:8 /PREFILL:4',{files:{'A.RAW':pcm(8192)},stallAck:true,changeSession:true,expected:3,budget:260000000});
for(const cli of ['STREAM','STREAM A.MOD','STREAM A.RAW /BUFFER:0','STREAM A.RAW /PREFILL:0','STREAM A.RAW /BUFFER:128 /PREFILL:129','STREAM A.RAW /PREFILL:64 /LOW:64','STREAM A.RAW /BUFFER:128 /BUFFER:192','STREAM A.RAW /BUFFER:4194304','A.RAW /BUFFER:128','STREAM A.RAW /LOOP','STREAM A.RAW /SLOW','STREAM A.RAW /RATE:48001 /BITS:16 /CH:2 /FMT:S16LE','STREAM A.RAW /BENCH:DISK /VERIFY','STREAM A.RAW /BENCH:FEED /VERIFY','STREAM A.RAW /BENCH:PIPE /VERIFY','STREAM A.RAW /BENCH:INVALID','STREAM A.RAW /BENCH:ALL /BENCH:ALL','STREAM A.RAW /RATE:22050 /CH:1 /BITS:16'])run(cli,{expected:1});
for(const [buffer,prefill,low] of [[128,64,32],[256,128,32],[512,256,128],[192,96,32]]){
 run(`STREAM A.RAW /BUFFER:${buffer} /PREFILL:${prefill} /LOW:${low}`,{files:{'A.RAW':pcm(4096)}});
}
for(const slot of [0,1])for(const iff of [0,1])for(const turbo of [false,true])
 run(`STREAM A.WAV /BUFFER:1 /PREFILL:1 /LOW:0 /SLOT:${slot}`,{slot,iff,turbo,files:{'A.WAV':wav(pcm(4096),{before:true})}});
run('STREAM A.RAW /BUFFER:1 /PREFILL:1',{files:{'A.RAW':pcm(4096)},turboHardware:false});
run('STREAM A.WAV /VERIFY /BUFFER:1 /PREFILL:1 /LOW:0',{files:{'A.WAV':wav(pcm(2052))},disk:{shortRead:7}});
run('STREAM A.RAW /VERIFY /BUFFER:1 /PREFILL:1 /LOW:0',{files:{'A.RAW':pcm(4096)},loseAck:true});
run('STREAM A.RAW /VERIFY /BUFFER:1 /PREFILL:1 /LOW:0',{files:{'A.RAW':pcm(4096)},corruptData:true,expected:9});
run('STREAM A.RAW /BUFFER:512 /PREFILL:256',{files:{'A.RAW':pcm(131072)},expectedReadCalls:22});
for(const n of [0,4,1020,1024,1028,4092,4096,4100,6140,6144,6148,8196,12288,12292])run('STREAM A.RAW /BUFFER:1 /PREFILL:1 /LOW:0 /VERIFY',{files:{'A.RAW':pcm(n)},disk:{shortRead:7}});
if(process.env.UG_STREAM_LONG==='1')run('STREAM A.RAW /BUFFER:192 /PREFILL:96 /LOW:32',{files:{'A.RAW':pcm(9*1024*1024)},budget:160000000});
for(const data of [Buffer.alloc(3),wav(pcm(40),{format:3}),wav(pcm(41)),wav(pcm(40)).subarray(0,35),Buffer.from('RIFF0000NOPE')])
 run('STREAM BAD.WAV',{files:{'BAD.WAV':data},expected:6});
run('STREAM A.RAW',{files:{'A.RAW':pcm(2051)},expected:6});
for(const rate of [8000,11025,16000,22050,24000,32000,44100,48000,12345,47999])for(const channels of [1,2])for(const fmt of [0,1,2]){
 const bits=fmt===2?16:8,n=1027*channels*bits/8,descriptor=[rate&255,rate>>8,0,0,channels,bits,fmt,0];
 run(`STREAM A.RAW /RATE:${rate} /BITS:${bits} /CH:${channels} /FMT:${['U8','S8','S16LE'][fmt]} /BUFFER:1 /PREFILL:1 /LOW:0`,{files:{'A.RAW':pcm(n)},descriptor,budget:120000000});
 if(fmt!==1)run('STREAM A.WAV /BUFFER:1 /PREFILL:1 /LOW:0',{files:{'A.WAV':wav(pcm(n),{rate,channels,bits,before:true})},descriptor,budget:120000000});
}
for(const params of [{rate:7999},{rate:48001},{bits:24},{format:0xfffe},{channels:3},{byteRate:1},{align:1}])
 run('STREAM BAD.WAV',{files:{'BAD.WAV':wav(pcm(48),params)},expected:6});
for(const exeBench of ['DISK','FEED','PIPE','ALL'])
 run(`STREAM A.WAV /BENCH:${exeBench} /BUFFER:128 /PREFILL:64`,{files:{'A.WAV':wav(pcm(131072))},benchmark:exeBench==='ALL'?['DISK','FEED','PIPE']:[exeBench],benchBytes:131072,benchReads:22,budget:160000000});
run('STREAM A.RAW /BENCH:DISK',{files:{'A.RAW':pcm(1048580)},benchmark:['DISK'],benchBytes:1048576,benchReads:171});
run('STREAM A.RAW /BENCH:FEED /BUFFER:1536',{files:{'A.RAW':pcm(4)},benchmark:['FEED'],benchBytes:1048576,budget:160000000});
run('STREAM A.RAW /BENCH:DISK',{files:{'A.RAW':pcm(4)},benchmark:['DISK'],benchBytes:4,benchReads:1});
run('STREAM A.RAW /BENCH:DISK',{files:{'A.RAW':pcm(2052)},disk:{shortRead:7},benchmark:['DISK'],benchBytes:2052,benchReads:294});
run('STREAM A.RAW /BENCH:FEED /BUFFER:128',{files:{'A.RAW':pcm(4)},cancelAfterFeed:true,benchmark:['FEED'],expected:10});
run('STREAM A.RAW /BENCH:DISK',{files:{'A.RAW':pcm(131072)},benchmark:['DISK'],benchBytes:131072,stalledSnapshot:true});
run('STREAM A.RAW /BUFFER:1 /PREFILL:1',{files:{'A.RAW':pcm(8192)},cancelAfterFeed:true,unknownState:true,expected:10});
run('STREAM A.RAW /BUFFER:1 /PREFILL:1',{files:{'A.RAW':pcm(4096)},unknownState:true});
run('STREAM A.RAW /BENCH:DISK',{files:{'A.RAW':pcm(131072)},benchmark:['DISK'],benchBytes:131072,benchReads:22,readDelayUs:10000,reliableSpeed:true});
run('STREAM A.RAW /BENCH:DISK',{files:{'A.RAW':pcm(8192)},disk:{failFn:0x13},benchmark:['DISK'],expected:5});
run('STREAM A.RAW /BENCH:DISK',{files:{'A.RAW':pcm(131072)},escAfter:12,benchmark:['DISK'],expected:10});
for(const name of ['MONO22.WAV','STEREO22.WAV']){
 if(!existsSync(join(build,'s8c-test-audio',name)))continue;
 const file=readFileSync(join(build,'s8c-test-audio',name));
 run('STREAM '+name+' /BUFFER:128 /PREFILL:64',{files:{[name]:file},maxUnderruns:0,budget:120000000});
}
for(const n of [0,4,1020,1024,1028,6140,6144,6148,131076,1048580])
 run('STREAM A.RAW /BENCH:PIPE /BUFFER:1536',{files:{'A.RAW':pcm(n)},benchmark:['PIPE'],benchBytes:Math.min(n,1048576),benchReads:Math.ceil(Math.min(n,1048576)/6144),budget:160000000});
for(const slot of [0,1])for(const iff of [0,1])for(const turbo of [false,true])
 run(`STREAM A.WAV /BENCH:ALL /BUFFER:8 /SLOT:${slot}`,{slot,iff,turbo,files:{'A.WAV':wav(pcm(8200),{before:true})},benchmark:['DISK','FEED','PIPE'],disk:{shortRead:7}});
for(const benchmark of ['PIPE','ALL']){
 run(`STREAM A.RAW /BENCH:${benchmark}`,{files:{'A.RAW':pcm(8192)},disk:{failFn:0x13},expected:5});
 run(`STREAM A.RAW /BENCH:${benchmark}`,{files:{'A.RAW':pcm(8192)},cancelAfterFeed:true,expected:10});
}
for(const suffix of ['', ' /BENCH:PIPE'])run('STREAM A.RAW'+suffix,{files:{'A.RAW':pcm(8192)},disk:{shortRead:0},expected:5});
run('STREAM MISSING.WAV',{expected:5});
run('STREAM A.RAW /BUFFER:8193',{files:{'A.RAW':pcm(8)},expected:4});
run('STREAM A.RAW /BUFFER:1 /PREFILL:1',{files:{'A.RAW':pcm(8192)},disk:{failFn:0x13},expected:5});
run('STREAM A.RAW /BUFFER:1 /PREFILL:1',{files:{'A.RAW':pcm(8192)},cancelAfterFeed:true,expected:10});
}
for(const [p,d]of Object.entries(manifest.inputs))assert.equal(sha(readFileSync(p)),d,'adapter input changed '+p);
assert.deepEqual(executionInputs(root),before,'ASM changed during run');
assert.equal(sha(readFileSync(new URL(import.meta.url))),runnerSha256,'runner changed during execution');
mkdirSync(join(build,'evidence'),{recursive:true});
writeFileSync(join(build,'evidence/'+(process.env.UG_STREAM_PERF==='1'?(exeName==='UGPLAY.EXE'?'performance-standard':'performance-fast'):exeName==='UGPLAY.EXE'?'actual-exe':'actual-exe-fast')+'.json'),JSON.stringify({status:'HOST_ACTUAL_EXE_PASS / REAL_PENDING',runnerSha256,assembly,inputs:before,exeSha256:sha(bytes),adapterSha256:sha(readFileSync(addon)),results},null,2)+'\n');
console.log('PASS',results.length,'stream scenarios');
