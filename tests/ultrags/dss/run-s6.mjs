// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {PcmCard,rawDescriptor} from './pcm-card.mjs';
import {verifyBuild,executionInputs} from '../../../tools/ultrags/build-evidence.mjs';
const root=resolve(process.argv[2]||'.'),build=resolve(process.argv[3]||'build'),Z80=loadZ80(root),before=executionInputs(root),assembly=verifyBuild(root,join(build,'ultrags/dss'));
const catalog=readFileSync(process.env.UG_S2_CATALOG||join(build,'host/s2-catalog.bin')),results=[],executed=new Map();
function test(name,app,cli,expected=0,o={}) {
 const bytes=readFileSync(join(build,'ultrags/dss',app+'.EXE')),h=parseExe(bytes),card=o.card??new PcmCard(catalog,o);
 executed.set(app,{name:app+'.EXE',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 const m=new SprinterMachine({card,cardSlot:o.slot??0,commandLine:cli,movingClock:!o.stopped,clockStart:o.clockStart??86399,escAfter:o.escAfter??Infinity,files:o.files??{},disk:o.disk??{},turboInit:o.turbo??true,turboHardware:o.hardware??true,page3Init:o.page3??3,logLimit:1000});
 const listing=readFileSync(join(build,'ultrags/dss',app.toLowerCase()+'.lst'),'utf8');
 for(const line of listing.split('\n')){const match=line.match(/\+*([0-9A-F]{4})\s+UG_CRC32(?:_FOLD)?:\s*$/);if(match)m.crcEntries.add(parseInt(match[1],16));}
 const call=m.dssCall.bind(m);m.dssCall=st=>{o.onDss?.(st,card,m);const v=call(st);if(v!=='exit'){if(st.c!==0x15)st.ix=0xdead;st.iy=0xbeef;}return v;};
 m.mem.set(bytes,h.loadAddr);const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:o.iff??1,budget:o.budget??100000000});
 card.tickUs(3000); // accepted controls become visible at the next quantum (<=10 ms)
 const errors=[...m.violations];if(m.maxDiUs>=10000||m.maxWindowUs>=10000)errors.push('ISA/DI budget');
 if(m.page3!==m.page3Init||m.system!==m.systemInit||!!run.end.iff1!==!!(o.iff??1)||run.end.sp!==h.stack-2)errors.push('context');
 if(m.turboWrites&&!m.turbo)errors.push('Turbo DSS');if(m.fileHandles.size)errors.push('file leaked');
 if(expected===1||cli==='/?')if(m.turboWrites||card.calls.length)errors.push('hardware touched for syntax/help');
 if(expected===0&&!/VERIFY/.test(cli)&&m.crcCalls)errors.push('host CRC in FAST');
 if(o.check&&!o.check(card,m))errors.push('postcondition');
 const ok=run.exitCode===expected&&m.text.includes(`RESULT ${expected?'FAIL':'PASS'} code=${expected}`)&&!errors.length;
 results.push({name,ok,exit:run.exitCode,expected,text:m.text,errors,steps:run.steps,maxWindowUs:m.maxWindowUs,maxDiUs:m.maxDiUs,hostCrcCalls:m.crcCalls});
 console.log(`${ok?'PASS':'FAIL'} S6 ${name} exit=${run.exitCode}`+(ok?'':JSON.stringify({text:m.text,errors,trace:card.trace.slice(-15),fg:card.foreground,events:card.events,frames:String(card.frames),snap:Buffer.from(m.mem.slice(0x5b00,0x5b38)).toString('hex'),av:Buffer.from(m.mem.slice(0x5a00,0x5a30)).toString('hex')})));if(!ok)throw Error(name);return {card,m};
}
// Replay fixtures emitted by the compiled production storage/PCM code.
const shared=new PcmCard(catalog);shared.session=17n;let sharedCount=0;
for(const line of readFileSync(join(build,'host/s6/s6-commands.jsonl'),'utf8').trim().split('\n')) {
 const f=JSON.parse(line);sharedCount++;
 if(f.render){shared.render(f.render);continue;}
 if(f.data){for(const b of Buffer.from(f.data,'hex'))shared.writePort(shared.base+0x13,b);continue;}
 const [status,r]=shared.command(f.op,Buffer.from(f.q,'hex'));
 if(status!==f.status||!r.equals(Buffer.from(f.r,'hex')))throw Error('S6 C/model mismatch '+JSON.stringify({f,status,r:r.toString('hex')}));
 if([32,34].includes(f.op)&&!status){shared.transfer.granted=true;shared.transfer.last=shared.now;}
}
console.log('PASS S6 shared production C/model vectors '+sharedCount);
test('UGTEST rejects memory verb before hardware','UGTEST','FREE 1',1);
test('UGTEST PCM help','UGTEST','PCM /?');
const raw=Buffer.alloc(257,192),opts='/RATE:11025 /BITS:8 /CH:1 /FMT:U8';
function wav(n=48000,ch=1,bits=8,rate=48000) {const b=Buffer.alloc(44+n+(n&1));b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(ch,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*ch*bits/8,28);b.writeUInt16LE(ch*bits/8,32);b.writeUInt16LE(bits,34);b.write('data',36);b.writeUInt32LE(n,40);b.fill(192,44);return b;}
function mod4(){const b=Buffer.alloc(1084+1024);b.write('M.K.',1080);b[950]=1;return b;}
function asset(c,ch=1,size=48000){const [e,r]=c.command(16,Buffer.from([1,size&255,(size>>>8)&255,(size>>>16)&255,0]));if(e)throw Error('asset');const h=r.readUInt16LE(),o=c.objects.get(h);o.data.fill(192);o.uploaded=size;c.command(20,Buffer.concat([r.subarray(0,2),rawDescriptor(size,48000,ch)]));c.command(19,Buffer.concat([r.subarray(0,2),Buffer.alloc(5)]));return h;}
for(const app of ['UGLOAD','UGPLAY','UGMON'])test(app+' help',app,'/?');
let {card}=test('RAW verify','UGLOAD',`T.RAW /TYPE:RAW ${opts} /VERIFY`,0,{files:{'T.RAW':raw},check:c=>c.objects.size===1&&c.objects.get(1).state===1&&!c.objects.get(1).pins});
test('handle WAIT','UGPLAY','HANDLE 1 /WAIT',0,{card,check:c=>c.objects.size===1&&!c.objects.get(1).pins});
test('handle repeat','UGPLAY','HANDLE 1 /WAIT',0,{card});
test('WAV WAIT','UGPLAY','T.WAV /WAIT',0,{files:{'T.WAV':wav(4000)},check:c=>c.objects.size===1&&!c.objects.get(1).pins});
test('RAW file','UGPLAY',`T.RAW ${opts} /WAIT`,0,{files:{'T.RAW':raw}});
const mod=mod4();
let modRun=test('MOD4 verified upload','UGLOAD','FOUR.MOD /TYPE:MOD /VERIFY',0,{files:{'FOUR.MOD':mod},check:c=>c.objects.size===1&&c.objects.get(1).kind===3&&c.objects.get(1).state===1});
test('MOD4 native handle repeat','UGPLAY','HANDLE 1 /LOOP',0,{card:modRun.card,check:c=>c.foreground?.mod&&c.objects.get(1).pins===1});
test('MOD4 snapshot tracker fields','UGMON','/COUNT:1 /HZ:10',0,{card:modRun.card,check:c=>c.foreground?.mod&&c.foreground.tracker.speed===6});
test('MOD4 STOP retains READY','UGPLAY','STOP',0,{card:modRun.card,check:c=>!c.foreground&&c.objects.get(1).state===1&&c.objects.get(1).pins===0});
for(const cli of ['T.RAW','T.RAW /RATE:7999 /BITS:8 /CH:1 /FMT:U8','T.RAW /RATE:8000 /BITS:16 /CH:1 /FMT:U8','HANDLE 65536','HANDLE 0x10000','LIST X','SEEK 0 0','T.WAV /GS','FXHANDLE 1 /VOICE:7','FXHANDLE 1 /PRIORITY:0','FXHANDLE 1 /PRIORITY:255'])test('syntax '+cli,'UGPLAY',cli,1);
for(const cli of ['STOP /GAIN:1','PAUSE /PAN:2','RESUME /PRIORITY:128','FXSTOP 1 /VOICE:8','HANDLE 1 /SLOW','HANDLE 1 /CRC:00000000','HANDLE 1 /TYPE:WAV','T.WAV /TYPE:RAW','HANDLE 1 /VOICE:255','HANDLE 1 /PRIORITY:128'])test('ignored option rejected '+cli,'UGPLAY',cli,1);
for(const cli of ['/HZ:0','/HZ:11','/COUNT:0','/COUNT:4294967296','/GS','X'])test('monitor syntax '+cli,'UGMON',cli,1);
card=new PcmCard(catalog);asset(card);test('loop foreground','UGPLAY','HANDLE 1 /LOOP',0,{card});
test('replace required','UGPLAY','HANDLE 1',7,{card,check:c=>c.foreground?.id===1});
test('pause','UGPLAY','PAUSE',0,{card,check:c=>c.foreground?.paused});
test('paused replace required','UGPLAY','HANDLE 1',7,{card});
test('resume','UGPLAY','RESUME',0,{card,check:c=>!c.foreground?.paused});
test('replacement valid','UGPLAY','HANDLE 1 /REPLACE /LOOP',0,{card});
for(let i=0;i<4;i++)test('FX '+i,'UGPLAY','FXHANDLE 1 /LOOP',0,{card,check:c=>c.foreground&&c.fx.length===i+1});
test('NO_VOICE','UGPLAY','FXHANDLE 1',7,{card,check:c=>c.fx.length===4&&!!c.foreground});
test('FXPAUSE','UGPLAY','FXPAUSE 1',0,{card,check:c=>c.fx[0].paused});
test('FXRESUME','UGPLAY','FXRESUME 1',0,{card,check:c=>!c.fx[0].paused});
test('monitor','UGMON','/COUNT:2 /HZ:10',0,{card,check:(c,m)=>c.fx.length===4&&!!c.foreground&&m.text.match(/output_frames=/g)?.length===2});
test('FXSTOP ALL','UGPLAY','FXSTOP ALL',0,{card,check:c=>!c.fx.length&&!!c.foreground});
test('STOP','UGPLAY','STOP',0,{card,check:c=>!c.foreground&&c.objects.size===1});
test('FREE','UGMEM','FREE 1',0,{card,check:c=>!c.objects.size});
test('UGTEST PCM','UGTEST','PCM',0,{check:c=>!c.objects.size&&!c.foreground&&!c.fx.length});
test('UGTEST FX','UGTEST','FX',0,{check:c=>!c.objects.size&&!c.foreground&&!c.fx.length});
for(const [suite,op] of [['PCM',48],['FX',54]])test('UGTEST lost PLAY cleanup '+suite,'UGTEST',suite,8,{noReplyOp:op,
 check:c=>c.calls.filter(x=>x===op).length===1&&!c.objects.size&&!c.foreground&&!c.fx.length});
