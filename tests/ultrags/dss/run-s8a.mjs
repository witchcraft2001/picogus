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
 let packet=[],op=0,ri=0,rlen=0,injected=false;
 const wr=c.writePort.bind(c),rd=c.readPort.bind(c);
 c.writePort=(p,v)=>{if(p===c.base+3){packet.push(v);if(packet.length===2+packet[1]+((packet[0]&128)?4:0)){op=packet[0];ri=0;packet=[];}}return wr(p,v);};
 c.readPort=p=>{let v=rd(p);if(p===c.base+3){if(ri===1)rlen=v;if(o.loseAck&&!injected&&(op&127)===54&&(op&128)&&ri===2+rlen+3){v^=1;injected=true;}ri++;}return v;};
 const fn=m.dssCall.bind(m);m.dssCall=st=>{assert(!(c.transfer&&[0x11,0x12,0x13,0x14,0x15].includes(st.c)),'DSS file/key call '+st.c.toString(16)+' inside packet '+JSON.stringify(c.transfer));const r=fn(st);if(r!=='exit'){if(st.c!==0x15)st.ix=0xdead;st.iy=0xbeef;}return r;};
 m.mem.set(bytes,h.loadAddr);const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:o.iff??1,budget:o.budget??100000000});
 assert.equal(r.exitCode,o.expected??0,app+' '+cli+'\n'+m.text);assert.deepEqual(m.violations,[]);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!r.end.iff1,!!(o.iff??1));assert.equal(r.end.sp,h.stack-2);
 assert(m.maxDiUs<10000&&m.maxWindowUs<10000);assert.equal(m.fileHandles.size,0);
 if(o.expected===1){assert.equal(m.turboWrites,0);assert.equal(c.nativeWrites,0);}
 results.push({app,cli,escAfter:o.escAfter??null,loseAck:!!o.loseAck,exit:r.exitCode,steps:r.steps,text:m.text,slot:o.slot??0,iff:o.iff??1,turbo:o.turbo??true,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs});
 if(o.loseAck)assert(injected);c.writePort=wr;c.readPort=rd;console.log('PASS native-C actual EXE',app,cli);return {card:c,m};
}

function mod8() {
 const b=Buffer.alloc(1084+4096+256);b[950]=2;b[953]=1;b.write('8CHN',1080);
 b.writeUInt16BE(128,42);b[45]=12;b.writeUInt16BE(128,48);
 for(let pattern=0;pattern<2;pattern++)for(let c=0;c<8;c++){
  const period=[856,808,762,720,678,640,604,570][c],o=1084+pattern*2048+c*4;
  b[o]=period>>8;b[o+1]=period&255;b[o+2]=16;
 }
 for(let i=0;i<256;i++)b[1084+4096+i]=i<128?64:192;
 return b;
}
run('UGTEST','MOD8');
run('UGTEST','MOD8 /VERIFY');
run('UGTEST','MOD8 /SECONDS:1',{expected:1});
for(const verify of ['', ' /VERIFY']) {
 const data=mod8(),{card:c}=run('UGLOAD','EIGHT.MOD /TYPE:MOD'+verify,{files:{'EIGHT.MOD':data}});
 assert.equal(c.command(18,Buffer.from([1,0]))[1][37],8);
 run('UGPLAY','HANDLE 1 /LOOP',{card:c});c.tickUs(10000);
 const initial=c.command(80)[1],id=initial.readUInt16LE(20);assert.equal(initial.readUInt16LE(26),8);
 run('UGMON','/COUNT:1',{card:c});
 run('UGTEST','FX /SECONDS:1'+verify,{card:c});
 const after=c.command(80)[1];assert.equal(after.readUInt16LE(20),id);assert.equal(after[24],1);assert.equal(after.readUInt16LE(54),0);
 assert.equal(c.command(2)[1].readUInt16LE(16),1);
 const {m}=run('UGDUMP','1 BACK.MOD /VERIFY',{card:c});assert(m.files.get('BACK.MOD').equals(data));
 run('UGPLAY','STOP',{card:c});run('UGMEM','FREE 1',{card:c});assert.equal(c.command(2)[1].readUInt16LE(16),0);
}

for(const escAfter of [10,40,100,250]) {
 const {card:c}=run('UGLOAD','EIGHT.MOD /TYPE:MOD',{files:{'EIGHT.MOD':mod8()}});
 run('UGPLAY','HANDLE 1 /LOOP',{card:c});c.tickUs(10000);const id=c.command(80)[1].readUInt16LE(20);
 run('UGTEST','FX /SECONDS:1',{card:c,escAfter,expected:10});c.tickUs(10000);
 assert.equal(c.command(80)[1].readUInt16LE(20),id);assert.equal(c.command(2)[1].readUInt16LE(16),1);assert.equal(c.command(80)[1].readUInt16LE(54),0);
}
{
 const {card:c}=run('UGLOAD','EIGHT.MOD /TYPE:MOD',{files:{'EIGHT.MOD':mod8()}});run('UGPLAY','HANDLE 1 /LOOP',{card:c});
 run('UGTEST','FX /SECONDS:1 /VERIFY',{card:c,loseAck:true,expected:9});c.tickUs(10000);
 assert.equal(c.command(2)[1].readUInt16LE(16),1);assert.equal(c.command(80)[1].readUInt16LE(54),0);
}

for(const slot of [0,1])for(const iff of [0,1])for(const turbo of [false,true])run('UGTEST',`MOD8 /SLOT:${slot}`,{slot,iff,turbo});
run('UGTEST','MOD8 /VERIFY',{escAfter:20,expected:10});
{
 const {card:c}=run('UGLOAD','EIGHT.MOD /TYPE:MOD',{files:{'EIGHT.MOD':mod8()}});run('UGPLAY','HANDLE 1 /LOOP',{card:c});
 run('UGLOAD','USER.RAW /TYPE:RAW /RATE:48000 /BITS:16 /CH:1 /FMT:S16LE',{card:c,files:{'USER.RAW':Buffer.from([100,0,200,0])}});
 run('UGPLAY','FXHANDLE 2 /LOOP',{card:c});c.tickUs(10000);const id=c.command(80)[1].readUInt16LE(20);
 run('UGTEST','FX /SECONDS:1',{card:c});c.tickUs(10000);
 assert.equal(c.command(80)[1].readUInt16LE(20),id);assert.equal(c.command(80)[1].readUInt16LE(54),1);assert.equal(c.command(2)[1].readUInt16LE(16),2);
}
const deliveryFixture=readFileSync(join(build,'s8a-test-audio/EIGHT.MOD'));
{
 const {card:c}=run('UGPLAY','EIGHT.MOD /WAIT',{files:{'EIGHT.MOD':deliveryFixture}});
 assert.equal(c.command(80)[1][24],3);assert.equal(c.command(2)[1].readUInt16LE(16),1);
}
assert.deepEqual(executionInputs(root),before);
for(const [p,h]of Object.entries(manifest.inputs))assert.equal(sha(readFileSync(p)),h);
mkdirSync(join(build,'evidence'),{recursive:true});
writeFileSync(join(build,'evidence/s8a-exe.json'),JSON.stringify({status:'HOST_ACTUAL_EXE_PASS / REAL_PENDING',assembly,adapterSha256:sha(readFileSync(manifestPath)),images,deliveryFixtureSha256:sha(deliveryFixture),runnerSha256:sha(readFileSync(new URL(import.meta.url))),inputs:before,results},null,2)+'\n');
console.log('PASS S8a',results.length,'actual EXE scenarios against production C');
