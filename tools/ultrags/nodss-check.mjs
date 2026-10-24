// SPDX-License-Identifier: GPL-2.0-or-later
// UG_NO_DSS library profile, with and without UG_ISA_TURBO_OFF, on the
// actual-EXE harness:
//  * no DSS call is issued from library code (return address inside
//    UG_LIB_BEGIN..UG_LIB_END);
//  * without UG_ISA_TURBO_OFF the library never writes SYS_PORT.RAM and
//    never touches CONFIG 01D0h..01D2h, at Turbo ON and OFF;
//  * synthetic deadlines measured against a stalled card: never shorter
//    than nominal on the fastest CPU, GS_DATA below the 5 s grant fuse on
//    the slowest. Model time has no ISA wait states (they only lengthen it).
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {NativeCard} from '../../tests/ultrags/dss/native-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {sha256} from './build-evidence.mjs';
const root=resolve('.'),build=resolve(process.argv[2]??'build'),out=join(build,'host/nodss'),exe=join(out,'exe');
mkdirSync(exe,{recursive:true});
const manifest=JSON.parse(readFileSync(join(build,'native/native-card-build.json')));
for(const [p,h] of Object.entries(manifest.inputs))assert.equal(sha256(readFileSync(p)),h,'stale adapter '+p);
assert.equal(sha256(readFileSync(join(build,'native/native-card.node'))),manifest.artifact);
const Z80=loadZ80(root),catalog=readFileSync(join(build,'host/s2-catalog.bin')),docs=join(build,'host/docs/examples');
const inc=['apps','include','lib'].map(d=>join(root,'host/sprinter/ultrags',d)).concat([join(build,'ultrags/gen'),docs]);
const lessons={DISCOV:'discover',PCM:'firstpcm',MODFX:'modfx',FM:'fm',GSMOD:'gsmod',S3M:'s3m',GSS3M:'gss3m'};

function assemble(src,name,defs,keep){
 const target=join(exe,name+'.EXE'),sym=join(exe,name+'.sym');
 execFileSync('sjasmplus',[...inc.map(d=>'--inc='+d),...defs.map(d=>'-D'+d),'--raw='+target,'--sym='+sym,src],{stdio:'ignore'});
 const labels={};
 for(const l of readFileSync(sym,'utf8').split('\n')){const m=/^(\w+): EQU 0x([0-9A-F]+)/i.exec(l);if(m)labels[m[1]]=parseInt(m[2],16);}
 assert(labels.UG_LIB_BEGIN<labels.UG_LIB_END,name+' library range');
 return {name,bytes:readFileSync(target),labels,keep};
}
// The lessons define UG_NO_DSS only (no CPU speed switching). The
// Turbo-switching variant adds UG_ISA_TURBO_OFF to copies of the sources.
const exdir=join(root,'host/sprinter/ultrags/examples'),sw=join(out,'switch-src');
mkdirSync(sw,{recursive:true});
for(const f of readdirSync(exdir).filter(f=>/\.(asm|inc)$/.test(f))){
 const text=readFileSync(join(exdir,f),'utf8');
 assert(!/UG_ISA_TURBO_OFF/.test(text),f+' must leave the CPU speed alone');
 const added=text.replace(/^( *)DEFINE UG_NO_DSS\b.*\n/m,'$&$1DEFINE UG_ISA_TURBO_OFF\n');
 if(['discover.asm','firstpcm.asm','modfx.asm','fm.asm','gsmod.asm','s3m_demo.inc'].includes(f))assert.notEqual(added,text,f+' must define UG_NO_DSS');
 writeFileSync(join(sw,f),added);
}
const images={};
for(const [name,src] of Object.entries(lessons))for(const slot of [0,1]){
 const shipped=assemble(join(exdir,src+'.asm'),name+slot,['DOC_SLOT='+slot],true);
 // the profile under test is exactly the shipped guide EXE
 assert.deepEqual(shipped.bytes,readFileSync(join(docs,name+slot+'.EXE')),name+slot+' differs from the guide build');
 images[name+slot]=shipped;
 images[name+slot+'S']=assemble(join(sw,src+'.asm'),name+slot+'S',['DOC_SLOT='+slot],false);
}
const probeSrc=join(root,'tests/ultrags/dss/nodss-probe.asm');
images.PROBE=assemble(probeSrc,'PROBE',['UG_ISA_TURBO_OFF'],false);
images.PROBEK=assemble(probeSrc,'PROBEK',[],true);

