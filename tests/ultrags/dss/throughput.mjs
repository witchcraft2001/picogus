// SPDX-License-Identifier: GPL-2.0-or-later
// Actual Z80 instructions, not a physical ISA latency or Turbo approval.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadZ80,parseExe,SprinterMachine,runImage,PORT_SYSTEM} from './ug-harness.mjs';
import {SlowCard} from './slow-card.mjs';
import {crc32} from './config-card.mjs';
import {verifyBuild,executionInputs,sha256} from '../../../tools/ultrags/build-evidence.mjs';

const root=resolve(process.argv[2]||'.'),build=resolve(process.argv[3]||'build');
const dir=join(build,'ultrags/dss'),out=join(build,'ultrags/throughput');
mkdirSync(out,{recursive:true});
const assembly=verifyBuild(root,dir),inputs=executionInputs(root),Z80=loadZ80(root);
const catalog=readFileSync(join(build,'host/s2-catalog.bin')),results=[],executed=[];
function label(list,name) {
 const match=list.match(new RegExp('\\+*([0-9A-F]{4})\\s+'+name+':\\s*$','m'));
 assert(match,'missing label '+name);return parseInt(match[1],16);
}
const profiles=[{name:'UGMEM',window:8,turbo:false,dir}];
for(const [name,window,turbo] of [['UGM64',64,false],['UGM256',256,false],['UGM8T',8,true],['UGM64T',64,true],['UGM256T',256,true]]) {
 const src=join(out,name+'.asm');
 writeFileSync(src,`; SPDX-License-Identifier: GPL-2.0-or-later\n; Experimental owner-authorized profile, REAL_PENDING.\n    DEFINE UG_EXPERIMENT_WINDOW ${window}\n${turbo?'    DEFINE UG_EXPERIMENT_TURBO_WRITE\n':''}    INCLUDE "ugmem.asm"\n`);
 execFileSync(process.env.SJASMPLUS||'sjasmplus',[
  ...['host/sprinter/ultrags/apps','host/sprinter/ultrags/include','host/sprinter/ultrags/lib'].map(p=>'--inc='+join(root,p)),
  '--inc='+join(build,'ultrags/gen'),'--raw='+join(out,name+'.EXE'),'--lst='+join(out,name.toLowerCase()+'.lst'),src],{stdio:'pipe'});
 profiles.push({name,window,turbo,dir:out});
}
for(const p of profiles) {
 p.bytes=readFileSync(join(p.dir,p.name+'.EXE'));p.header=parseExe(p.bytes);
 p.list=readFileSync(join(p.dir,p.name.toLowerCase()+'.lst'),'utf8');
 executed.push({name:p.name+'.EXE',size:p.bytes.length,sha256:sha256(p.bytes),window:p.window,writeTurbo:p.turbo,readTurbo:false});
}
function run(p,n,opts={}) {
 const card=new SlowCard(catalog,opts),h=p.header,cli=opts.cli??`ROUNDTRIP ${n}${opts.verify?' /VERIFY':''} /SLOT:${opts.slot??0}`;
 const m=new SprinterMachine({card,cardSlot:opts.slot??0,cpuHz:21000000,turboHardware:opts.hardware!==false,
  commandLine:cli,movingClock:true,clockStart:86399,logLimit:0,allowTurboBulkWrites:p.turbo});
 m.mem.set(p.bytes,h.loadAddr);
 const polls=new Map(),groups=[],entries=new Set(['UG_WRITE','UG_READ'].map(k=>label(p.list,k)));
 let count=0,writes=0,reads=0,fastWrites=0;
 if(opts.chunk)m.beforeStep=st=>{if(entries.has(st.pc)){m.mem[0xbc16]=opts.chunk;m.mem[0xbc17]=0;}};
 const rd=m.memRead,wr=m.memWrite,io=m.ioWrite,dss=m.dssCall.bind(m);
 m.memRead=a=>{const v=rd(a);if(m.isaOpen&&m.isaAddr(a)===card.base){assert(!m.turbo,'Turbo read');count++;reads++;}return v;};
 m.memWrite=(a,v)=>{if(a>=0xc000&&m.isaOpen&&m.isaAddr(a)===card.base){count++;writes++;if(m.turbo)fastWrites++;}return wr(a,v);};
 m.ioWrite=(port,v)=>{if(port===PORT_SYSTEM&&v===1&&m.isaOpen&&count){groups.push(count);count=0;}return io(port,v);};
 m.dssCall=st=>{
  const fn=st.c,t=card.transfer;
  if(fn===0x31&&t?.granted) {
   if(!polls.has(t.id))polls.set(t.id,[]);polls.get(t.id).push(t.done);
   if(opts.cancel && t.rd===!!opts.cancelRead && t.done>=opts.cancel)m.escAfter=0;
  }
  const v=dss(st);if(v!=='exit'){if(fn!==0x15)st.ix=0xdead;st.iy=0xbeef;}return v;
 };
 const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:opts.iff??1,budget:opts.budget??100000000});
 assert.equal(r.exitCode,opts.code??0,m.text);assert.deepEqual(m.violations,[]);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!r.end.iff1,!!(opts.iff??1));assert.equal(r.end.sp,h.stack-2);
 assert.equal(card.objects.size,0);assert(!card.transfer);assert(m.maxDiUs<10000);assert(m.turbo);
 if(!opts.code){assert.equal(writes,n);assert.equal(reads,n);}
 assert(groups.every(k=>k<=Math.min(p.window,opts.chunk??p.window)));
 if(!opts.code&&n>=p.window)assert.equal(Math.max(...groups),Math.min(p.window,opts.chunk??p.window));
 if(!p.turbo)assert.equal(fastWrites,0);else if(!opts.code)assert.equal(fastWrites,n);
 for(const samples of polls.values()) {
  assert.equal(samples[0],0);
  if(!opts.legacyPolls)assert(samples.length<=5,'excessive DSS calls');
  assert(samples.every((v,i)=>!i||v-samples[i-1]<=256+p.window-1),'unbounded ESC gap');
 }
 const value={name:opts.name??`${p.name} n=${n} verify=${!!opts.verify} slot=${opts.slot??0} iff=${opts.iff??1} hardware=${opts.hardware!==false}`,
  ok:true,profile:p.name,bytes:n,verify:!!opts.verify,exit:r.exitCode,steps:r.steps,simulatedSeconds:m.elapsedTicks/21000000,
  dataWindows:groups.length,dataWrites:writes,dataReads:reads,turboPayloadWrites:fastWrites,
  grantKeyboardCalls:[...polls.values()].reduce((a,b)=>a+b.length,0),maxWindowUs:m.maxWindowUs,maxDiUs:m.maxDiUs,text:m.text};
 results.push(value);console.log('PASS throughput '+value.name);return value;
}