card=new PcmCard(catalog,{noReplyOp:54});asset(card);card.command(48,Buffer.from([1,0,0,0,64,128]));card.render(1);
test('UGTEST lost FX keeps foreign foreground','UGTEST','FX',8,{card,
 check:c=>c.objects.size===1&&c.objects.has(1)&&c.objects.get(1).pins===1&&c.foreground?.handle===1&&!c.fx.length});
card=new PcmCard(catalog);const withoutFx=card.command.bind(card);
card.command=(op,q,defer=false)=>{const r=withoutFx(op,q,defer);if(op===1&&!r[0])r[1][1]&=~1;return r;};
test('UGTEST FX capability before allocation','UGTEST','FX',3,{card,check:c=>!c.calls.includes(16)&&!c.objects.size});
// Context matrix for every new application and both transport paths.
for(const slot of [0,1])for(const iff of [0,1])for(const turbo of [false,true])for(const hardware of [false,true]) {
 const o={slot,iff,turbo,hardware,page3:0x71+slot},tag=`${slot}-${iff}-${turbo}-${hardware}`;
 test('RAW context '+tag,'UGLOAD',`T.RAW /TYPE:RAW ${opts} /SLOT:${slot}${iff?' /SLOW':''}`,0,{...o,files:{'T.RAW':raw},check:c=>c.objects.size===1&&c.objects.get(1).pcm.frames===257});
 test('WAV WAIT context '+tag,'UGPLAY',`T.WAV /WAIT /SLOT:${slot}`,0,{...o,files:{'T.WAV':wav(1024)}});
 test('monitor context '+tag,'UGMON',`/COUNT:1 /SLOT:${slot}`,0,o);
}
for(const app of ['UGLOAD','UGPLAY','UGMON'])for(const [cli,o,code] of [
 [app==='UGLOAD'?`T.RAW /TYPE:RAW ${opts}`:app==='UGPLAY'?'HANDLE 1':'/COUNT:1',{absent:true},2],
 [app==='UGLOAD'?`T.RAW /TYPE:RAW ${opts}`:app==='UGPLAY'?'HANDLE 1':'/COUNT:1',{mode:1},2],
 [app==='UGLOAD'?`T.RAW /TYPE:RAW ${opts}`:app==='UGPLAY'?'HANDLE 1':'/COUNT:1',{api:2},3],
])test(app+' reject '+JSON.stringify(o),app,cli,code,o);
for(const cli of ['T.RAW /TYPE:RAW /RATE:8000 /BITS:8 /CH:1','T.RAW /TYPE:RAW /RATE:48001 /BITS:8 /CH:1 /FMT:U8','T.WAV /TYPE:WAV /RATE:8000'])test('load syntax '+cli,'UGLOAD',cli,1);
for(const hz of [1,3,5,7,10])test('monitor interval '+hz,'UGMON',`/COUNT:3 /HZ:${hz}`,0,{check:(c,m)=>m.text.match(/output_frames=/g)?.length===3});
test('monitor ESC preserves sound','UGMON','',0,{card,escAfter:3,check:c=>!c.foreground});
test('monitor stalled card frames','UGMON','/COUNT:2',8,{stoppedAudio:true});
test('monitor both clocks stopped','UGMON','/COUNT:2',8,{stoppedAudio:true,stopped:true,budget:200000000});
for(const [name,cli,files,disk,code] of [
 ['missing file',`MISSING.RAW ${opts}`,{},{},5],
 ['disk read',`T.RAW ${opts}`,{'T.RAW':raw},{shortRead:0},5],
 ['nonintegral frames','T.RAW /RATE:8000 /BITS:16 /CH:2 /FMT:S16LE',{'T.RAW':raw},{},6],
 ['malformed RIFF','T.WAV',{'T.WAV':raw},{},6],
 ['short file reads','T.WAV /WAIT',{'T.WAV':wav(512)},{shortRead:7},0],
])test(name,'UGPLAY',cli,code,{files,disk,check:c=>code===0?c.objects.size===1:!c.objects.size});
test('RAW manifest mismatch','UGLOAD',`T.RAW /TYPE:RAW ${opts} /CRC:00000000`,9,{files:{'T.RAW':raw},check:c=>!c.objects.size});
test('PCM capability before allocation','UGPLAY','T.WAV',3,{noCaps:true,files:{'T.WAV':wav()},check:c=>!c.objects.size&&!c.calls.includes(16)});
for(const app of ['UGLOAD','UGPLAY']) {
 const c=new PcmCard(catalog);let resetBeforeAllocation=false;
 test('session change before allocation '+app,app,app==='UGLOAD'?`T.RAW /TYPE:RAW ${opts}`:'T.WAV',3,{card:c,files:{'T.RAW':raw,'T.WAV':wav(16)},
  onDss:(st,c)=>{if(!resetBeforeAllocation&&c.calls.at(-1)===1&&c.calls.filter(op=>op===1).length===2){resetBeforeAllocation=true;c.session++;asset(c,1,16);}},
  check:(c,m)=>c.objects.size===1&&c.objects.get(1)?.size===16&&c.calls.filter(op=>op===16).length===0&&m.text.includes('SESSION_CHANGED')});
}
for(const op of [16,33,48,54]) {
 const fx=op===54;
 test('lost ACK '+op,'UGPLAY',`${fx?'FX ':''}T.WAV /LOOP`,op===48||op===54?0:8,{noReplyOp:op,files:{'T.WAV':wav()},budget:150000000,
 check:(c,m)=>c.calls.filter(x=>x===op).length===1&&c.resets>0&&(op===16?c.objects.size===1:op===33?!c.objects.size:c.objects.get(1)?.state===1&&(c.foreground||c.fx.length))});
}
test('lost short FX unknown','UGPLAY','FX T.WAV',8,{noReplyOp:54,files:{'T.WAV':wav(4)},check:(c,m)=>c.objects.get(1)?.state===1&&!c.fx.length&&m.text.includes('PLAY_RESULT_UNKNOWN')});
test('lost SEAL ACK keeps READY','UGLOAD',`T.RAW /TYPE:RAW ${opts}`,8,{noReplyOp:19,files:{'T.RAW':raw},budget:200000000,
 check:(c,m)=>c.resets>0&&c.calls.filter(x=>x===19).length===1&&c.objects.get(1)?.state===1&&!c.objects.get(1).pins&&m.text.includes('SEAL_RESULT_READY_NOT_RETRIED')&&m.text.includes('handle=0x0001')});
