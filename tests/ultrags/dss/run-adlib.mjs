// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {crc32} from './config-card.mjs';
import {NativeCard} from './native-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {verifyBuild,executionInputs,sha256} from '../../../tools/ultrags/build-evidence.mjs';
const root=resolve(process.argv[2]??'.'),build=resolve(process.argv[3]??'build');
const assembly=verifyBuild(root,join(build,'ultrags/dss')),before=executionInputs(root),results=[];
const manifestPath=join(build,'native/native-card-build.json'),manifest=JSON.parse(readFileSync(manifestPath));
assert(manifest.adlib);
for(const [p,h]of Object.entries(manifest.inputs))assert.equal(sha256(readFileSync(p)),h,'stale '+p);
assert.equal(sha256(readFileSync(join(build,'native/native-card.node'))),manifest.artifact);
const Z80=loadZ80(root),catalog=readFileSync(join(build,'host/s2-catalog.bin'));
const bytes=readFileSync(join(build,'ultrags/dss/UGOPL.EXE')),h=parseExe(bytes);
function run(cli,o={}) {
 const c=new NativeCard(catalog,{adlib:true,addon:join(build,'native/native-card.node')});
 if(o.dirty){
  const write=(r,v)=>{c.writePort(0x388,r);c.writePort(0x389,v);};
  write(1,32);write(8,64);write(0xbd,0xff);
  for(const op of [0,3,1,4,2,5,8,11,9,12,10,13,16,19,17,20,18,21]){
   write(0x20+op,0xff);write(0x40+op,0);write(0x60+op,0xff);write(0x80+op,0);write(0xe0+op,3);
  }
  for(let ch=0;ch<9;ch++){write(0xc0+ch,15);write(0xa0+ch,0xff);write(0xb0+ch,0x3f);}
  c.tickUs(10000);
 }
 let foreign=null;
 if(o.busy){
  const play=readFileSync(join(build,'ultrags/dss/UGPLAY.EXE')),ph=parseExe(play);
  const pm=new SprinterMachine({card:c,commandLine:'F00.MOD /LOOP',movingClock:true,files:{'F00.MOD':readFileSync(join(build,'host/f00/fixtures/F00MOD4.MOD'))}});
  pm.mem.set(play,ph.loadAddr);const pr=runImage(Z80,pm,{entry:ph.entry,stack:ph.stack,iff:1,budget:200000000});assert.equal(pr.exitCode,0,pm.text);
  c.tickUs(10000);if(o.busy==='paused'){assert.equal(c.command(50,Buffer.from([0,0,1]))[0],0);c.tickUs(10000);}
  foreign=c.command(80)[1];
 }
 const m=new SprinterMachine({card:c,cardSlot:o.slot??0,commandLine:cli,movingClock:o.clock!==false,page3Init:0x71+(o.slot??0),turboInit:o.initialTurbo??true,turboHardware:o.hardware!==false,rejectTurboIsa:false,logLimit:100,escAfter:o.escAfter??Infinity});
 const wr=c.writePort.bind(c),rd=c.readPort.bind(c),fm=[];let address=0,packet=[],op=0,ri=0,rlen=0,reply=[],clears=0,statsReads=0,timerControl=0;const configReads=new Map();
 c.writePort=(p,v)=>{
  assert.equal(m.turbo,(p===0x388||p===0x389)?!cli.includes('/TURBO:OFF'):false,'write speed '+p.toString(16));
  if(p===c.base+3){packet.push(v);if(packet.length===2+packet[1]+((packet[0]&128)?4:0)){op=packet[0];if((op&127)===4)clears++;if((op&127)===3)statsReads++;ri=0;reply=[];packet=[];}}
  if(p===0x388)address=v;if(p===0x389){fm.push([address,v]);if(address===4)timerControl=v;}return wr(p,v);
 };
 c.readPort=p=>{
  assert.equal(m.turbo,p===0x388?!cli.includes('/TURBO:OFF'):false,'read speed '+p.toString(16));
  let v=rd(p);
  if(p===0x1d2&&[0,1,0xe4].includes(c.sel)){
   const n=(configReads.get(c.sel)??0)+1;configReads.set(c.sel,n);
   if(n===2&&o.openFault===({0:'magic',1:'protocol',228:'active'}[c.sel]))v=255;
  }
  if(o.openFault==='major'&&p===c.base+8)v=255;
  if(o.openFault==='minor'&&p===c.base+9)v=255;
  if(p===0x388&&o.timerFault&&timerControl===({1:0x80,2:0x21,3:0x42}[o.timerFault]))v=o.timerFault===1?255:6;
  if(p===c.base+3){
   if(ri===1)rlen=v;
   const patchStats=(o.statsMax!==undefined||o.statsError!==undefined)&&(op&127)===3;
   const patchCaps=o.caps!==undefined&&(op&127)===1;
   if(patchStats){
    if(o.statsMax!==undefined&&ri>=46&&ri<50)v=(o.statsMax>>>((ri-46)*8))&255;
    if(o.statsError!==undefined&&statsReads>=(o.statsErrorAfter??0)&&ri>=2+o.statsError&&ri<6+o.statsError)v=ri===2+o.statsError?1:0;
   }
   if(patchCaps&&ri>=2&&ri<6)v=(o.caps>>>((ri-2)*8))&255;
   if(patchStats||patchCaps){
    if(ri<2+rlen)reply.push(v);
    else if(op&128)v=(crc32(Buffer.from(reply))>>>((ri-2-rlen)*8))&255;
   }
   // Deliberately leave the original CRC: the EXE must reject corrupt INFO/CAPS.
   if(o.corruptOpcode!==undefined&&(op&127)===o.corruptOpcode&&ri===2)v^=1;
   ri++;
  }
  return v;
 };
 m.mem.set(bytes,h.loadAddr);const resident=Buffer.from(m.mem.slice(0x100,0x4000));
 const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:o.iff??1,budget:200000000});
 assert.equal(r.exitCode,o.expected??0,cli+'\n'+m.text);assert.deepEqual(m.violations,[]);
 assert.deepEqual(Buffer.from(m.mem.slice(0x100,0x4000)),resident);assert.equal(m.residentWrites,0);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!r.end.iff1,!!(o.iff??1));assert.equal(r.end.sp,h.stack-2);
 assert(m.maxDiUs<10000 && m.maxWindowUs<10000);assert.equal(m.fileHandles.size,0);
 c.tickUs(100000);
 if(!foreign)assert(c.backend.idle(),'test FM release/cleanup must reach idle');
 assert.equal(c.command(2)[1].readUInt16LE(16),foreign?1:0,'owned object cleanup');
 if(foreign){const snap=c.command(80)[1];assert.equal(snap.readUInt16LE(20),foreign.readUInt16LE(20));assert.equal(snap[24],foreign[24]);assert.equal(fm.length,0);}
 if(o.expected!==1&&o.expected!==4){if(!o.early)assert(fm.some(([r,v])=>r===0xb8&&(v&32)));if(fm.length)assert.equal(fm.filter(([r])=>r===0xbd).at(-1)[1],0);if(cli==='TEST /SECONDS:2')assert(fm.some(([r,v])=>r===0xbd&&v===0x3f));}
 else if(o.expected===1){assert.equal(m.turboWrites,0);assert.equal(fm.length,0);}
 if(cli.startsWith('MIX')&&r.exitCode===0){assert(clears);assert(/max_render_us=\d+ underruns=0 psram_errors=0 protocol_errors=0 clips=\d+/.test(m.text));}
 if(o.statsMax!==undefined)assert(m.text.includes('max_render_us='+o.statsMax));
 if(o.statsError!==undefined){const name={28:'protocol_errors',36:'underruns',40:'psram_errors'}[o.statsError];assert(m.text.includes(name+'=1'),m.text);}
 if(o.dirty){
  const regs=new Map();let notes=0;
  for(const [reg,value]of fm){
   if(reg>=0xb0&&reg<=0xb8&&(value&32)){
    const ch=reg-0xb0;assert.equal(regs.get(8),0);assert.equal(regs.get(0xbd),0);assert.equal(regs.get(0xc0+ch),0);
    assert.equal(regs.get(0xa0+ch),0x80+ch*7);
    for(const op of [0,3,1,4,2,5,8,11,9,12,10,13,16,19,17,20,18,21])assert.equal(regs.get(0xe0+op),0);
    notes++;
   }
   regs.set(reg,value);
  }
  assert.equal(notes,9);
 }
 if(o.expected!==1)assert(m.text.includes('UGOPL diagnostic R3 CRC=ON'),m.text);
 if(o.openFault){
  assert.equal(fm.length,0);
  const stage={magic:2,protocol:3,active:4,major:6,minor:7}[o.openFault];
  const values={magic:'FFFFFFFFFF',protocol:'DDFFFFFFFF',active:'DD04FFFFFF',major:'DD0408FFFF',minor:'DD040801FF'}[o.openFault];
  assert(m.text.includes('OPL OPEN stage=0'+stage+' base=02A0 error='+(o.openFault==='magic'?'0D':'06')),m.text);
  assert(m.text.includes('values='+values),m.text);
 }
 if(o.caps!==undefined){
  assert.equal(fm.length,0);
  assert(m.text.includes('OPL DIAG R3 phase='+(o.caps===128?'08':'07')+' caps='+o.caps.toString(16).toUpperCase().padStart(8,'0')),m.text);
  assert(m.text.includes('reason='+(o.caps===128?'ADLIB_CAP_MISSING':'MEMORY_CAP_MISSING')),m.text);
 }
 if(o.corruptOpcode!==undefined){
  assert.equal(fm.length,0);
  assert(m.text.includes('OPL DIAG R3 phase='+(o.corruptOpcode===0?'03':'06')+' caps=FFFFFFFF'),m.text);
  assert(m.text.includes('reason=NATIVE_FRAME_CRC'),m.text);
 }
 if(o.timerFault){const expected={1:'stage=01 reset=FF timer1=FF timer2=FF',2:'stage=02 reset=06 timer1=06 timer2=FF',3:'stage=03 reset=06 timer1=C6 timer2=06'}[o.timerFault];assert(m.text.includes(expected),m.text);assert(m.text.includes('reason=OPL_TIMER_STATUS'));}
 results.push({cli,clears,statsReads,openFault:o.openFault??null,caps:o.caps??null,corruptOpcode:o.corruptOpcode??null,timerFault:o.timerFault??null,dirty:!!o.dirty,statsErrorAfter:o.statsErrorAfter??null,statsError:o.statsError??null,statsMax:o.statsMax??null,busy:o.busy??null,slot:o.slot??0,iff:o.iff??1,initialTurbo:o.initialTurbo??true,hardware:o.hardware!==false,exit:r.exitCode,text:m.text,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs,residentWrites:m.residentWrites,steps:r.steps,fmWrites:fm.length});console.log('PASS actual EXE',cli,results.at(-1).maxDiUs);
}
for(const slot of [0,1]){
 for(const openFault of ['magic','protocol','active','major','minor'])run('TEST /SLOT:'+slot+' /TURBO:OFF /SECONDS:1',{slot,openFault,expected:3,early:true});
 for(const caps of [128,8192])run('TEST /SLOT:'+slot+' /TURBO:OFF /SECONDS:1',{slot,caps,expected:3,early:true});
 for(const corruptOpcode of [0,1])run('TEST /SLOT:'+slot+' /TURBO:OFF /SECONDS:1',{slot,corruptOpcode,expected:9,early:true});
}
for(const slot of [0,1])for(const iff of [0,1])for(const turbo of ['ON','OFF']) {
 const options=`/SLOT:${slot} /TURBO:${turbo} /SECONDS:1`;
 for(const command of ['TEST','MIX /FX:MONO','MIX /FX:STEREO'])run(command+' '+options,{slot,iff});
}
for(const cli of ['TEST /SECONDS:0','TEST /SECONDS:1801','TEST /SLOT:2','TEST /TURBO:MAYBE','MIX /FX:BAD','MIX /VOICES:2','NOTATEST'])run(cli,{expected:1});
run('TEST /SECONDS:2',{initialTurbo:false});run('TEST /SECONDS:2',{hardware:false});
run('TEST /SECONDS:1800',{escAfter:50,expected:10});
run('MIX /FX:MONO /SECONDS:1800',{escAfter:800,expected:10});
for(const busy of ['playing','paused'])for(const cmd of ['TEST','MIX /FX:MONO','MIX /FX:STEREO'])run(cmd+' /SECONDS:1',{busy,expected:4});
run('TEST /SECONDS:1',{clock:false,expected:8});
for(const escAfter of [1,20,200])run('MIX /FX:STEREO /SECONDS:1800',{escAfter,expected:10,early:true});
for(const statsMax of [2667,2668,65536])run('MIX /FX:MONO /SECONDS:1',{statsMax,expected:statsMax<=2667?0:7});
for(const statsError of [28,36,40])run('MIX /FX:STEREO /SECONDS:1',{statsError,expected:9});
for(const statsError of [28,36,40])run('MIX /FX:MONO /SECONDS:2',{statsError,statsErrorAfter:2,expected:9});
for(const slot of [0,1])for(const command of ['TEST','MIX /FX:MONO','MIX /FX:STEREO'])run(command+' /SECONDS:1 /SLOT:'+slot,{slot,dirty:true});
for(const timerFault of [1,2,3])for(const turbo of ['ON','OFF'])run('TEST /SECONDS:1 /TURBO:'+turbo,{timerFault,expected:9,early:true});
assert.deepEqual(executionInputs(root),before);assert.deepEqual(verifyBuild(root,join(build,'ultrags/dss')),assembly);
mkdirSync(join(build,'host/adlib'),{recursive:true});writeFileSync(join(build,'host/adlib/exe-evidence.json'),JSON.stringify({status:'ACTUAL_EXE_PASS / REAL_PENDING',assembly,inputs:before,adapter:sha256(readFileSync(manifestPath)),exe:sha256(bytes),runner:sha256(readFileSync(new URL(import.meta.url))),results},null,2)+'\n');