// Table bytes are checked independently of the running CRC implementation.
const mem=profiles[0],table=label(mem.list,'UG_CRC32_TABLE'),tableBytes=mem.bytes.subarray(table-mem.header.loadAddr,table-mem.header.loadAddr+1024);
assert.equal(table&255,0);assert.equal(tableBytes.length,1024);
for(let i=0;i<256;i++){let c=i;for(let b=0;b<8;b++)c=(c&1)?(c>>>1)^0xedb88320:c>>>1;for(let plane=0;plane<4;plane++)assert.equal(tableBytes[plane*256+i],(c>>>(plane*8))&255);}
function crcCall(p,data,split=false) {
 const m=new SprinterMachine({card:null,logLimit:0}),h=p.header,ptr=0x2001,stack=0xbffe;
 m.mem.set(p.bytes,h.loadAddr);m.mem.set(data,ptr);m.mem[0x7000]=0;
 let cycles=0;
 function invoke(name,off,n) {
  let seeded=false,expected,returned;
  m.exited=false;m.exitCode=null;m.violations=[];m.cycles=0;
  m.mem[stack]=0;m.mem[stack+1]=0x70;
  m.beforeStep=st=>{
   if(!seeded) {
    seeded=true;Object.assign(st,{b:n>>>8,c:n&255,h:(ptr+off)>>>8,l:(ptr+off)&255,d:0x12,e:0x34,ix:0x5678,iy:0x9abc});
    for(const k of ['a_prime','b_prime','c_prime','d_prime','e_prime','h_prime','l_prime'])st[k]=0x5a;
    expected=JSON.parse(JSON.stringify(st));m.z.setState(st);
   } else if(st.pc===0x7000){returned=st;m.exited=true;m.exitCode=0;}
  };
  const r=runImage(Z80,m,{entry:label(p.list,name),stack,budget:1000000});assert.equal(r.exitCode,0);assert.deepEqual(m.violations,[]);
  for(const k of ['b','c','d','e','h','l','ix','iy','a_prime','b_prime','c_prime','d_prime','e_prime','h_prime','l_prime','flags_prime','iff1','iff2'])assert.deepEqual(returned[k],expected[k],name+' '+k);
  assert.equal(returned.sp,stack+2);cycles+=r.cycles;
 }
 if(split){invoke('UG_CRC32_INIT',0,0);const cut=Math.min(13,data.length);invoke('UG_CRC32_FOLD',0,cut);invoke('UG_CRC32_FOLD',cut,data.length-cut);invoke('UG_CRC32_END',0,0);}
 else invoke('UG_CRC32',0,data.length);
 assert.equal(Buffer.from(m.mem).readUInt32LE(0xbc06),crc32(data));return cycles;
}
assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
for(const n of [0,1,2,13,16,31,255,256,257,1023,1024])for(const split of [false,true])crcCall(mem,Buffer.from(Array.from({length:n},(_,i)=>(i*73+(i>>>3)*19)&255)),split);
results.push({name:'compiled CRC table 1024 bytes, vectors, streaming and register ABI',ok:true});
for(const name of ['UGLOAD','UGDUMP','UGPLAY']) {
 const bytes=readFileSync(join(dir,name+'.EXE')),p={name,bytes,header:parseExe(bytes),list:readFileSync(join(dir,name.toLowerCase()+'.lst'),'utf8')};
 const table=label(p.list,'UG_CRC32_TABLE'),data=bytes.subarray(table-p.header.loadAddr,table-p.header.loadAddr+1024);
 assert.equal(table&255,0);assert.deepEqual(data,tableBytes);
 for(const n of [0,1,13,255,256,257,1023,1024])for(const split of [false,true])crcCall(p,Buffer.from(Array.from({length:n},(_,i)=>(i*73+(i>>>3)*19)&255)),split);
 results.push({name:name+' compiled fast CRC vectors/streaming/register ABI',ok:true,sha256:sha256(bytes),crcCycles1024:crcCall(p,Buffer.alloc(1024,0x5a))});
}

