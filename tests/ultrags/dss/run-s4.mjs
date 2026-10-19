// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {SlowCard} from './slow-card.mjs';
import {crc32} from './config-card.mjs';
import {verifyBuild,executionInputs,dssExeName} from '../../../tools/ultrags/build-evidence.mjs';
const root=resolve(process.argv[2]||'.'),build=resolve(process.argv[3]||'build'),Z80=loadZ80(root);
const inputSnapshot=executionInputs(root);
const assembly=verifyBuild(root,join(build,'ultrags/dss'));
const catalog=readFileSync(process.env.UG_S2_CATALOG||join(build,'host/s2-catalog.bin'));
const results=[],executed=new Map();
const reference=JSON.parse(readFileSync(join(build,'host/s4-commands.json'))),model=new SlowCard(catalog);
for(const f of reference) {
 if(f.data) {
  const bytes=Buffer.from(f.bytes,'hex');
  for(const b of bytes)if(f.data==='write')model.writePort(model.base+0x13,b);else if(model.readPort(model.base+0x13)!==b)throw Error('C/model data mismatch');
 } else {
  const [status,r]=model.command(f.op,Buffer.from(f.q,'hex'));
  if(status!==f.status||!r.equals(Buffer.from(f.r,'hex')))throw Error('S4 C/model mismatch op '+f.op);
  if([32,34].includes(f.op)&&!status) {model.transfer.granted=true;model.transfer.last=model.now;}
 }
}
console.log('PASS S4 shared actual C/model fixtures: '+reference.length);
const fullOnly=!!process.env.UG_S4_FULL;
function test(name,app,cli,expected=0,opts={}) {
 if(fullOnly && name!=='8MiB actual EXE')return {card:opts.card??new SlowCard(catalog,opts)};
 const exeName=dssExeName(app),bytes=readFileSync(join(build,'ultrags/dss',exeName)),h=parseExe(bytes);
 executed.set(app,{name:exeName,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 const card=opts.card??new SlowCard(catalog,opts),m=new SprinterMachine({card,cardSlot:opts.slot??0,cpuHz:opts.cpuHz??21000000,turboHardware:opts.cpuHz!==3500000,commandLine:cli,movingClock:!opts.stopped,clockStart:opts.clockStart??86390,escAfter:opts.escAfter??Infinity,logLimit:1000,files:opts.files??{},disk:opts.disk??{}});
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
 const dss=m.dssCall.bind(m);m.dssCall=st=>{if(st.c===0x31&&card.transfer?.granted&&(opts.escInGrant||card.transfer.done>=opts.escProgress))m.escAfter=0;const fn=st.c,v=dss(st);opts.onDss?.(fn,st,m,v);if(v!=='exit'){if(fn!==0x15)st.ix=0xdead;st.iy=0xbeef;}return v;};
 m.mem.set(bytes,h.loadAddr);
 const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:opts.iff??1,budget:opts.budget??100000000});
 card.readPort=rawRead;card.writePort=rawWrite;
 const errors=[...m.violations];
 if(m.maxDiUs>=10000 || m.maxWindowUs>=10000)errors.push("ISA/DI budget >=10ms");
 if(m.turboWrites && !m.turbo)errors.push("DSS Turbo not enabled");
 if((cli.trim()==="/?" || expected===1) && m.turboWrites)errors.push("Turbo touched before argument validation");
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
 if(expected===0 && !/VERIFY|PROTO/i.test(cli) && m.crcCalls)errors.push('host CRC in FAST');
 const result=opts.selftest?m.mem[0xba00]===0x55&&m.mem[0xba01]===0xaa&&!m.mem[0xba03]:m.text.includes(`RESULT ${expected?'FAIL':'PASS'} code=${expected}`);
 const ok=run.exitCode===expected&&!errors.length&&result;
 console.log(`${ok?'PASS':'FAIL'} S4 ${name} exit=${run.exitCode}`+(ok?'':JSON.stringify({text:m.text,errors,trace:m.trace,ops:card.trace?.slice(-8)})));
 results.push({name,ok,exit:run.exitCode,expected,text:m.text,errors,steps:run.steps,hostCrcCalls:m.crcCalls,maxWindowUs:m.maxWindowUs,maxDiUs:m.maxDiUs,...(opts.compact?{compact,statusReads}:{})});
 if(!ok)throw Error(name);
 return {card,m};
}
const pattern=n=>Buffer.from(Array.from({length:n},(_,i)=>i^(i>>>8)^(i>>>16)^0xa5));
for(const slot of [0,1])for(const n of [1,7,8,9,63,64,65,255,256,257,1023,1024,1025]) {
 const data=pattern(n),o={slot,cpuHz:3500000,iff:n&1,files:{'TAIL.BIN':data}};
 const {card}=test(`file cap256 load tail ${n} slot${slot}`,'UGLOAD',`TAIL.BIN /TYPE:BLOB /VERIFY /SLOT:${slot}`,0,{
  ...o,check:c=>c.objects.get(1)?.data.equals(data)
 });
 test(`file cap256 dump tail ${n} slot${slot}`,'UGDUMP',`1 TAIL.BIN /VERIFY /SLOT:${slot}`,0,{
  ...o,files:{},card,disk:{writeReturnDE:0},check:(c,m)=>m.files.get('TAIL.BIN')?.equals(data)
 });
}
test('non-DSS sticky error delayed reply','ST-RESPBUF','',0,{selftest:true,stickyError:1,simpleDelayUs:1000,check:c=>!c.objects.size});
for(const slot of [0,1])for(const cpuHz of [21000000,3500000])for(const iff of [0,1]) {
 test(`proto-${slot}-${cpuHz}-${iff}`,'UGTEST',`PROTO /SLOT:${slot}`,0,{slot,cpuHz,iff,check:c=>!c.objects.size});
 const o={slot,cpuHz,iff,compact:true},suffix=` /slot:${slot}`;
 for(const verify of [false,true]) {
  const flags=verify?' /VERIFY':'';
  test(`roundtrip-${slot}-${cpuHz}-${iff}-${verify}`,'UGMEM','ROUNDTRIP 1025 /SLOW'+flags+suffix,0,{...o,check:c=>!c.objects.size});
  const input=pattern(2049);
  const {card}=test(`load-${slot}-${cpuHz}-${iff}-${verify}`,'UGLOAD','TEST.BIN /TYPE:BLOB'+flags+suffix,0,{...o,files:{'TEST.BIN':input},check:c=>c.objects.get(1)?.data.equals(input)&&c.objects.get(1)?.state===1});
  test(`dump-${slot}-${cpuHz}-${iff}-${verify}`,'UGDUMP','1 BACK.BIN'+flags+suffix,0,{...o,card,check:(c,m)=>m.files.get('BACK.BIN')?.equals(input)&&m.text.includes(verify?'host_crc=0x'+crc32(input).toString(16).padStart(8,'0').toUpperCase():'host_crc=NOT_COMPUTED')});
 }
}
test('65536 FAST','UGMEM','ROUNDTRIP 65536 /SLOW',0,{budget:500000000,check:c=>!c.objects.size});
for(const slot of [0,1]) {
 test(`roundtrip progress tail midnight slot${slot}`,'UGMEM',`ROUNDTRIP 65537 /VERIFY /SLOT:${slot}`,0,{
  slot,cpuHz:3500000,clockStart:86399,budget:150000000,check:(c,m)=>{
   const lines=m.text.split('\r\n').filter(s=>s.startsWith('roundtrip '));
   const expected=['WRITE completed=0','WRITE completed=65536','WRITE completed=65537',
    'SEAL completed=65537','READ completed=0','READ completed=65536','READ completed=65537'];
   const times=lines.map(s=>Number(s.match(/elapsed_s=(\d+)$/)?.[1]));
   return !c.objects.size&&lines.length===expected.length&&expected.every((s,i)=>lines[i].startsWith('roundtrip '+s+'/65537 elapsed_s='))
    &&times.every((t,i)=>Number.isFinite(t)&&t>=0&&(!i||t>=times[i-1]))&&times.at(-1)>0;
  }
 });
}
test('roundtrip quiet suppresses progress','UGMEM','ROUNDTRIP 1025 /VERIFY /QUIET',0,{
 check:(c,m)=>!c.objects.size&&!m.text.includes('roundtrip ')&&!m.text.includes('session=')&&m.text==='RESULT PASS code=0\r\n'
});
const input=pattern(70001),crc=crc32(input).toString(16).padStart(8,'0');
const {card}=test('file >64K short read 120s disk pauses manifest FAST','UGLOAD',`TEST.BIN /TYPE:BLOB /CRC:${crc}`,0,{files:{'TEST.BIN':input},disk:{shortRead:509,delayUs:120000000},budget:600000000,check:c=>c.objects.get(1)?.data.equals(input)&&!c.resets});
test('range dump short writes','UGDUMP','1 BACK.BIN /OFFSET:65535 /LENGTH:4096',0,{card,disk:{shortWrite:13,delayUs:120000000},check:(c,m)=>m.files.get('BACK.BIN')?.equals(input.subarray(65535,65535+4096))});
test('verified range CRC short writes','UGDUMP','1 BACK.BIN /OFFSET:65535 /LENGTH:257 /VERIFY',0,{card,disk:{shortWrite:13},check:(c,m)=>m.files.get('BACK.BIN')?.equals(input.subarray(65535,65792))&&m.text.includes('host_crc=0x'+crc32(input.subarray(65535,65792)).toString(16).padStart(8,'0').toUpperCase())});
for(const slot of [0,1])for(const iff of [0,1])for(const writeReturnDE of [0,0xffff]) {
 test(`DSS FAT flush DE=${writeReturnDE} slot${slot} iff${iff}`,'UGDUMP',`1 BACK.BIN /VERIFY /SLOT:${slot}`,0,{
  card,slot,iff,budget:600000000,disk:{writeReturnDE},
  check:(c,m)=>m.files.get('BACK.BIN')?.equals(input)&&m.text.includes('host_crc=0x'+crc.toUpperCase())
 });
}
test('short write with clobbered DE and 64KiB position crossing','UGDUMP','1 BACK.BIN /VERIFY',0,{
 card,budget:600000000,disk:{shortWrite:509,writeReturnDE:0xdead},
 check:(c,m)=>m.files.get('BACK.BIN')?.equals(input)&&m.text.includes('host_crc=0x'+crc.toUpperCase())
});
test('empty verified dump CRC','UGDUMP','1 EMPTY.BIN /LENGTH:0 /VERIFY',0,{card,check:(c,m)=>m.files.get('EMPTY.BIN')?.length===0&&m.text.includes('host_crc=0x00000000')});
for(const cli of ['ROUNDTRIP 4294967296','ROUNDTRIP 0x100000000','ROUNDTRIP -1','ROUNDTRIP X','ROUNDTRIP 0'])test('bad '+cli,'UGMEM',cli,cli.endsWith(' 0')?4:1);
test('bad READ_BEGIN CRC field','UGMEM','ROUNDTRIP 32 /VERIFY',9,{badReadCrc:true,check:c=>!c.objects.size});
const exhausted=new SlowCard(catalog,{nextToken:0xffffffff}),foreign=Buffer.alloc(16,0x5a),reserve=Buffer.alloc(5);reserve.writeUInt32LE(16,1);exhausted.command(16,reserve);
Object.assign(exhausted.objects.get(1),{data:foreign,uploaded:16,state:1});
test('u32 token exhaustion keeps foreign object','UGMEM','ROUNDTRIP 1025',3,{card:exhausted,check:c=>c.objects.size===1&&c.objects.get(1)?.data.equals(foreign)&&c.nextToken===0});
test('manifest mismatch','UGLOAD','TEST.BIN /TYPE:BLOB /CRC:00000000',9,{files:{'TEST.BIN':pattern(64)},check:c=>!c.objects.size});
test('verify manifest','UGLOAD',`TEST.BIN /TYPE:BLOB /VERIFY /CRC:${crc}`,0,{files:{'TEST.BIN':input},budget:600000000});
test('read error cleanup','UGLOAD','TEST.BIN /TYPE:BLOB',5,{files:{'TEST.BIN':pattern(1025)},disk:{failAt:5},check:c=>!c.objects.size});
test('seek error closes input','UGLOAD','TEST.BIN /TYPE:BLOB',5,{files:{'TEST.BIN':pattern(32)},disk:{failFn:0x15},check:c=>!c.objects.size});
test('zero-length disk read cleanup','UGLOAD','TEST.BIN /TYPE:BLOB',5,{files:{'TEST.BIN':pattern(32)},disk:{shortRead:0},check:c=>!c.objects.size});
test('create error preserves object','UGDUMP','1 FAIL.BIN',5,{card,disk:{failFn:0x0a},check:(c,m)=>!m.files.has('FAIL.BIN')&&c.objects.get(1)?.data.equals(input)});
test('write error incomplete output','UGDUMP','1 FAIL.BIN',5,{card,disk:{failFn:0x14},check:(c,m)=>m.text.includes('INCOMPLETE')&&c.objects.get(1)?.data.equals(input)});
test('zero-length disk write incomplete','UGDUMP','1 FAIL.BIN',5,{card,disk:{shortWrite:0},check:(c,m)=>m.text.includes('INCOMPLETE')&&c.objects.get(1)?.data.equals(input)});
test('delete error preserves existing file','UGDUMP','1 BACK.BIN /OVERWRITE',5,{card,files:{'BACK.BIN':Buffer.from('keep')},disk:{failFn:0x0e},check:(c,m)=>m.files.get('BACK.BIN').toString()==='keep'});
test('input close error retries and releases own object','UGLOAD','TEST.BIN /TYPE:BLOB',5,{files:{'TEST.BIN':pattern(32)},disk:{failAt:5},check:c=>!c.objects.size});
test('output close error marks incomplete','UGDUMP','1 BACK.BIN /LENGTH:17',5,{card,disk:{failAt:6},check:(c,m)=>m.text.includes('INCOMPLETE')&&m.files.get('BACK.BIN')?.equals(input.subarray(0,17))});
for(const failAt of [3,5])test('write position query error '+failAt,'UGDUMP','1 BACK.BIN /LENGTH:17',5,{
 card,disk:{failAt},check:(c,m)=>m.text.includes('INCOMPLETE')&&m.text.includes('dss_fn=0x15 a=0x06')&&m.files.get('BACK.BIN')?.length===(failAt===3?0:17)
});
for(const delta of [-1,0,18]) {
 let writes=0;
 test('invalid write position delta '+delta,'UGDUMP','1 BACK.BIN /LENGTH:17',5,{
  card,onDss(fn,st,m){if(fn===0x14){writes++;for(const f of m.fileHandles.values())f.pos=delta;}},
  check:(c,m)=>writes===1&&m.text.includes('INCOMPLETE')&&m.files.get('BACK.BIN')?.equals(input.subarray(0,17))
 });
}
test('cap256 file upload ESC releases object','UGLOAD','TEST.BIN /TYPE:BLOB',10,{
 files:{'TEST.BIN':pattern(4097)},escProgress:256,check:c=>!c.objects.size&&!c.transfer
});
test('cap256 file dump ESC keeps partial output','UGDUMP','1 BACK.BIN',10,{
 card,escProgress:256,check:(c,m)=>m.text.includes('INCOMPLETE')&&!c.transfer&&m.files.get('BACK.BIN')?.length===0
});
test('existence probe close error preserves complete file','UGDUMP','1 BACK.BIN /OVERWRITE',5,{card,files:{'BACK.BIN':Buffer.from('keep')},disk:{failAt:2},check:(c,m)=>!m.text.includes('INCOMPLETE')&&m.files.get('BACK.BIN').toString()==='keep'});
test('ESC cleanup','UGMEM','ROUNDTRIP 65536',10,{escAfter:3,check:c=>!c.objects.size});
test('held ESC during grant with delayed cleanup replies','UGMEM','ROUNDTRIP 1025',10,{escInGrant:true,simpleDelayUs:1000,check:c=>!c.objects.size&&c.trace.some(t=>t.op===32)});
test('BEGIN deadline 2s','UGLOAD','TEST.BIN /TYPE:BLOB',8,{files:{'TEST.BIN':pattern(1)},noReplyOp:32,clockStart:86399,check:c=>!c.objects.size&&c.now>=1000000&&c.now<3000000});
test('SEAL deadline 30s','UGLOAD','TEST.BIN /TYPE:BLOB',8,{files:{'TEST.BIN':pattern(1)},noReplyOp:19,cpuHz:3500000,budget:120000000,check:c=>!c.objects.size&&c.now>=29000000&&c.now<32000000});
test('stopped clock BEGIN finite','UGLOAD','TEST.BIN /TYPE:BLOB',8,{files:{'TEST.BIN':pattern(1)},noReplyOp:32,stopped:true,budget:200000000,check:c=>!c.objects.size});
test('lost END ACK' ,'UGLOAD','TEST.BIN /TYPE:BLOB',8,{files:{'TEST.BIN':pattern(1024)},noReplyOp:33,check:(c,m)=>!c.objects.size&&m.text.includes('Transfer recovery')&&m.text.includes('transfer_stage=0x04 moved=1024/1024 offset=0x00000000')});
// Recovery RPCs overwrite UGREQ.OP and response scratch. Diagnostics must
// retain the actual failed phase and progress, for both directions.
for(const rd of [false,true]) {
 const begin=rd?34:32,end=rd?35:33,first=rd?5:1;
 for(const phase of ['begin','grant','data','end']) {
  const stalled=new SlowCard(catalog,{noReplyOp:phase==='begin'?begin:phase==='end'?end:undefined});
  const read=stalled.readPort.bind(stalled);
  stalled.readPort=p=>{
   const v=read(p),t=stalled.transfer,off=p-stalled.base;
   if(t?.granted&&t.rd===rd) {
    if(phase==='grant'&&off===1)return v&~(rd?16:8);
    if(phase==='data'&&off===0x1b&&t.done>=2)return rd?v&127:v|128;
   }
   return v;
  };
  const stage=first+['begin','grant','data','end'].indexOf(phase);
  const moved=phase==='end'?16:phase==='data'?(rd?2:1):0;
  test(`transfer diagnostics ${rd?'read':'write'} ${phase}`,'UGMEM','ROUNDTRIP 16 /SLOW',phase==='grant'?3:8,{
   card:stalled,check:(c,m)=>!c.objects.size&&m.text.includes(`transfer_stage=0x0${stage} moved=${moved}/16 offset=0x00000000`)
    &&m.text.includes('operation not retried')&&c.trace.filter(t=>t.op===(phase==='end'?end:begin)).length===1
  });
 }
 const wireError=new SlowCard(catalog),command=wireError.command.bind(wireError);
 wireError.command=(op,q,defer)=>{
  const result=command(op,q,defer);
  return op===end&&!result[0]?[7,Buffer.alloc(0)]:result;
 };
 test(`transfer diagnostics ${rd?'read':'write'} card HANDLE`,'UGMEM','ROUNDTRIP 16',4,{
  card:wireError,check:(c,m)=>!c.objects.size&&m.text.includes(`transfer_stage=0x0${rd?8:4} moved=16/16 offset=0x00000000`)
   &&m.text.includes('rpc_source=0x02 status=0x07 response_bytes=0x00')&&c.trace.filter(t=>t.op===end).length===1
 });
}
const failedRecovery=new SlowCard(catalog,{noReplyOp:33}),recoveryCommand=failedRecovery.command.bind(failedRecovery);
failedRecovery.command=(op,q,defer)=>op===0&&failedRecovery.trace.some(t=>t.op===33)?[5,Buffer.alloc(0)]:recoveryCommand(op,q,defer);
test('lost END ACK recovery INFO refused preserves timeout','UGLOAD','TEST.BIN /TYPE:BLOB',8,{card:failedRecovery,files:{'TEST.BIN':pattern(1024)},check:c=>c.objects.size===1&&c.objects.get(1)?.uploaded===1024});
test('unknown ALLOC result','UGLOAD','TEST.BIN /TYPE:BLOB',8,{files:{'TEST.BIN':pattern(1024)},noReplyOp:16,check:(c,m)=>c.objects.size===1&&m.text.includes('ALLOC_RESULT_UNKNOWN')});
test('partial output retained','UGDUMP','1 PART.BIN',5,{card,disk:{failAt:4},check:(c,m)=>m.text.includes('INCOMPLETE')&&m.files.has('PART.BIN')});
test('bad dump range','UGDUMP','1 BAD.BIN /OFFSET:70002',4,{card,check:(c,m)=>!m.files.has('BAD.BIN')});
test('missing file' ,'UGLOAD','NOFILE.BIN /TYPE:BLOB',5,{check:c=>!c.objects.size});
test('existing output','UGDUMP','1 BACK.BIN',5,{card,files:{'BACK.BIN':Buffer.from('keep')},check:(c,m)=>m.files.get('BACK.BIN').toString()==='keep'});
test('overwrite','UGDUMP','1 BACK.BIN /LENGTH:17 /OVERWRITE',0,{card,files:{'BACK.BIN':Buffer.alloc(100)},check:(c,m)=>m.files.get('BACK.BIN')?.equals(input.subarray(0,17))});
for(const cli of ['TEST.BIN','TEST.BIN /TYPE:UNKNOWN','TEST.BIN /TYPE:BLOB /CRC:123','TEST.BIN /TYPE:BLOB /CRC:123456789','TEST.BIN /TYPE:BLOB /SLOT:2'])test('syntax '+cli,'UGLOAD',cli,1);
for(const cli of ['65536 X.BIN','0x10000 X.BIN','1 X.BIN /OFFSET:4294967296','1 X.BIN /LENGTH:-1'])test('syntax '+cli,'UGDUMP',cli,1);
for(const [app,cli] of [['UGLOAD','TEST.BIN /TYPE:BLOB /OVERWRITE'],['UGLOAD','TEST.BIN /TYPE:BLOB /OFFSET:0'],['UGLOAD','TEST.BIN /TYPE:BLOB /LENGTH:1'],['UGDUMP','1 X.BIN /TYPE:BLOB'],['UGDUMP','1 X.BIN /CRC:00000000'],['UGMEM','ROUNDTRIP 32 /CRC:00000000'],['UGMEM','ROUNDTRIP 32 /TYPE:BLOB'],['UGMEM','ROUNDTRIP 32 /OFFSET:0'],['UGMEM','ROUNDTRIP 32 /OVERWRITE']])test('foreign option '+app+' '+cli,app,cli,1,{check:c=>!c.objects.size});
if(process.env.UG_S4_FULL) test('8MiB actual EXE','UGMEM','ROUNDTRIP 8388608 /SLOW',0,{budget:10000000000,check:c=>!c.objects.size});
mkdirSync(join(build,'ultrags/logs'),{recursive:true});
if(JSON.stringify(inputSnapshot)!==JSON.stringify(executionInputs(root)))throw Error('S4 execution sources changed during run');
verifyBuild(root,join(build,'ultrags/dss'));
writeFileSync(join(build,fullOnly?'ultrags/logs/s4-full.json':'ultrags/logs/s4-run.json'),JSON.stringify({results,executed:[...executed.values()],inputs:inputSnapshot,buildInputs:assembly.inputs},null,2)+'\n');
