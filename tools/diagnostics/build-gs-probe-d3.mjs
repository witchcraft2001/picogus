// SPDX-License-Identifier: GPL-2.0-or-later
// Read-only, Turbo-off differential GS status probe. No firmware change.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,symlinkSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {LegacyMachine} from '../../tests/ultrags/dss/legacy-machine.mjs';
import {NativeCard} from '../../tests/ultrags/dss/native-card.mjs';
import {sha256} from '../ultrags/build-evidence.mjs';
import {makeZip,makeImg} from '../ultrags/disk-formats.mjs';
import {readZip,readFat12} from '../ultrags/verify-package.mjs';

const out=resolve(process.argv[2]),prior=resolve('build/rpc-deadline-d2-delivery');
assert(!existsSync(out),'frozen delivery exists');
const old=JSON.parse(readFileSync(join(prior,'D2.json')));
for(const[n,v]of Object.entries(old.files))assert.equal(sha256(readFileSync(join(prior,n))),v.sha256,n);
const Z80=loadZ80(resolve('.')),source='host/sprinter/diagnostics/uggs.asm';
const includes=['host/sprinter/ultrags/lib','host/sprinter/ultrags/include','build/rpc-deadline-d2/a/ultrags/gen'];
const ports=[0x2a1,0x2a6,0x2a7,0x2bb,0xbb,0x2bb],results=[],kits=[];
const paths=[source,'tools/diagnostics/build-gs-probe-d3.mjs','host/sprinter/ultrags/lib/isa.asm',
 'host/sprinter/ultrags/docs/GS-PROBE-D3.md',
 'host/sprinter/ultrags/include/ugmem.inc',includes[2]+'/ug_wire.inc',
 ...['ug-harness.mjs','Z80core.js','ug-card.js','config-card.mjs','native-card.mjs','legacy-machine.mjs'].map(n=>'tests/ultrags/dss/'+n)];