// Complete file operations against the same card/file model. Assemble an
// otherwise identical bitwise-CRC reference, so the measured difference is
// actual Z80 work rather than a C mock or a disabled verification path.
for(const name of ['UGLOAD','UGDUMP']) {
 const src=join(out,name+'-bitwise.asm'),ref=join(out,name+'-bitwise.EXE');
 writeFileSync(src,`; SPDX-License-Identifier: GPL-2.0-or-later\n    DEFINE UG_CRC_BITWISE\n    INCLUDE "${name.toLowerCase()}.asm"\n`);
 execFileSync(process.env.SJASMPLUS||'sjasmplus',[...['host/sprinter/ultrags/apps','host/sprinter/ultrags/include','host/sprinter/ultrags/lib'].map(p=>'--inc='+join(root,p)),
  '--inc='+join(build,'ultrags/gen'),'--raw='+ref,src],{stdio:'pipe'});
 const input=Buffer.from(Array.from({length:65537},(_,i)=>(i*73+(i>>>8)*19)&255));
 function fileRun(bytes,cli,card,files) {
  const h=parseExe(bytes),m=new SprinterMachine({card,commandLine:cli,movingClock:true,files,logLimit:0});
  let payload=0;const windows=[],wr=m.memWrite,rd=m.memRead,io=m.ioWrite;
  m.memWrite=(a,v)=>{if(m.isaOpen&&m.isaAddr(a)===card.base)payload++;return wr(a,v);};
  m.memRead=a=>{if(m.isaOpen&&m.isaAddr(a)===card.base)payload++;return rd(a);};
  m.ioWrite=(p,v)=>{if(p===PORT_SYSTEM&&v===1&&m.isaOpen&&payload){windows.push(payload);payload=0;}return io(p,v);};
  m.mem.set(bytes,h.loadAddr);const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:1,budget:1500000000});
  assert.equal(r.exitCode,0,m.text);assert.deepEqual(m.violations,[]);assert(m.maxDiUs<10000&&m.maxWindowUs<10000);
  assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(r.end.iff1,1);assert.equal(m.fileHandles.size,0);
  assert(windows.every(n=>n<=256));
  return {m,steps:r.steps,cycles:r.cycles,simulatedSeconds:m.elapsedTicks/21000000,dataWindows:windows.length,maxPayloadWindow:Math.max(...windows)};
 }
 for(const verify of [false,true]) {
  const rows=[];
  for(const [profile,bytes] of [['bitwise-reference',readFileSync(ref)],['table',readFileSync(join(dir,name+'.EXE'))]]) {
   const card=new SlowCard(catalog);let run;
   if(name==='UGLOAD') {
    run=fileRun(bytes,'DATA.BIN /TYPE:BLOB'+(verify?' /VERIFY':''),card,{'DATA.BIN':input});
    assert.equal(card.objects.size,1);assert.deepEqual(card.objects.get(1).data,input);
   } else {
    fileRun(readFileSync(join(dir,'UGLOAD.EXE')),'DATA.BIN /TYPE:BLOB',card,{'DATA.BIN':input});
    run=fileRun(bytes,'1 BACK.BIN'+(verify?' /VERIFY':''),card,{});
    assert.deepEqual(run.m.files.get('BACK.BIN'),input);
   }
   rows.push({profile,sha256:sha256(bytes),steps:run.steps,cycles:run.cycles,simulatedSeconds:run.simulatedSeconds});
  }
  assert(rows[1].cycles<=rows[0].cycles);
  if(verify)assert(rows[1].cycles<rows[0].cycles*.9,'file CRC optimization has no measurable benefit');
  results.push({name:name+' full 65537-byte '+(verify?'VERIFIED':'FAST')+' file comparison',ok:true,bytes:input.length,verify,profiles:rows,
   instructionCycleRatio:rows[0].cycles/rows[1].cycles,limits:'zero-wait card/disk model; physical bytes/second pending'});
 }
 // Isolate payload grouping: same table CRC, position fix and Turbo policy.
 const smallSrc=join(out,name+'-cap8.asm'),smallExe=join(out,name+'-cap8.EXE');
 writeFileSync(smallSrc,`; SPDX-License-Identifier: GPL-2.0-or-later\n    DEFINE UG_FILE_WINDOW 8\n    INCLUDE "${name.toLowerCase()}.asm"\n`);
 execFileSync(process.env.SJASMPLUS||'sjasmplus',[...['host/sprinter/ultrags/apps','host/sprinter/ultrags/include','host/sprinter/ultrags/lib'].map(p=>'--inc='+join(root,p)),
  '--inc='+join(build,'ultrags/gen'),'--raw='+smallExe,smallSrc],{stdio:'pipe'});
 for(const verify of [false,true]) {
  const rows=[];
  for(const [window,bytes] of [[8,readFileSync(smallExe)],[256,readFileSync(join(dir,name+'.EXE'))]]) {
   const card=new SlowCard(catalog);let run;
   if(name==='UGLOAD') {
    run=fileRun(bytes,'DATA.BIN /TYPE:BLOB'+(verify?' /VERIFY':''),card,{'DATA.BIN':input});
    assert.deepEqual(card.objects.get(1).data,input);
   } else {
    fileRun(readFileSync(join(dir,'UGLOAD.EXE')),'DATA.BIN /TYPE:BLOB',card,{'DATA.BIN':input});
    run=fileRun(bytes,'1 BACK.BIN'+(verify?' /VERIFY':''),card,{});assert.deepEqual(run.m.files.get('BACK.BIN'),input);
   }
   rows.push({window,sha256:sha256(bytes),cycles:run.cycles,simulatedSeconds:run.simulatedSeconds,
    dataWindows:run.dataWindows,maxPayloadWindow:run.maxPayloadWindow,maxDiUs:run.m.maxDiUs,maxWindowUs:run.m.maxWindowUs});
  }
  assert(rows[0].dataWindows>rows[1].dataWindows*30);assert.equal(rows[1].maxPayloadWindow,256);
  assert(rows[1].simulatedSeconds<rows[0].simulatedSeconds*.75,'file window improvement below 1.33x '+JSON.stringify({name,verify,rows}));
  console.log('PASS file payload windows '+JSON.stringify({name,verify,rows}));
  results.push({name:name+' cap8 versus cap256 '+(verify?'VERIFIED':'FAST'),ok:true,bytes:input.length,verify,profiles:rows,
   simulatedRatio:rows[0].simulatedSeconds/rows[1].simulatedSeconds,limits:'zero-wait peripheral model; physical rate pending'});
 }
}

