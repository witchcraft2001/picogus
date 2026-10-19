// SPDX-License-Identifier: GPL-2.0-or-later
// Shared configuration path in all affected applications, actual EXE bytes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {PcmCard} from './pcm-card.mjs';
import {verifyBuild,sha256} from '../../../tools/ultrags/build-evidence.mjs';
const root=resolve(process.argv[2]??'.'),build=resolve(process.argv[3]??'build');
const dir=join(build,'ultrags/dss'),assembly=verifyBuild(root,dir),Z80=loadZ80(root);
const catalog=readFileSync(process.env.UG_S2_CATALOG??join(build,'multifw-release/generated/multifw/catalog.bin'));
const results=[],executed=new Map();
const commands={UGMEM:'INFO',UGLOAD:'T.BIN /TYPE:BLOB',UGDUMP:'1 OUT.BIN',
 UGPLAY:'T.RAW /RATE:8000 /BITS:8 /CH:1 /FMT:U8 /WAIT',UGMON:'/COUNT:1',
 UGBENCH:'/BYTES:3 /LOOPS:1 /METHOD:FIXED',UGTEST:'PROTO'};
for(const [app,cli] of Object.entries(commands))for(const slot of [0,1])for(const iff of [0,1])for(const page3 of [3,0xe9])for(const turboInit of [false,true])for(const turboHardware of [false,true]) {
 const card=new PcmCard(catalog,{selectorDelayUs:800,requireEcho:true});
 if(app==='UGDUMP')card.objects.set(1,{kind:0,size:3,reserved:16,offset:0,pins:0,state:1,uploaded:3,data:Buffer.from([1,2,3])});
 const bytes=readFileSync(join(dir,app+'.EXE')),h=parseExe(bytes);
 executed.set(app,{name:app+'.EXE',size:bytes.length,sha256:sha256(bytes)});
 const m=new SprinterMachine({card,cardSlot:slot,commandLine:cli+` /SLOT:${slot}`,page3Init:page3,turboInit,turboHardware,movingClock:true,logLimit:1000,files:{'T.BIN':Buffer.from([1,2,3]),'T.RAW':Buffer.alloc(8,128)}});
 const dss=m.dssCall.bind(m);m.dssCall=s=>{const fn=s.c,r=dss(s);if([0x5b,0x5c,0x21,0x31].includes(fn)){
  s.ix=0xdead;s.iy=0xbeef;s.d=0xa1;s.e=0xb2;s.c=0xc3;
  if(fn!==0x21){s.b=0xd4;s.h=0xe5;s.l=0xf6;}if(fn!==0x31)s.a=0x97;
 }return r;};
 m.mem.set(bytes,h.loadAddr);const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff,budget:12000000});
 const name=`${app} slot=${slot} iff=${iff} page3=${page3} turbo=${turboInit}/${turboHardware}`;
 assert.equal(run.exitCode,0,`${name}\n${m.text}\n${m.violations}`);
 assert.deepEqual(m.violations,[]);assert.equal(m.page3,page3);assert.equal(m.system,1);
 assert.equal(!!run.end.iff1,!!iff);assert.equal(run.end.sp,h.stack-2);assert(m.turbo);
 assert.equal(card.staleReads,0);assert(m.maxDiUs<2000);assert(m.maxWindowUs<2000);
 results.push({name,ok:true,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs});
}
for(const app of Object.keys(commands))for(const cli of ['/?','/INVALID']) {
 const bytes=readFileSync(join(dir,app+'.EXE')),h=parseExe(bytes);
 const m=new SprinterMachine({card:null,commandLine:cli,turboInit:false});m.mem.set(bytes,h.loadAddr);
 const run=runImage(Z80,m,{entry:h.entry,stack:h.stack});assert.equal(run.exitCode,cli==='/?'?0:1);
 assert.equal(m.ioLog.length,0);assert.equal(m.isaLog.length,0);results.push({name:app+' '+cli+' no hardware',ok:true});
}
assert.deepEqual(verifyBuild(root,dir),assembly);
writeFileSync(join(build,'ultrags/logs/config-regression.json'),JSON.stringify({results,executed:[...executed.values()],scriptSha256:sha256(readFileSync(new URL(import.meta.url))),catalogSha256:sha256(catalog)},null,2)+'\n');
console.log(`Shared config actual-EXE matrix: ${results.length} PASS`);