const results=[];
function run(key,{slot=0,iff=1,turbo=true,turboHardware=true,expected=0,escAfter=Infinity,foreign=false,mode=8,patch=null,stall=null}={}){
 const img=images[key],keep=img.keep,c=new NativeCard(catalog,{adlib:true,mode,addon:join(build,'native/native-card.node')});
 if(foreign)assert.equal(c.command(0x10,Buffer.from([0,16,0,0,0]))[0],0);
 const h=parseExe(img.bytes);
 const m=new SprinterMachine({card:c,cardSlot:slot,commandLine:'',movingClock:true,files:{'GUIDE.WAV':readFileSync(join(docs,'GUIDE.WAV'))},
  page3Init:0x71+slot,turboInit:turbo,turboHardware,rejectTurboIsa:!keep,escAfter,logLimit:100});
 const config=[],libDss=[];let frames=0,stalledAt=null,packet=[];
 const wr=c.writePort.bind(c),rd=c.readPort.bind(c);
 const begin=()=>{if(stalledAt===null)stalledAt=m.elapsedTicks;};
 c.writePort=(p,v)=>{
  if(p>=0x1d0&&p<=0x1d2)config.push(p);
  if(p===c.base+3){packet.push(v);if(packet.length===2+packet[1]+((packet[0]&128)?4:0)){frames++;packet=[];if(stall?.kind==='rpc'&&frames>stall.after)begin();}}
  if(stall?.kind==='gs'&&p===c.base+0x1b)begin();
  if(stall?.kind==='data'&&p===c.base+0x13)begin();
  return wr(p,v);
 };
 c.readPort=p=>{
  if(p>=0x1d0&&p<=0x1d2){config.push(p);if(stall?.kind==='config'){begin();return 0xEE;}}
  if(stalledAt!==null){
   if(stall.kind==='rpc'&&p===c.base+1)return 0x02;        // EXEC, never a reply
   if(stall.kind==='gs'&&p===c.base+0x1b)return 0x01;      // CB never clears
   if(stall.kind==='data'&&p===c.base+0x1b)return 0x80;    // DB never clears
  }
  return rd(p);
 };
 const dss=m.dssCall.bind(m);
 m.dssCall=st=>{const ret=m.mem[st.sp]|(m.mem[st.sp+1]<<8);if(ret-1>=img.labels.UG_LIB_BEGIN&&ret-1<img.labels.UG_LIB_END)libDss.push(st.c);return dss(st);};
 m.mem.set(img.bytes,h.loadAddr);
 if(patch)for(const [label,v] of Object.entries(patch))m.mem[img.labels[label]]=v;
 const turboStart=m.turbo,r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff,budget:2_000_000_000});
 const label=`${key} slot${slot} iff${iff} turbo${+turbo}${turboHardware?'':'(hw off)'}`;
 assert.equal(r.exitCode,expected,label+'\n'+m.text);
 assert.deepEqual(m.violations,[],label);
 assert.deepEqual(libDss,[],label+': DSS called from library code');
 assert.equal(m.page3,m.page3Init,label);assert.equal(!!r.end.iff1,!!iff,label);
 assert(m.maxDiUs<10000&&m.maxWindowUs<10000,label+' DI/window budget');
 if(keep){
  assert.equal(m.turboWrites,0,label+': SYS_PORT.RAM written');
  assert.equal(m.turbo,turboStart,label);
  assert.deepEqual(config,[],label+': CONFIG ports used');
 }
 const seconds=stalledAt===null?null:(m.elapsedTicks-stalledAt)/21e6;
 if(stall)assert(seconds!==null,label+' stall was not reached');
 results.push({key,slot,iff,turbo,turboHardware,expected,stall:stall?.kind??null,seconds,maxWindowUs:m.maxWindowUs,maxDiUs:m.maxDiUs,turboWrites:m.turboWrites,dssCalls:m.dssCalls.length});
 console.log('PASS',label,expected,seconds===null?'':seconds.toFixed(3)+' s');
 return seconds;
}