const inputs=Object.fromEntries(paths.map(p=>[p,sha256(readFileSync(p))]));
mkdirSync(out,{recursive:true});
function execute(bytes,card,slot,iff,turbo){
 const h=parseExe(bytes),m=new SprinterMachine({card,cardSlot:slot,page3Init:0x71,turboInit:turbo,movingClock:true,logLimit:200});
 m.mem.set(bytes,h.loadAddr);
 const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff});
 assert.equal(r.exitCode,0,m.text);assert.deepEqual(m.violations,[]);
 assert.equal(m.page3,0x71);assert.equal(m.system,m.systemInit);assert.equal(m.turbo,true);
 assert.equal(!!r.end.iff1,!!iff);assert.equal(r.end.sp,h.stack-2);
 assert(m.maxWindowUs<2000&&m.maxDiUs<10000);
 assert.equal(m.isaLog.length,96);assert(m.isaLog.every(x=>x.dir==='r'&&x.slot===slot));
 assert(!m.text.includes('RESULT PASS'));assert(m.text.includes('DIAGNOSTIC COMPLETE'));
 return {m,r};
}
const scenarios=[
 [1,0,0,0x7e,0x7e,0x7e], // idle
 [1,0,0,0x7e,0xff,0x7e], // alias missing while native replies
 [1,0,0,0xff,0xff,0xff], // CB+DB busy OR missing replies; no inference
 [1,0,0,0x7f,0x7e,0xfe], // state changes between samples
 [0x61,2,14,0x7e,0x7e,0x7e],
 [255,255,255,255,255,255]
];
for(const variant of ['a','b']){
 const dir=join(out,'evidence',variant);mkdirSync(dir,{recursive:true});
 const kit=new Map();
 for(const slot of [0,1]){
  const name=`UGGS${slot}.EXE`,path=join(dir,name);
  execFileSync('sjasmplus',[...includes.map(p=>'--inc='+p),`-DPROBE_SLOT=${slot}`,'--raw='+path,'--lst='+path+'.lst',source],{stdio:'pipe'});
  const bytes=readFileSync(path);kit.set(name,bytes);
  for(const values of scenarios)for(const iff of [0,1])for(const turbo of [false,true]){
   let count=0;
   const card={base:0x2a0,alias:65535,tickUs(){},writePort(){throw Error('probe wrote card');},
    readPort(p){assert.equal(p,ports[count%6]);return values[count++%6];}};
   const {m,r}=execute(bytes,card,slot,iff,turbo);assert.equal(count,96);
   const line=values.map((v,i)=>['STATUS','ERROR','GSERR','NATIVE','ALIAS','AFTER'][i]+'='+v.toString(16).toUpperCase().padStart(2,'0')).join(' ');
   assert.equal(m.text.split(line).length-1,16,m.text);
   results.push({variant,name,values,iff,turbo,steps:r.steps,text:m.text});
  }
 }
 kits.push(kit);
}
for(const[n,b]of kits[0])assert.deepEqual(kits[1].get(n),b);
// Freshness-check the production C adapter already built for D2.
const nativeDir=resolve('build/rpc-deadline-d2/native'),manifestPath=join(nativeDir,'native-card-build.json');
const nativeManifest=JSON.parse(readFileSync(manifestPath)),addon=join(nativeDir,'native-card.node');
for(const[p,h]of Object.entries(nativeManifest.inputs))assert.equal(sha256(readFileSync(p)),h,p);
assert.equal(sha256(readFileSync(addon)),nativeManifest.artifact);
inputs[manifestPath]=sha256(readFileSync(manifestPath));inputs[addon]=sha256(readFileSync(addon));
const catalogPath='build/config-fast12-delivery/evidence/build-a/generated/multifw/catalog.bin';
const catalog=readFileSync(catalogPath);inputs[catalogPath]=sha256(catalog);
const production=[];
for(const slot of [0,1])for(const gs of [false,true]){
 const c=new NativeCard(catalog,{addon,gs});
 c.writePort=()=>{throw Error('probe wrote production card');};
 const {m}=execute(kits[0].get(`UGGS${slot}.EXE`),c,slot,1,true);
 assert.equal(c.nativeWrites,0);
 assert(m.text.includes(`NATIVE=7E ALIAS=${gs?'7E':'FF'} AFTER=7E`),m.text);
 production.push({slot,gs,text:m.text});
}
// Execute the unmodified PROPLAY detection routine, stopping at its result
// branch before reset. Functional responses only, not an ISA timing model.
const proplayPath='/Users/dmitry/dev/zx/sprinter/other/07BA-90CE/BIN/PROPLAY.EXE';
const proplay=readFileSync(proplayPath);inputs[proplayPath]=sha256(proplay);
assert.equal(inputs[proplayPath],'0fac9cde2ac1490c947046a2ecd033f7d573c9ecdc41a277705ce82479225803');
const detection=[];
for(const turbo of [false,true])for(const value of [0x7e,0xff]){
 const reads=[];
 const card={base:0x2a0,alias:65535,tickUs(){},writePort(){throw Error('detection wrote card');},
  readPort(p){assert.equal(p,0xbb);reads.push({port:p,turbo:m.turbo});return value;}};
 const m=new LegacyMachine({card,cardSlot:0,turboInit:turbo,logLimit:100});
 m.mem.set(proplay,0x8100-22);let decision;
 m.beforeStep=st=>{if(st.pc===0x8234||st.pc===0x823f){decision=st.pc;m.exited=true;}};
 runImage(Z80,m,{entry:0x8204,stack:0xbfff,iff:0,budget:3000000});
 assert.equal(decision,value===0xff?0x823f:0x8234);
 assert(reads.length>0&&reads.every(r=>r.turbo===turbo));
 assert.equal(m.turboWrites,0);
 assert.deepEqual(m.violations,[]);
 detection.push({entry:'8204',turbo,value,reads,decision:decision.toString(16),turboWrites:m.turboWrites});
}
const photo='/Users/dmitry/Yandex.Disk.localized/Скриншоты/photo_2026-10-20_22-48-02.jpg';
const real={status:'REAL_FAIL_GS_DETECTION',photo,sha256:sha256(readFileSync(photo)),
 firmware:'pg-ultrags-cfgfast-r12 v4.1.1',mode:'ULTRAGS',bootState:'READY',gsAliases:'ON',
 ugcfgAlias:'PASS',ugcfgInfo:'PASS',proplay:'General Sound not found.',
 limits:['No measured physical Turbo state or raw GS status byte supplied.','No evidence of sound playback.']};
