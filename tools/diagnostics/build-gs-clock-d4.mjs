// SPDX-License-Identifier: GPL-2.0-or-later
// Isolated read-only Turbo comparison. Does not change any firmware/main EXE.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,realpathSync,symlinkSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {NativeCard} from '../../tests/ultrags/dss/native-card.mjs';
import {sha256} from '../ultrags/build-evidence.mjs';
import {makeZip,makeImg} from '../ultrags/disk-formats.mjs';
import {readZip,readFat12} from '../ultrags/verify-package.mjs';
const out=resolve(process.argv[2]),prior=resolve('build/gs-fast13-delivery');
assert(!existsSync(out),'frozen output exists');
const previous=JSON.parse(readFileSync(join(prior,'R13.json')));
for(const[n,v]of Object.entries(previous.files))assert.equal(sha256(readFileSync(join(prior,n))),v.sha256,n);
const source='host/sprinter/diagnostics/uggsclock.asm',doc='host/sprinter/ultrags/docs/GS-CLOCK-D4.md';
const paths=[source,doc,'tools/diagnostics/build-gs-clock-d4.mjs',
 ...['ug-harness.mjs','Z80core.js','ug-card.js','native-card.mjs','config-card.mjs'].map(n=>'tests/ultrags/dss/'+n)];
const inputs=Object.fromEntries(paths.map(p=>[p,sha256(readFileSync(p))]));
const Z80=loadZ80(resolve('.')),kits=[],results=[],production=[];
mkdirSync(out,{recursive:true});
function run(bytes,slot,iff,turbo,hardware,provider){
 const h=parseExe(bytes),reads=[];
 const card={base:0x2a0,alias:65535,tickUs:us=>provider.tickUs?.(us),
  writePort(){throw Error('D4 must not write card');},
  readPort(port){
   assert.equal(port,0xbb);
   const index=reads.length,requested=index%3===1;
   assert.equal(m.turbo,requested,'wrong software Turbo order');
   assert.equal(m.cpuHz,requested&&hardware?21000000:3500000);
   assert.equal(!!m.z.getState().iff1,false,'ISA outside DI');
   const value=provider.read(port,index,m.cpuHz);
   reads.push({port,turbo:m.turbo,hz:m.cpuHz,value});return value;
  }};
 const m=new SprinterMachine({card,cardSlot:slot,turboInit:turbo,turboHardware:hardware,
  rejectTurboIsa:false,page3Init:0x71,logLimit:400});
 m.mem.set(bytes,h.loadAddr);
 const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff});
 assert.equal(r.exitCode,0,m.text);assert.deepEqual(m.violations,[]);
 assert.equal(m.page3,0x71);assert.equal(m.system,1);assert.equal(m.turbo,true);
 assert.equal(!!r.end.iff1,!!iff);assert.equal(r.end.sp,h.stack-2);
 assert.equal(reads.length,48);assert.equal(m.windowCount,48);
 assert.equal(m.isaLog.length,48);assert(m.isaLog.every(x=>x.dir==='r'&&x.slot===slot));
 assert(m.maxWindowUs<2000&&m.maxDiUs<10000);
 assert(!m.text.includes('RESULT PASS'));assert(m.text.includes('DIAGNOSTIC COMPLETE'));
 // Every software speed request precedes SYSTEM=11 (opening ISA); the
 // harness itself rejects Turbo changes while ISA is mapped.
 const hex=n=>n.toString(16).toUpperCase().padStart(2,'0');
 const lines=m.text.split(/\r?\n/).filter(s=>s.startsWith('SLOW1='));
 assert.equal(lines.length,16);
 lines.forEach((line,i)=>assert.equal(line,`SLOW1=${hex(reads[3*i].value)} FAST=${hex(reads[3*i+1].value)} SLOW2=${hex(reads[3*i+2].value)}`));
 return {text:m.text,reads,steps:r.steps,maxWindowUs:m.maxWindowUs,maxDiUs:m.maxDiUs};
}
for(const variant of ['a','b']){
 const dir=join(out,'evidence',variant);mkdirSync(dir,{recursive:true});const kit=new Map();
 for(const slot of [0,1]){
  const name=`UGGSC${slot}.EXE`,path=join(dir,name);
  execFileSync('sjasmplus',[`-DPROBE_SLOT=${slot}`,'--raw='+path,'--lst='+path+'.lst',source],{stdio:'pipe'});
  const bytes=readFileSync(path);kit.set(name,bytes);
  for(const iff of [0,1])for(const turbo of [false,true])for(const hardware of [false,true])
   for(const scenario of ['idle','fast-missing','absent','changing']){
    const provider={read(p,n,hz){return scenario==='idle'?0x7e:scenario==='fast-missing'?(hz===21000000?255:0x7e):scenario==='absent'?255:[0x7e,0x7f,0xfe,0xff][n%4];}};
    results.push({variant,name,iff,turbo,hardware,scenario,...run(bytes,slot,iff,turbo,hardware,provider)});
   }
 }
 kits.push(kit);
}
for(const[n,b]of kits[0])assert.deepEqual(kits[1].get(n),b);
const nativeDir=resolve('build/gs-fast13-a/native'),manifestPath=join(nativeDir,'native-card-build.json');
const manifest=JSON.parse(readFileSync(manifestPath)),addon=join(nativeDir,'native-card.node');
for(const[p,h]of Object.entries(manifest.inputs))assert.equal(sha256(readFileSync(p)),h,p);
assert.equal(sha256(readFileSync(addon)),manifest.artifact);
inputs[manifestPath]=sha256(readFileSync(manifestPath));inputs[addon]=sha256(readFileSync(addon));
const catalogPath='build/gs-fast13-a/multifw-release/generated/multifw/catalog.bin';
const catalog=readFileSync(catalogPath);inputs[catalogPath]=sha256(catalog);
for(const slot of [0,1])for(const hardware of [false,true])for(const gs of [false,true]){
 const c=new NativeCard(catalog,{addon,gs}),provider={tickUs:us=>c.tickUs(us),read:p=>c.readPort(p)};
 const r=run(kits[0].get(`UGGSC${slot}.EXE`),slot,1,true,hardware,provider);
 assert(r.reads.every(x=>x.value===(gs?0x7e:255)));assert.equal(c.nativeWrites,0);
 production.push({slot,hardware,gs,...r});
}
const photo='/Users/dmitry/Yandex.Disk.localized/Скриншоты/photo_2026-10-20_23-43-13.jpg';
const real={status:'REAL_PASS_IDLE_ALIAS_TURBO_OFF / REAL_FAIL_PROPLAY_DETECTION',photo,sha256:sha256(readFileSync(photo)),
 rows:16,row:'STATUS=01 ERROR=00 GSERR=00 NATIVE=7E ALIAS=7E AFTER=7E',
 proplay:'General Sound not found.',firmwareContext:'R13 requested delivery; firmware identity not visible in this photo',
 limits:['No measurement of physical Turbo mode, ISA delay or IOCHRDY','No LOAD or sound acceptance']};