// Lessons: unchanged behaviour under both profiles, all speeds.
for(const name of Object.keys(lessons))for(const slot of [0,1]){
 for(const turbo of [true,false])for(const iff of [0,1])run(name+slot,{slot,iff,turbo});
 run(name+slot+'S',{slot});
}
for(const slot of [0,1]){
 run('PCM'+slot,{slot,escAfter:1,expected:21});
 run('MODFX'+slot,{slot,foreign:true,expected:5});
 // Without CONFIG another firmware mode is indistinguishable from no card.
 run('DISCOV'+slot,{slot,mode:1,expected:13});
 run('DISCOV'+slot+'S',{slot,mode:1,expected:6});
}

// Deadlines. Fastest: windows at 3.5 MHz with UG_ISA_TURBO_OFF (PROBE),
// everything at 21 MHz without it (PROBEK). Slowest: everything at 3.5 MHz.
const T=13,fast={turbo:true},slow={turbo:false,turboHardware:false},keepSlow={turbo:false};
const d={};
d.rpcFast=run('PROBE',{...fast,patch:{probe_mode:1},stall:{kind:'rpc',after:0},expected:T});
d.rpcSlow=run('PROBE',{...slow,patch:{probe_mode:1},stall:{kind:'rpc',after:0},expected:T});
d.rpcKeepFast=run('PROBEK',{...fast,patch:{probe_mode:1},stall:{kind:'rpc',after:2},expected:T});
d.rpcKeepSlow=run('PROBEK',{...keepSlow,patch:{probe_mode:1},stall:{kind:'rpc',after:2},expected:T});
d.gsFast=run('PROBE',{...fast,patch:{probe_mode:2},stall:{kind:'gs'},expected:T});
d.gsKeepFast=run('PROBEK',{...fast,patch:{probe_mode:2},stall:{kind:'gs'},expected:T});
d.dataFast=run('PROBE',{...fast,patch:{probe_mode:3},stall:{kind:'data'},expected:T});
d.dataSlow=run('PROBE',{...slow,patch:{probe_mode:3},stall:{kind:'data'},expected:T});
d.dataKeepFast=run('PROBEK',{...fast,patch:{probe_mode:3},stall:{kind:'data'},expected:T});
d.dataKeepSlow=run('PROBEK',{...keepSlow,patch:{probe_mode:3},stall:{kind:'data'},expected:T});
d.configFast=run('PROBE',{...fast,stall:{kind:'config'},expected:T});
d.configSlow=run('PROBE',{...slow,stall:{kind:'config'},expected:T});
console.log(JSON.stringify(d,null,1));
for(const k of ['rpcFast','rpcKeepFast','gsFast','gsKeepFast'])assert(d[k]>=1.0,`${k}: 1 s deadline expired after ${d[k]} s`);
for(const k of ['dataSlow','dataKeepSlow'])assert(d[k]<4.0,`${k}: GS_DATA wait ${d[k]} s reaches the 5 s grant fuse`);
writeFileSync(join(out,'result.json'),JSON.stringify({deadlines:d,runs:results},null,1)+'\n');
console.log('nodss-check PASS',results.length,'runs');