const notes=Buffer.from('D3 READ-ONLY GS PROBE. R12 UF2 AND ALL D2 TOOLS UNCHANGED.\r\nNo flashing. Copy UGGS0.EXE (known slot0) from this package.\r\nWith ULTRAGS active, BASE02A0 and GSALIAS ON, run UGGS0.\r\nPhotograph the full output. Known slot1: UGGS1.\r\nNative GS status02BB is compared with alias00BB at Turbo OFF.\r\nNo card writes, reset, SAVE, mode change or consuming DATA reads.\r\nIdle expected: STATUS01 ERROR00 GSERR00 NATIVE7E ALIAS7E AFTER7E.\r\nFF alone is ambiguous: busy CB+DB or missing response.\r\nThis does not test PROPLAY at Turbo ON or prove an electrical cause.\r\n');
const payload=new Map([...Object.keys(old.files).filter(n=>n.endsWith('.EXE')).map(n=>[n,readFileSync(join(prior,n))]),...kits[0],['GSPROBE.TXT',notes]]);
const img=makeImg([...payload]);for(const[n,b]of payload)assert.deepEqual(readFat12(img).get(n),b);
payload.set('CURRENT.IMG',img);payload.set('CURRENT.UF2',readFileSync(join(prior,'CURRENT.UF2')));
payload.set('NOTES.MD',readFileSync('host/sprinter/ultrags/docs/GS-PROBE-D3.md'));
payload.set('HASHES.TXT',Buffer.from([...payload].map(([n,b])=>sha256(b)+'  '+n).join('\r\n')+'\r\n'));
const zip=makeZip([...payload]);for(const[n,b]of payload)assert.deepEqual(readZip(zip).get(n),b);payload.set('CURRENT.ZIP',zip);
for(const[n,b]of payload)writeFileSync(join(out,n),b);
for(const[n,data]of [['actual-exe.json',{results,production,detection}],['real-2248.json',real],['previous-D2.json',old]])
 writeFileSync(join(out,'evidence',n),JSON.stringify(data,null,2)+'\n');
writeFileSync(join(out,'evidence','uggs.asm'),readFileSync(source));
writeFileSync(join(out,'evidence','build-gs-probe-d3.mjs'),readFileSync('tools/diagnostics/build-gs-probe-d3.mjs'));
for(const[p,h]of Object.entries(inputs))assert.equal(sha256(readFileSync(p)),h,p);
function evidenceFiles(dir){
 return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?evidenceFiles(join(dir,e.name)):[join(dir,e.name)]);
}
const report={status:'DIAGNOSTIC_HOST_PASS / REAL_PENDING',profile:'R12_HOST_D2_GS_PROBE_D3',
 firmwareUnchanged:true,mainToolsUnchanged:true,prior,inputs,
 counts:{model:results.length,production:production.length,proplayDetection:detection.length},
 files:Object.fromEntries([...payload].map(([n,b])=>[n,{bytes:b.length,sha256:sha256(b)}])),
 evidence:Object.fromEntries(evidenceFiles(join(out,'evidence')).map(p=>[p.slice(out.length+1),sha256(readFileSync(p))])),
 limits:['Functional tests do not measure PIO/ARM response latency or WAIT acceptance.','PROPLAY detect routine tested in isolation; no reset, LOAD or sound acceptance.']};
writeFileSync(join(out,'D3.json'),JSON.stringify(report,null,2)+'\n');
if(process.argv.includes('--publish')){
 const tmp=resolve('build/latest-gs-d3.tmp');assert(!existsSync(tmp));
 symlinkSync(out,tmp,'dir');renameSync(tmp,resolve('build/latest'));
}
console.log('D3 PASS',report.counts,'UF2 and main EXEs unchanged; ZIP/IMG readback PASS',out);
