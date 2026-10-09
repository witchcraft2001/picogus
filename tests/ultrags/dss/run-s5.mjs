// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {SlowCard} from './slow-card.mjs';
import {crc32} from './config-card.mjs';
import {verifyBuild,executionInputs} from '../../../tools/ultrags/build-evidence.mjs';
const root=resolve(process.argv[2]||'.'),build=resolve(process.argv[3]||'build'),Z80=loadZ80(root);
const inputSnapshot=executionInputs(root);
const assembly=verifyBuild(root,join(build,'ultrags/dss'));
const catalog=readFileSync(process.env.UG_S2_CATALOG||join(build,'host/s2-catalog.bin'));
const results=[],executed=new Map();
const reference=JSON.parse(readFileSync(join(build,'host/s5-commands.json'))),model=new SlowCard(catalog);
for(const f of reference) {
 if(f.data) {
  const bytes=Buffer.from(f.bytes,'hex');
  for(const b of bytes)if(f.data==='write')model.writePort(model.base,b);else if(model.readPort(model.base)!==b)throw Error('C/model data mismatch');
 } else {
  const [status,r]=model.command(f.op,Buffer.from(f.q,'hex'));
  if(status!==f.status||!r.equals(Buffer.from(f.r,'hex')))throw Error('S5 C/model mismatch op '+f.op);
  if([32,34].includes(f.op)&&!status) {model.transfer.granted=true;model.transfer.last=model.now;}
 }
}
console.log('PASS S5 shared actual C/model fixtures: '+reference.length);
const fullOnly=!!process.env.UG_S5_FULL;
function test(name,app,cli,expected=0,opts={}) {
 if(fullOnly && name!=='8MiB actual EXE')return {card:opts.card??new SlowCard(catalog,opts)};
 const bytes=readFileSync(join(build,'ultrags/dss',app+'.EXE')),h=parseExe(bytes);
 executed.set(app,{name:app+'.EXE',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 const card=opts.card??new SlowCard(catalog,opts),m=new SprinterMachine({card,cardSlot:opts.slot??0,cpuHz:opts.cpuHz??21000000,commandLine:cli,movingClock:!opts.stopped,clockStart:opts.clockStart??86390,escAfter:opts.escAfter??Infinity,logLimit:1000,files:opts.files??{},disk:opts.disk??{}});
 const frames=[],statusReads={x:0,gs:0};let request=[],active;
 const rawRead=card.readPort.bind(card),rawWrite=card.writePort.bind(card);
 if(opts.compact) {
  // Record actual bus bytes from the EXE, separately from oracle command()
  // arguments. Status polls are counted outside compact wire overhead.
  card.writePort=(p,v)=>{
   if(p-card.base===2&&v===0xa0){request=[];active=null;}
   if(p-card.base===3){request.push(v);if(request.length>=2&&request.length===2+request[1]+(request[0]&128?4:0)){active={request:Buffer.from(request),response:[],complete:false};frames.push(active);request=[];}}
   return rawWrite(p,v);
  };
  card.readPort=p=>{
   const off=p-card.base,available=card.response.length,v=rawRead(p);
   if(off===1)statusReads.x++;if(off===0x1b)statusReads.gs++;
   if(off===3&&available&&active){active.response.push(v);if(!card.response.length)active.complete=true;}
   return v;
  };
 }
 const listing=readFileSync(join(build,'ultrags/dss',app.toLowerCase()+'.lst'),'utf8');
 for(const line of listing.split('\n'))if(/UG_CRC32(?:_FOLD)?:\s*$/.test(line)) {
   const match=line.match(/\+*([0-9A-F]{4})\s+UG_CRC32/);if(match)m.crcEntries.add(parseInt(match[1],16));
 }
 const labels={};
 for(const line of listing.split('\n')) {
   const match=line.match(/\+*([0-9A-F]{4})\s+(UG_WRITE|UG_READ):\s*$/);
   if(match)labels[match[2]]=parseInt(match[1],16);
 }
 m.beforeStep=st=>{
   if(opts.profileMethod!==undefined&&(st.pc===labels.UG_WRITE||st.pc===labels.UG_READ)) {
     m.mem[0xbc2e]=st.pc===labels.UG_READ&&opts.profileMethod===2?0:opts.profileMethod;
     m.mem[0xbc2d]=1;
     const chunk=opts.profileChunk??(cpuHzProfile(opts)===21000000?32:8);
     m.mem[0xbc16]=chunk&255;m.mem[0xbc17]=chunk>>>8;
   }
 };
 const dss=m.dssCall.bind(m);m.dssCall=st=>{if(st.c===0x31&&opts.escInGrant&&card.transfer?.granted)m.escAfter=0;const fn=st.c,v=dss(st);if(v!=='exit'){if(fn!==0x15)st.ix=0xdead;st.iy=0xbeef;}return v;};
 m.mem.set(bytes,h.loadAddr);
 const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:opts.iff??1,budget:opts.budget??100000000});
 card.readPort=rawRead;card.writePort=rawWrite;
 const errors=[...m.violations];
 const compact=[];
 if(opts.compact) {
  const blocks=frames.filter(f=>[32,33,34,35].includes(f.request[0]&127));
  if(blocks.length%2)errors.push('unpaired compact frame');
  for(let i=0;i+1<blocks.length;i+=2) {
   const begin=blocks[i],end=blocks[i+1],rd=(begin.request[0]&127)===34,verify=!!(begin.request[10]&128),checked=!!(begin.request[0]&128);
   const bytes=begin.request.length+begin.response.length+end.request.length+end.response.length;
   if(!begin.complete||!end.complete||begin.response[0]||end.response[0]||(end.request[0]&127)!==(rd?35:33)||bytes!==25+(verify?(rd?8:4):0)+(checked?16:0))errors.push('compact wire overhead');
   compact.push({direction:rd?'read':'write',length:begin.request.readUInt16LE(8),wireBytes:bytes,begin:begin.request.toString('hex'),beginReply:Buffer.from(begin.response).toString('hex'),end:end.request.toString('hex'),endReply:Buffer.from(end.response).toString('hex')});
  }
 }
 if(m.system!==m.systemInit||m.page3!==m.page3Init||!!run.end.iff1!==!!(opts.iff??1)||run.end.sp!==h.stack-2)errors.push('context');
 if(opts.check&&!opts.check(card,m))errors.push('postcondition');
 if(m.fileHandles.size)errors.push('open files');
 if(expected===0 && !/VERIFY|PROTO|CHECK:CRC|CHECK:BOTH/i.test(cli) && !(opts.bench && !/CHECK:NONE/i.test(cli)) && m.crcCalls)errors.push('host CRC in FAST');
 const result=opts.selftest?m.mem[0xba00]===0x55&&m.mem[0xba01]===0xaa&&!m.mem[0xba03]:m.text.includes(`RESULT ${expected?'FAIL':'PASS'} code=${expected}`);
 const ok=run.exitCode===expected&&!errors.length&&result;
 console.log(`${ok?'PASS':'FAIL'} S5 ${name} exit=${run.exitCode}`+(ok?'':JSON.stringify({text:m.text,errors,trace:m.trace,ops:card.trace?.slice(-8)})));
 results.push({name,ok,exit:run.exitCode,expected,text:m.text,errors,steps:run.steps,hostCrcCalls:m.crcCalls,maxWindowUs:m.maxWindowUs,...(opts.compact?{compact,statusReads}:{})});
 if(!ok)throw Error(name);
 return {card,m};
}
const cpuHzProfile=o=>o.cpuHz??21000000;
const pattern=n=>Buffer.from(Array.from({length:n},(_,i)=>i^(i>>>8)^(i>>>16)^0xa5));
// Known CPU/NMI/chunk profiles below are injected by the HOST harness only.
// Release utilities keep the unknown profile conservative (chunk8, NMI unknown).
for(const slot of [0,1])for(const cpuHz of [21000000,3500000])for(const iff of [0,1]) {
 for(const method of [0,1,2])for(const n of [1,2,31,32,33,255,256,257,1023,1024]) {
  for(const verify of [false,true])test(`matrix-${slot}-${cpuHz}-${iff}-${method}-${n}-${verify}`,'UGMEM',`ROUNDTRIP ${n}${verify?' /VERIFY':''} /SLOT:${slot}`,0,{slot,cpuHz,iff,profileMethod:method,alias:0x280,compact:true,check:c=>!c.objects.size});
 }
 test(`bench-${slot}-${cpuHz}-${iff}`,'UGBENCH',`/BYTES:257 /LOOPS:1 /BLOCK:256 /SLOT:${slot}`,0,{slot,cpuHz,iff,alias:0x280,bench:true,check:(c,m)=>!c.objects.size&&m.text.includes('ALIAS direction=READ')&&m.text.includes('STACK SKIP UNSAFE_NMI')});
}
for(const block of [32,256,512,1024])test(`bench-block-${block}`,'UGBENCH',`/BYTES:1025 /LOOPS:2 /BLOCK:${block} /METHOD:ALL`,0,{bench:true,alias:0x280,check:c=>!c.objects.size});
test('bench default','UGBENCH','',0,{bench:true,budget:2000000000,check:(c,m)=>!c.objects.size&&m.text.includes('ALIAS SKIP NOT_CONFIGURED')});
test('bench FAST no host CRC','UGBENCH','/BYTES:65537 /LOOPS:1 /METHOD:FIXED /CHECK:NONE',0,{bench:true,budget:200000000,check:c=>!c.objects.size});
test('explicit ALIAS off','UGBENCH','/METHOD:ALIAS /BYTES:1',3,{bench:true,check:(c,m)=>!c.objects.size&&m.text.includes('reason=STATE')});
test('explicit STACK unknown refuses before bus','UGBENCH','/METHOD:STACK /BYTES:1',3,{bench:true,check:(c,m)=>!c.objects.size&&m.trace.every(t=>t.kind!=='memR'&&t.kind!=='memW')});
for(const cli of ['/BYTES:0','/BYTES:4294967296','/LOOPS:0','/LOOPS:65536','/BLOCK:0','/BLOCK:1025','/METHOD:X','/DIRECTION:X','/CHECK:X','/SOAK:-1','/VERIFY','/TYPE:BLOB'])test('syntax '+cli,'UGBENCH',cli,cli==='/BYTES:0'?4:1,{bench:true});
test('soak midnight','UGBENCH','/BYTES:1 /LOOPS:1 /METHOD:FIXED /CHECK:NONE /SOAK:2',0,{bench:true,clockStart:86399,budget:200000000,check:c=>!c.objects.size});
test('soak stopped clock','UGBENCH','/BYTES:1 /LOOPS:1 /METHOD:FIXED /CHECK:NONE /SOAK:2',8,{bench:true,stopped:true,budget:300000000,check:c=>!c.objects.size});
test('benchmark ESC cleanup','UGBENCH','/BYTES:65536 /LOOPS:1 /METHOD:FIXED',10,{bench:true,escInGrant:true,check:c=>!c.objects.size});
for(const chunk of [8,32,256,512])test(`harness-only-chunk-${chunk}`,'UGMEM','ROUNDTRIP 1024',0,{profileMethod:0,profileChunk:chunk,compact:true,check:c=>!c.objects.size});
if(process.env.UG_S5_FULL) test('8MiB actual EXE','UGMEM','ROUNDTRIP 8388608',0,{budget:10000000000,compact:false,check:c=>!c.objects.size});
mkdirSync(join(build,'ultrags/logs'),{recursive:true});
if(JSON.stringify(inputSnapshot)!==JSON.stringify(executionInputs(root)))throw Error('S5 execution sources changed during run');
verifyBuild(root,join(build,'ultrags/dss'));
writeFileSync(join(build,fullOnly?'ultrags/logs/s5-full.json':'ultrags/logs/s5-run.json'),JSON.stringify({results,executed:[...executed.values()],inputs:inputSnapshot,buildInputs:assembly.inputs},null,2)+'\n');