const payload=new Map([...Object.keys(previous.files).filter(n=>n.endsWith('.EXE')).map(n=>[n,readFileSync(join(prior,n))]),...kits[0]]);
payload.set('CLOCK-D4.TXT',Buffer.from('D4 GS clock comparison. DO NOT REFLASH: R13 UF2 unchanged.\r\nWith ULTRAGS and GSALIAS ON, known slot0: UGGSC0\r\nKnown slot1: UGGSC1. Photograph all rows.\r\nEach row reads ONLY 00BB, requesting Turbo OFF / ON / OFF.\r\nNo card writes, DATA reads, reset or SAVE. PAGE3/IFF restored.\r\nPhysical frequency is not measured; hardware Turbo permission is independent.\r\nSLOW1=7E FAST=FF SLOW2=7E identifies speed dependence in this probe.\r\nAll7E does not accept PROPLAY: its full access sequence still differs.\r\nDSS software Turbo ON is restored at exit.\r\n'));
const img=makeImg([...payload]);for(const[n,b]of payload)assert.deepEqual(readFat12(img).get(n),b);
payload.set('CURRENT.IMG',img);payload.set('CURRENT.UF2',readFileSync(join(prior,'CURRENT.UF2')));
payload.set('NOTES.MD',readFileSync(doc));
payload.set('HASHES.TXT',Buffer.from([...payload].map(([n,b])=>sha256(b)+'  '+n).join('\r\n')+'\r\n'));
const zip=makeZip([...payload]);for(const[n,b]of payload)assert.deepEqual(readZip(zip).get(n),b);payload.set('CURRENT.ZIP',zip);
for(const[n,b]of payload)writeFileSync(join(out,n),b);
for(const[n,obj]of [['actual-exe.json',{results,production}],['real-2343.json',real],['previous-R13.json',previous],['native-manifest.json',manifest]])
 writeFileSync(join(out,'evidence',n),JSON.stringify(obj,null,2)+'\n');
for(const p of paths)writeFileSync(join(out,'evidence',p.replaceAll('/','_')),readFileSync(p));
for(const[p,h]of Object.entries(inputs))assert.equal(sha256(readFileSync(p)),h,p);
function evidenceFiles(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?evidenceFiles(join(dir,e.name)):[join(dir,e.name)]);}
const report={status:'DIAGNOSTIC_HOST_PASS / REAL_PENDING',profile:'R13_GS_CLOCK_D4',previous:realpathSync('build/latest'),
 firmwareUnchanged:true,mainToolsUnchanged:true,inputs,counts:{model:results.length,production:production.length},
 files:Object.fromEntries([...payload].map(([n,b])=>[n,{bytes:b.length,sha256:sha256(b)}])),
 evidence:Object.fromEntries(evidenceFiles(join(out,'evidence')).map(p=>[p.slice(out.length+1),sha256(readFileSync(p))])),
 limits:['Functional SDK tests do not model electrical timing.','Turbo ON reads are restricted to this separate diagnostic; main UG ISA contract is unchanged.']};
writeFileSync(join(out,'D4.json'),JSON.stringify(report,null,2)+'\n');
for(const[n,v]of Object.entries(report.files))assert.equal(sha256(readFileSync(join(out,n))),v.sha256);
if(process.argv.includes('--publish')){
 const tmp=resolve('build/latest-gs-d4.tmp');assert(!existsSync(tmp));symlinkSync(out,tmp,'dir');renameSync(tmp,resolve('build/latest'));
}
console.log('D4 PASS',report.counts,'R13 UF2 and all previous EXEs unchanged; ZIP/IMG readback PASS',out);
