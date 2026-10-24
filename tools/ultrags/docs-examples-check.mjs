// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {NativeCard} from '../../tests/ultrags/dss/native-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {sha256,buildInputs} from './build-evidence.mjs';
const root=resolve('.'),build=resolve(process.argv[2]??'build'),dir=join(build,'host/docs'),ex=join(dir,'examples');
const manifest=JSON.parse(readFileSync(join(build,'native/native-card-build.json')));
for(const [p,h] of Object.entries(manifest.inputs))assert.equal(sha256(readFileSync(p)),h,'stale adapter '+p);
assert.equal(sha256(readFileSync(join(build,'native/native-card.node'))),manifest.artifact);
const Z80=loadZ80(root),catalog=readFileSync(join(build,'host/s2-catalog.bin')),results=[];
// Standalone lessons (DISCOV/PCM/MODFX/FM/GSMOD/S3M/GSS3M) are built per slot;
// these entry units reuse the full DSS applications and take a command line.
const cases=[['GSFX','GS'],['PCM','PCM /VERIFY'],['STREAM','STREAM GUIDE.WAV /BUFFER:16 /PREFILL:8 /LOW:4']];
const lessons=['MODFX','FM','GSMOD'];
function run(name,cli,{slot=0,iff=1,escAfter=Infinity,clock=true,expected=0,foreign=false,corrupt=false,infoCorrupt=false,mode=8,disk={}}={}) {
 const c=new NativeCard(catalog,{adlib:true,mode,addon:join(build,'native/native-card.node')});
 const initialSession=c.command(0)[1].subarray(12,20).toString("hex");
 let foreignHandle;
 if(foreign){const [e,r]=c.command(0x10,Buffer.from([0,16,0,0,0]));assert.equal(e,0);foreignHandle=r.readUInt16LE();}
 const b=readFileSync(join(ex,name+'.EXE')),h=parseExe(b);
 // Lessons do not define UG_ISA_TURBO_OFF: ISA runs at the program's CPU speed.
 const lesson=/\d$/.test(name);
 const m=new SprinterMachine({card:c,cardSlot:slot,commandLine:cli,movingClock:clock,files:{'GUIDE.WAV':readFileSync(join(ex,'GUIDE.WAV'))},disk,page3Init:0x71+slot,turboInit:!!iff,rejectTurboIsa:!lesson,escAfter,logLimit:100});
 let packet=[],op=-1,ri=0,rl=0,lost=false,reset=0;const seenOps=new Set();
 const wr=c.writePort.bind(c),rd=c.readPort.bind(c);
 c.writePort=(p,v)=>{
  if(p===c.base+0x1b&&[0xf3,0xf4].includes(v))reset++;
  if(p===c.base+3){packet.push(v);if(packet.length===2+packet[1]+((packet[0]&128)?4:0)){op=packet[0];seenOps.add(op&127);if((op&127)===6)reset++;packet=[];ri=0;}}
  return wr(p,v);
 };
 c.readPort=p=>{let v=rd(p);if(p===c.base+3){if(ri===1)rl=v;if((corrupt&&(op&127)===(Number.isInteger(corrupt)?corrupt:0x30)||infoCorrupt&&(op&127)===0)&&!lost&&ri===2+rl+3){v^=1;lost=true;}ri++;}return v;};
 // The GS lesson deliberately tests a 120-second LOAD pause. Advance the
 // functional clock as the existing GS suite does; no physical timing claim.
 const dss=m.dssCall.bind(m);
 m.dssCall=st=>{if(st.c===0x21&&m.text.includes('LOAD_PAUSE_120S')&&m.mem[0xbc4e]===120)m.clockStart++;return dss(st);};
 m.mem.set(b,h.loadAddr);const resident=Buffer.from(m.mem.slice(0x100,0x4000));
 const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff,budget:300000000});
 assert.equal(r.exitCode,expected,name+' '+cli+'\n'+m.text);
 assert.deepEqual(m.violations,[],name);if(lesson){assert.equal(m.turboWrites,0,name+' changed the CPU speed');assert.equal(m.turbo,!!iff);}assert(m.maxDiUs<10000&&m.maxWindowUs<10000);assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!r.end.iff1,!!iff);assert.equal(r.end.sp,h.stack-2);
 assert.deepEqual(Buffer.from(m.mem.slice(0x100,0x4000)),resident);assert.equal(m.fileHandles.size,0);assert.equal(reset,name==='GSFX'&&!foreign?1:0,'only the GS BUSY rejection probe may request reset');
 assert.equal(c.command(0)[1].subarray(12,20).toString('hex'),initialSession,'no reset may execute');
 c.tickUs(100000);
 assert.equal(c.command(2)[1].readUInt16LE(16),foreign?1:0,name+' owned cleanup');
 if(foreign)assert.equal(c.command(0x12,Buffer.from([foreignHandle,0]))[0],0);
 if(corrupt||infoCorrupt)assert(lost,'requested reply-CRC injection was exercised');
 if(/^PCM[01]$/.test(name)&&escAfter===100)assert(seenOps.has(0x30),'late ESC must follow PLAY_PCM');
 results.push({name,cli,slot,iff,clock,foreign,corrupt,escAfter:Number.isFinite(escAfter)?escAfter:null,expected,infoCorrupt,mode,sha256:sha256(b),steps:r.steps,maxDiUs:m.maxDiUs,text:m.text});
 console.log('PASS',name,slot,iff,expected);
}
for(const slot of [0,1])for(const iff of [0,1]){
 run('DISCOV'+slot,'',{slot,iff});
 run('PCM'+slot,'',{slot,iff});
 for(const name of lessons)run(name+slot,'',{slot,iff});
 for(const name of ['S3M','GSS3M'])run(name+slot,'',{slot,iff});
 for(const [name,cli]of cases)run(name,cli+` /SLOT:${slot}`,{slot,iff});
}
for(const slot of [0,1]){
 for(const [name,cli]of cases)run(name,cli+` /SLOT:${slot}`,{slot,escAfter:1,expected:name==='GSMOD'?0:10});
 run('DISCOV'+slot,'',{slot,infoCorrupt:true,expected:4});
 // Without UG_ISA_TURBO_OFF UG_OPEN skips CONFIG: another firmware mode looks like no card.
 run('DISCOV'+slot,'',{slot,mode:1,expected:13});
 run('PCM',`FX /VERIFY /SLOT:${slot}`,{slot});
 run('PCM'+slot,'',{slot,escAfter:1,expected:21});
 run('PCM'+slot,'',{slot,escAfter:100,expected:21});
 run('PCM'+slot,'',{slot,foreign:true,expected:5});
 // ESC during the first wait: CANCELLED (15h) after the lesson's own cleanup.
 for(const name of lessons)run(name+slot,'',{slot,escAfter:1,expected:21});
 // A foreign object: the storage lessons refuse with BUSY, the FM lesson
 // needs no storage and leaves the foreign object alone.
 for(const name of ['MODFX','GSMOD'])run(name+slot,'',{slot,foreign:true,expected:5});
 run('FM'+slot,'',{slot,foreign:true,expected:0});
 for(const name of ['S3M','GSS3M']){run(name+slot,'',{slot,foreign:true,expected:5});run(name+slot,'',{slot,escAfter:10,expected:21});}
 run('S3M'+slot,'',{slot,corrupt:0x10,expected:4});
 run('S3M'+slot,'',{slot,corrupt:0x31,expected:4});
 run('PCM'+slot,'',{slot,corrupt:0x30,expected:4});
 run('PCM'+slot,'',{slot,corrupt:0x10,expected:4});
 run('PCM'+slot,'',{slot,infoCorrupt:true,expected:4});
 run('PCM'+slot,'',{slot,mode:1,expected:13});
}
run('PCM0','',{clock:false,expected:13});
for(const name of lessons)run(name+'0','',{clock:false,expected:13});
run('GSFX','GS',{foreign:true,expected:4});
run('PCM','PCM /VERIFY',{corrupt:true,expected:9});
run('STREAM','STREAM GUIDE.WAV /BUFFER:16 /PREFILL:8 /LOW:4',{disk:{failFn:0x13},expected:5});
writeFileSync(join(dir,'examples-check.json'),JSON.stringify({scope:'HOST actual Z80 EXE + production C; REAL_PENDING',build:buildInputs(root,join(build,'ultrags/dss')),runner:sha256(readFileSync(new URL(import.meta.url))),revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),adapter:manifest.artifact,results},null,2)+'\n');
