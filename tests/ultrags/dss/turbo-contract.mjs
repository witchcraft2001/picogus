// SPDX-License-Identifier: GPL-2.0-or-later
// Independent clock and actual-EXE checks for the DSS Turbo contract.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {loadZ80,parseExe,SprinterMachine,runImage,PORT_SYS_RAM,PORT_SYSTEM} from './ug-harness.mjs';
import UgCard from './ug-card.js';
import {SlowCard} from './slow-card.mjs';
import {sha256,verifyBuild,executionInputs} from '../../../tools/ultrags/build-evidence.mjs';
const root=resolve(process.argv[2]||'.'),build=resolve(process.argv[3]||'build');
const dir=join(build,'ultrags/dss'),assembly=verifyBuild(root,dir),inputs=executionInputs(root);
const script=readFileSync(new URL(import.meta.url)),Z80=loadZ80(root),results=[];
let elapsed=0;
const clock=new SprinterMachine({card:{tickUs(us){elapsed+=us;}},mapperRead:0xB6});
clock.tick(21); // one us in Turbo
clock.ioWrite(PORT_SYS_RAM,2); clock.tick(7); // two us at 3.5 MHz
clock.ioWrite(PORT_SYS_RAM,3); clock.tick(21); // one us in Turbo
assert.equal(elapsed,4);assert.equal(clock.elapsedTicks,84);
clock.ioWrite(PORT_SYSTEM,1);assert.equal(clock.ioRead(PORT_SYSTEM),0xB6);
clock.page3=0xFE;clock.mem[0xC13A]=0x57;
assert.equal(clock.memRead(0xC13A),0xA5);
clock.memWrite(0xC13A,0xD1);assert.equal(clock.mem[0xC13A],0x57);
const inhibited=new SprinterMachine({card:null,turboInit:false,turboHardware:false});
inhibited.ioWrite(PORT_SYS_RAM,3);assert.equal(inhibited.cpuHz,3500000);assert.equal(inhibited.turbo,true);
results.push({name:'clock fractions, mapper read, separate system page, hardware inhibit',ok:true});
const executed=new Map();
function run(app,cli,opts={}) {
  const bytes=readFileSync(join(dir,app+'.EXE')),h=parseExe(bytes);
  executed.set(app,{name:app+'.EXE',size:bytes.length,sha256:sha256(bytes)});
  const m=new SprinterMachine({card:opts.card??null,commandLine:cli,turboInit:opts.turboInit,
    page3Init:0xE9,logLimit:100000,files:{'TEST.BIN':Buffer.from([1,2,3])}});
  if(opts.beforeStep)m.beforeStep=st=>opts.beforeStep(st,m);
  m.mem.set(bytes,h.loadAddr);
  const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:opts.iff??1});
  assert.deepEqual(m.violations,[]);assert.equal(r.exitCode,opts.code??0);
  assert.equal(m.page3,0xE9);assert.equal(m.system,1);
  assert.equal(!!r.end.iff1,!!(opts.iff??1));assert.equal(r.end.sp,h.stack-2);
  if(opts.noTurbo) {assert.equal(m.turboWrites,0);assert.equal(m.turbo,opts.turboInit);}
  else {assert(m.turboWrites>0);assert.equal(m.turbo,true);}
  assert(m.maxDiUs<2000);
  return m;
}
for(const turboInit of [false,true]) for(const app of ['UGCFG','UGMEM','UGLOAD','UGDUMP','UGBENCH','UGTEST']) {
  for(const [cli,code] of [['/?',0],['/INVALID',1]]) {
    run(app,cli,{turboInit,code,noTurbo:true});
    results.push({name:`${app} ${cli} initialTurbo=${turboInit}`,ok:true});
  }
  const cli={UGCFG:'INFO',UGMEM:'INFO',UGLOAD:'TEST.BIN /TYPE:BLOB',UGDUMP:'1 BACK.BIN',
    UGBENCH:'/BYTES:1 /LOOPS:1 /METHOD:FIXED',UGTEST:'BUS'}[app];
  run(app,cli,{turboInit,code:2});
  results.push({name:`${app} absent initialTurbo=${turboInit}`,ok:true});
}
for(const turboInit of [false,true]) for(const iff of [0,1]) {
  const card=new UgCard({}),m=run('UGDIAG',null,{card,turboInit,iff});
  assert.equal(card.snapSeq,1);
  assert.equal(m.isaLog.filter(e=>e.dir==='r' && e.isa===0x2A5).length,128);
  let count=0,groups=[];
  for(const e of [...m.isaLog.map(e=>({...e,isaAccess:true})),...m.ioLog].sort((a,b)=>a.t-b.t)) {
    if(e.isaAccess && e.dir==='r' && e.isa===0x2A5)count++;
    if(e.dir==='out' && e.port===PORT_SYSTEM && e.val===1 && count){groups.push(count);count=0;}
  }
  assert.deepEqual(groups,Array(16).fill(8));
  results.push({name:`SNAPSHOT single latch, exactly 128 reads in 16 windows; Turbo=${turboInit} IFF=${iff}`,
    ok:true,maxWindowUs:m.maxWindowUs,maxDiUs:m.maxDiUs});
}
const listing=readFileSync(join(dir,'ugmem.lst'),'utf8'),entries=new Set();
for(const line of listing.split('\n')) {
  const match=line.match(/\+*([0-9A-F]{4})\s+(UG_WRITE|UG_READ):\s*$/);
  if(match)entries.add(parseInt(match[1],16));
}
assert.equal(entries.size,2);
for(const chunk of [0,1,8,32,256,512]) {
  const card=new SlowCard(readFileSync(join(build,'host/s2-catalog.bin')));
  const m=run('UGMEM','ROUNDTRIP 1024',{card,beforeStep(st,m){
    if(entries.has(st.pc)){m.mem[0xBC16]=chunk&255;m.mem[0xBC17]=chunk>>>8;}
  }});
  const groups=[];let n=0,total=0;
  for(const e of [...m.isaLog.map(e=>({...e,isaAccess:true})),...m.ioLog].sort((a,b)=>a.t-b.t)) {
    if(e.isaAccess && e.isa===card.base){n++;total++;}
    if(e.dir==='out' && e.port===PORT_SYSTEM && e.val===1 && n){groups.push(n);n=0;}
  }
  assert.equal(total,2048);assert(groups.length);assert(groups.every(n=>n<=8));
  assert.equal(Math.max(...groups),chunk===1?1:8);
  results.push({name:`caller chunk ${chunk}: complete 1024-byte write/read with cap8`,ok:true,
    maxWindowUs:m.maxWindowUs,maxDiUs:m.maxDiUs});
}
assert.deepEqual(executionInputs(root),inputs);verifyBuild(root,dir);
assert(readFileSync(new URL(import.meta.url)).equals(script));
writeFileSync(join(build,'ultrags/logs/turbo-contract.json'),JSON.stringify({results,executed:[...executed.values()],
  inputs,buildInputs:assembly.inputs,scriptSha256:sha256(script)},null,2)+'\n');
console.log(`Turbo contract: ${results.length} PASS`);