// The opt-in policy must never permit Turbo reads or config/request writes.
{
 const c=new SlowCard(catalog),m=new SprinterMachine({card:c,allowTurboBulkWrites:true});
 c.transfer={granted:true,bulk:true,rd:false};m.system=0x11;m.page3=0xd4;
 assert.throws(()=>m.memRead(0xc000+c.base),/Turbo/);
 assert.throws(()=>m.memWrite(0xc003+c.base,0),/Turbo/);
 const strict=new SprinterMachine({card:c});strict.system=0x11;strict.page3=0xd4;
 assert.throws(()=>strict.ioWrite(0x3c,3),/ISA mapped/);
 results.push({name:'default Turbo guard and opt-in write-only address/grant policy',ok:true});
}
for(const p of profiles) {
 for(const n of [1,7,8,9,63,64,65,255,256,257,1023,1024,1025])run(p,n,{verify:true});
 for(const slot of [0,1])for(const iff of [0,1])for(const hardware of [false,true])run(p,1031,{slot,iff,hardware});
 run(p,1024,{cancel:1,code:10,name:p.name+' write ESC after progress'});
 run(p,1024,{cancel:1,cancelRead:true,code:10,name:p.name+' read ESC after progress'});
 run(p,16,{verify:true,badReadCrc:true,code:9,name:p.name+' corrupt CRC rejected'});
 run(p,1024,{noReplyOp:33,code:8,name:p.name+' lost END not replayed'});
 run(p,65536,{name:p.name+' 64KiB FAST comparison'});
 run(p,65536,{verify:true,name:p.name+' 64KiB VERIFIED comparison'});
}
for(const chunk of [1,3,5,8])run(profiles[0],1031,{chunk,verify:true,name:'release arbitrary chunk '+chunk});
const baselineDir=join(root,'build/throughput-baseline');
if(existsSync(join(baselineDir,'UGMEM.EXE')) && existsSync(join(baselineDir,'ugmem.lst'))) {
const old={name:'PREVIOUS8',window:8,turbo:false,dir:baselineDir};
old.bytes=readFileSync(join(baselineDir,'UGMEM.EXE'));old.header=parseExe(old.bytes);old.list=readFileSync(join(baselineDir,'ugmem.lst'),'utf8');
assert.equal(sha256(old.bytes),'db9840b8a005ea5599feaffb00b6b69490753fe9978f09df9153ff225cade72a');
// The previous EXE intentionally polls after every 8 bytes; measure without
// applying the new per-region polling assertions to that archived binary.
run(old,65536,{name:'previous 64KiB FAST comparison',legacyPolls:true});
run(old,65536,{verify:true,name:'previous 64KiB VERIFIED comparison',legacyPolls:true});
const oldCrc=crcCall(old,Buffer.alloc(1024,0x5a)),newCrc=crcCall(mem,Buffer.alloc(1024,0x5a));
assert(newCrc*2<oldCrc);
results.push({name:'CRC helper instruction cycles improve by at least 2x',ok:true,oldCrc,newCrc,ratio:oldCrc/newCrc});
}
assert.deepEqual(executionInputs(root),inputs);verifyBuild(root,dir);
const report={status:'HOST_THROUGHPUT_PASS / REAL_PENDING',inputs,buildInputs:assembly.inputs,scriptSha256:sha256(readFileSync(new URL(import.meta.url))),
 executed,results,limitations:['Zero-wait ISA/card model, not electrical service margins','64/256 UGMEM variants and Turbo writes require physical functional/timing checks','File apps use cap256; UGMEM/public library and control frames retain cap8; all release ISA accesses keep Turbo off']};
writeFileSync(join(out,'throughput.json'),JSON.stringify(report,null,2)+'\n');
console.log('Throughput actual-EXE checks: '+results.length+' PASS; experimental profiles REAL_PENDING');