test('lost WAV SEAL ACK keeps READY','UGPLAY','T.WAV',8,{noReplyOp:19,files:{'T.WAV':wav(16)},budget:200000000,
 check:(c,m)=>c.objects.get(1)?.state===1&&!c.foreground&&m.text.includes('SEAL_RESULT_READY_NOT_RETRIED')});
card=new PcmCard(catalog,{noReplyOp:19});const sealCommand=card.command.bind(card);let sealReset=false;
card.command=(op,q,defer=false)=>{const r=sealCommand(op,q,defer);if(op===19&&!sealReset){sealReset=true;card.session++;card.objects.clear();card.next=1;asset(card,1,16);}return r;};
test('lost SEAL session change preserves new asset','UGLOAD',`T.RAW /TYPE:RAW ${opts}`,8,{card,files:{'T.RAW':raw},budget:200000000,
 check:(c,m)=>c.objects.size===1&&c.objects.get(1)?.size===16&&c.objects.get(1)?.state===1&&!c.calls.includes(17)&&m.text.includes('SEAL_RESULT_UNKNOWN_NOT_RETRIED')});
card=new PcmCard(catalog);asset(card);test('WAIT ESC foreground','UGPLAY','HANDLE 1 /LOOP /WAIT',10,{card,onDss:(st,c,m)=>{if(st.c===0x31&&c.foreground)m.escAfter=0;},check:c=>!c.foreground&&c.objects.get(1).pins===0});
test('background survives FX WAIT ESC','UGPLAY','HANDLE 1 /LOOP',0,{card});
test('FX WAIT ESC targeted','UGPLAY','FXHANDLE 1 /LOOP /WAIT',10,{card,onDss:(st,c,m)=>{if(st.c===0x31&&c.fx.length)m.escAfter=0;},check:c=>!!c.foreground&&!c.fx.length&&c.objects.get(1).pins===1});
test('invalid replacement preserves music','UGPLAY','BAD.WAV /REPLACE',6,{card,files:{'BAD.WAV':raw},check:c=>!!c.foreground&&c.objects.size===1});
test('monitor ESC preserves playing PCM','UGMON','',0,{card,escAfter:2,check:c=>!!c.foreground});
let switched=false;test('WAIT specific replaced instance','UGPLAY','HANDLE 1 /LOOP /WAIT /REPLACE',0,{card,onDss:(st,c,m)=>{if(st.c===0x31&&m.mem[0xbc57]&&c.foreground?.id===(m.mem[0x5a06]|m.mem[0x5a07]<<8)&&!switched){switched=true;c.command(48,Buffer.from([1,0,0,0,64,128]));}},check:c=>c.foreground?.id===4});
card=new PcmCard(catalog);asset(card,2);test('stereo first','UGPLAY','FXHANDLE 1 /LOOP /VOICE:8',0,{card,check:c=>c.fx[0].mask===0x300});
test('stereo second','UGPLAY','FXHANDLE 1 /LOOP /VOICE:10',0,{card,check:c=>c.fx[1].mask===0xc00});
test('stereo NO_VOICE atomic','UGPLAY','FXHANDLE 1',7,{card,check:c=>c.fx.length===2&&c.objects.get(1).pins===2});
test('stereo higher priority steal','UGPLAY','FXHANDLE 1 /VOICE:8 /STEAL /PRIORITY:200 /LOOP',0,{card,check:c=>c.fx.length===2&&c.fx.some(x=>x.id===3&&x.mask===0x300)&&c.objects.get(1).pins===2});
test('stereo odd voice rejected','UGPLAY','FXHANDLE 1 /VOICE:9',6,{card,check:c=>c.fx.length===2});
for(const handle of [1,255,256,32767,32768,65535]){const c=new PcmCard(catalog);c.next=handle;asset(c);test('u16 handle '+handle,'UGPLAY',`HANDLE ${handle} /WAIT`,0,{card:c,check:c=>c.objects.has(handle)});}
card=new PcmCard(catalog);asset(card);let changed=false;test('WAIT session changed','UGPLAY','HANDLE 1 /LOOP /WAIT',3,{card,onDss:(st,c)=>{if(st.c===0x31&&c.foreground&&!changed){changed=true;c.session++;}},check:c=>c.objects.size===1});
// A second upload and original byte readback while PCM + independent FX keep running.
card=new PcmCard(catalog);asset(card);test('concurrent foreground','UGPLAY','HANDLE 1 /LOOP',0,{card});
for(let i=0;i<4;i++)test('concurrent FX '+i,'UGPLAY','FXHANDLE 1 /LOOP',0,{card});
const bytes=Buffer.from(card.objects.get(1).data);
test('background verified upload','UGLOAD','T.WAV /TYPE:WAV /VERIFY',0,{card,files:{'T.WAV':wav(1025)},check:c=>c.objects.size===2&&!!c.foreground&&c.fx.length===4});
test('playing PCM verified readback','UGDUMP','1 BACK.RAW /VERIFY',0,{card,check:(c,m)=>c.foreground&&c.fx.length===4&&m.files.get('BACK.RAW')?.equals(bytes)});
for(const rate of [8000,11025,16000,22050,24000,32000,44100,48000,12345])for(const channels of [1,2])for(const fmt of ['U8','S8','S16LE']) {
 const bits=fmt==='S16LE'?16:8,data=Buffer.alloc(24,192),options=`/RATE:${rate} /BITS:${bits} /CH:${channels} /FMT:${fmt}`;
 test(`RAW matrix ${rate}-${channels}-${fmt}`,'UGPLAY',`T.RAW ${options} /WAIT`,0,{files:{'T.RAW':data},check:c=>c.objects.get(1).pcm.rate===rate&&c.objects.get(1).pcm.channels===channels});
 if(fmt!=='S8')test(`WAV matrix ${rate}-${channels}-${bits}`,'UGPLAY','T.WAV /WAIT',0,{files:{'T.WAV':wav(24,channels,bits,rate)}});
}
card=new PcmCard(catalog);asset(card);test('audio fault WAIT','UGPLAY','HANDLE 1 /LOOP /WAIT',7,{card,onDss:(st,c)=>{if(st.c===0x31&&c.foreground)c.o.audioFaultAt=c.now+1;},check:c=>!c.objects.get(1).pins&&c.lastAudioError===17});
card=new PcmCard(catalog);asset(card);test('FX audio fault WAIT','UGPLAY','FXHANDLE 1 /LOOP /WAIT',7,{card,onDss:(st,c)=>{if(st.c===0x31&&c.fx.length)c.o.audioFaultAt=c.now+1;},check:(c,m)=>!c.objects.get(1).pins&&m.text.includes('AUDIO_PLAYBACK_ERROR')});
card=new PcmCard(catalog);asset(card);card.lastAudioError=17;card.stats[10]=5;
test('FX WAIT ignores old sticky error','UGPLAY','FXHANDLE 1 /WAIT',0,{card,check:c=>!c.fx.length&&!c.objects.get(1).pins});
test('FX WAIT detects repeated sticky fault','UGPLAY','FXHANDLE 1 /LOOP /WAIT',7,{card,onDss:(st,c)=>{if(st.c===0x31&&c.fx.length)c.o.audioFaultAt=c.now+1;},check:c=>c.stats[10]===6&&!c.fx.length});
card=new PcmCard(catalog);asset(card);test('FX targeted first','UGPLAY','FXHANDLE 1 /LOOP',0,{card});test('FX targeted second','UGPLAY','FXHANDLE 1 /LOOP',0,{card});
test('FXSTOP preserves other instance','UGPLAY','FXSTOP 1',0,{card,check:c=>c.fx.length===1&&c.fx[0].id===2});
test('FX WAIT natural EOF','UGPLAY','FXHANDLE 1 /WAIT',0,{card,check:c=>c.fx.length===1&&c.fx[0].id===2});
card=new PcmCard(catalog,{simpleDelayUs:1000});asset(card);
test('delayed WAIT ESC targets accepted instance','UGPLAY','HANDLE 1 /LOOP /WAIT',10,{card,onDss:(st,c,m)=>{if(st.c===0x31&&c.foreground)m.escAfter=0;},check:c=>!c.foreground&&!c.objects.get(1).pins});
card=new PcmCard(catalog,{badReadCrc:true});
test('verified readback failure keeps READY','UGLOAD',`T.RAW /TYPE:RAW ${opts} /VERIFY`,9,{card,files:{'T.RAW':raw},check:c=>c.objects.get(1)?.state===1&&!c.objects.get(1).pins});
card=new PcmCard(catalog);asset(card,1,16);
test('incomplete upload preserves foreign READY','UGLOAD',`T.RAW /TYPE:RAW ${opts}`,5,{card,files:{'T.RAW':raw},disk:{shortRead:0},check:c=>c.objects.size===1&&c.objects.get(1).state===1});
card=new PcmCard(catalog,{pool:64});asset(card,1,16);asset(card,1,16);asset(card,1,16);card.command(17,Buffer.from([2,0]));
test('largest extent admission before ALLOC','UGLOAD',`T.RAW /TYPE:RAW ${opts}`,4,{card,files:{'T.RAW':Buffer.alloc(24)},check:c=>c.objects.size===2&&c.trace.filter(x=>x.op===16).length===3});
card=new PcmCard(catalog);let resetDuringUpload=false;
test('session change during upload preserves new-session asset','UGLOAD',`T.RAW /TYPE:RAW ${opts}`,3,{card,files:{'T.RAW':raw},onDss:(st,c)=>{if(st.c===0x13&&!resetDuringUpload){resetDuringUpload=true;c.session++;c.objects.clear();c.next=1;asset(c,1,16);}},check:c=>c.objects.size===1&&c.objects.get(1).state===1});
card=new PcmCard(catalog);let replacedLoading=false;
test('session change cannot overwrite foreign LOADING','UGLOAD',`T.RAW /TYPE:RAW ${opts}`,3,{card,files:{'T.RAW':raw},onDss:(st,c)=>{
 if(st.c===0x13&&!replacedLoading){replacedLoading=true;c.session++;c.objects.clear();c.next=1;c.command(16,Buffer.from([1,1,1,0,0]));}
},check:c=>c.objects.size===1&&c.objects.get(1)?.state===0&&c.objects.get(1)?.uploaded===0&&c.objects.get(1)?.data.equals(Buffer.alloc(257))});
// Independent model queue and cyclic token stress, tied to C vectors above.
const stress=new PcmCard(catalog);asset(stress);const q=Buffer.from([1,0,0,1,128,64,128,2]);
const kept=stress.command(54,q)[1].readUInt16LE();stress.render(1);let churn=0;
for(let n=0;n<65540;n++) {
 if(churn){const stop=Buffer.from([churn&255,churn>>>8,0]);if(stress.command(57,stop)[0])throw Error('model stop');}
 q.writeUInt16LE(0x200,2);const [e,r]=stress.command(54,q);if(e||r.readUInt16LE()===kept)throw Error('model cyclic token');churn=r.readUInt16LE();stress.render(1);
}
if(stress.objects.size!==1||stress.objects.get(1).pins!==2)throw Error('model lifetime');
// A queued STOP still leaves its token live until the next render boundary.
stress.nextFx=kept;
if(stress.command(57,Buffer.from([kept&255,kept>>>8,0]))[0])throw Error('model queued stop');
q.writeUInt16LE(0x100,2);const [wrapStatus,wrapReply]=stress.command(54,q);
if(wrapStatus||wrapReply.readUInt16LE()===kept||wrapReply.readUInt16LE()===churn)throw Error('model reused live queued-STOP token');
stress.render(1);if(stress.objects.get(1).pins!==2)throw Error('model queued stop pins');
mkdirSync(join(build,'ultrags/logs'),{recursive:true});verifyBuild(root,join(build,'ultrags/dss'));if(JSON.stringify(before)!==JSON.stringify(executionInputs(root)))throw Error('S6 inputs changed');
writeFileSync(join(build,'ultrags/logs/s6-run.json'),JSON.stringify({sharedCount,sharedSha256:createHash('sha256').update(readFileSync(join(build,'host/s6/s6-commands.jsonl'))).digest('hex'),modelStarts:65542,queuedStopWrap:true,results,executed:[...executed.values()],inputs:before,buildInputs:assembly.inputs},null,2)+'\n');
