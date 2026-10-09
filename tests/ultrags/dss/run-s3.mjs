// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {MemoryCard} from './memory-card.mjs';
const root=resolve(process.argv[2]||'.'),build=resolve(process.argv[3]||'build');
const bytes=readFileSync(join(build,'ultrags/dss/UGMEM.EXE')),h=parseExe(bytes),Z80=loadZ80(root);
const catalog=readFileSync(process.env.UG_S2_CATALOG||join(build,'host/s2-catalog.bin'));
const results=[];
const reference=JSON.parse(readFileSync(join(build,'host/s3-commands.json')));
const differential=new MemoryCard(catalog);
for(const c of reference){
 differential.o.memoryFault=c.memoryFault??false;
 const [status,r]=differential.command(c.op,Buffer.from(c.q,'hex')),actual=Buffer.from(c.r,'hex');
 // Wall-clock duration depends on the mock peripheral/CPU. All other wire
 // bytes, including compared-byte count and first mismatch, must match.
 if(status!==c.status||r.length!==actual.length||!r.subarray(0,c.op===5?10:r.length).equals(actual.subarray(0,c.op===5?10:actual.length)))throw Error('C/model mismatch opcode '+c.op);
}
console.log('PASS S3 actual C/model fixtures: '+reference.length);
function test(name,cli,expected=0,opts={}){
 const card=new MemoryCard(catalog,opts);
 const m=new SprinterMachine({card:opts.absent?null:card,cardSlot:opts.slot??0,cpuHz:opts.cpuHz??21000000,commandLine:cli,movingClock:!opts.stopped,clockStart:opts.clockStart??86390,escAfter:opts.escAfter??Infinity,logLimit:100});
 const dss=m.dssCall.bind(m);m.dssCall=s=>{const v=dss(s);if(v!=='exit'){s.ix=0xdead;s.iy=0xbeef;}return v;};
 m.mem.set(bytes,h.loadAddr);const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:opts.iff??1,budget:opts.budget??60000000});
 const errors=[...m.violations];if(m.system!==m.systemInit||m.page3!==m.page3Init||!!run.end.iff1!==!!(opts.iff??1)||run.end.sp!==h.stack-2)errors.push('context');
 if(opts.check&&!opts.check(card,m))errors.push('postcondition');
 const ok=run.exitCode===expected&&!errors.length&&m.text.includes(`RESULT ${expected?'FAIL':'PASS'} code=${expected}`);
 console.log(`${ok?'PASS':'FAIL'} S3 ${name} exit=${run.exitCode} ${ok?'':JSON.stringify({text:m.text,errors,trace:m.trace})}`);
 results.push({name,ok,exit:run.exitCode,expected,text:m.text,errors,steps:run.steps,maxWindowUs:m.maxWindowUs});
 if(!ok && process.env.UG_FAIL_FAST)throw Error(name);
}
test('info','INFO',0,{check:(c,m)=>m.text.includes('pool=8388608')&&m.text.includes('limit=128')});
for(const slot of [0,1])for(const cpuHz of [21000000,3500000])for(const iff of [0,1]){
 const opts={slot,cpuHz,iff};
 for(const cmd of ['INFO','LIST','TEST QUICK','TEST FULL','RESET WARM','RESET COLD'])test(`${cmd}-${slot}-${cpuHz}-${iff}`,`${cmd} /slot:${slot}`,0,opts);
 test(`free-${slot}-${cpuHz}-${iff}`,`free 0xFFFF /slot:${slot}`,0,{...opts,objects:[[65535,16]],check:c=>!c.objects.size});
}
test('sticky-error-retry','TEST QUICK',0,{stickyError:17,simpleDelayUs:10000,delayUs:20000,check:c=>!c.resets});
test('crc-valid','INFO /VERIFY');
test('bad-crc','INFO /VERIFY',9,{badCrc:true,check:c=>c.resets===1});
test('mem-error-crc','TEST QUICK /VERIFY',4,{memoryFault:true,check:(c,m)=>m.text.includes('expected=0x80')});
test('relocated','info /base:0280',0,{base:0x280});
test('quiet','INFO /QUIET',0,{check:(c,m)=>m.text==='RESULT PASS code=0\r\n'});
test('list-handles','LIST',0,{objects:[[1,16],[256,32],[65535,48]],check:(c,m)=>['0001','0100','FFFF'].every(h=>m.text.includes('handle=0x'+h))});
test('decimal-handle','FREE 65535',0,{objects:[[65535,16]]});
test('full-90s-midnight','TEST FULL',0,{delayUs:90000000,clockStart:86390,budget:350000000,check:(c,m)=>m.text.includes('tested=125829120')&&m.text.includes('first_bad=0xFFFFFFFF')});
for(const [name,cli,code,o] of [
 ['memory','TEST QUICK',4,{memoryFault:true,check:(c,m)=>m.text.includes('first_bad=0x00000000')&&m.text.includes('expected=0x80')}],
 ['full-memory','TEST FULL',4,{memoryFault:true,check:(c,m)=>!c.resets&&m.text.includes('tested=8388609')&&m.text.includes('expected=0xFF')&&m.text.includes('actual=0x7F')}],
 ['unavailable','TEST QUICK',4,{unavailable:true,pool:0,check:(c,m)=>m.text.includes('tested=0')&&m.text.includes('first_bad=0xFFFFFFFF')}],
 ['cancel-retains-failure','TEST FULL',10,{memoryError:17,delayUs:90000000,escAfter:2,check:c=>c.resets===1&&c.memoryError===17}],
 ['cold-90s-midnight','RESET COLD',0,{objects:[[1,16]],gs:true,delayUs:90000000,clockStart:86390,budget:350000000,check:c=>c.session===124n&&!c.objects.size&&c.gs}],
 ['warm-quiet-warning','RESET WARM /QUIET',0,{objects:[[1,16]],gs:true,check:(c,m)=>!c.objects.size&&c.gs&&m.text==='WARNING RESET destroys all loaded objects\r\nRESULT PASS code=0\r\n'}],
 ['cold-error','RESET COLD',4,{memoryFault:true,check:c=>c.session===124n}],
 ['nonempty-quick','TEST QUICK',4,{objects:[[1,16]],check:c=>c.objects.size===1&&c.resets===0}],
 ['nonempty-full','TEST FULL',4,{objects:[[1,16]],check:c=>c.objects.size===1}],
 ['busy','INFO',4,{busy:true,check:c=>!c.resets}],
 ['startup','INFO',4,{bootState:2,check:(c,m)=>m.text.includes('boot_state=2')}],
 ['pinned','FREE 1',4,{objects:[[1,16]],pins:1}], ['stale','FREE 1',4,{}],
 ['mode','INFO',2,{mode:1}],['absent','INFO',2,{absent:true}],['protocol','INFO',3,{protocol:3}],['api','INFO',3,{api:2}],['caps','INFO',3,{noCaps:true}],
 ['bad-length','INFO',3,{badLength:true,check:c=>c.resets===1}],['bad-status','INFO',3,{badStatus:true}],
 ['timeout','INFO',8,{noReply:true,check:c=>c.resets===1}],
 ['warm-timeout','RESET WARM',8,{noReplyOp:6,check:c=>c.resets===1&&c.now<2000000}],
 ['full-timeout','TEST FULL',8,{noReplyOp:5,cpuHz:3500000,budget:120000000,check:c=>c.resets===1&&c.now>=119000000&&c.now<121000000}],
 ['esc','TEST FULL',10,{delayUs:90000000,escAfter:2,check:c=>c.resets===1}],
 ['stopped','TEST FULL',8,{delayUs:90000000,stopped:true,budget:200000000,check:c=>c.resets===1}],
 ['help','/?',0,{}],['roundtrip','ROUNDTRIP 16',3,{}],['roundtrip-pool','ROUNDTRIP 8388608',3,{check:(c,m)=>m.text.includes('ROUNDTRIP_UNAVAILABLE_UNTIL_S4')}],
])test(name,cli,code,o);
for(const cli of ['', 'TEST','TEST X','RESET HOT','FREE 65536','FREE 0x10000','FREE -1','FREE 999999999999','INFO X','INFO /SLOT:2','INFO /BASE:02A1','INFO /BASE:0400','INFO /SAVE','BOGUS'])test('syntax '+cli,cli,1,{});
mkdirSync(join(build,'ultrags/logs'),{recursive:true});writeFileSync(join(build,'ultrags/logs/s3-run.json'),JSON.stringify({results,executed:[{name:'UGMEM.EXE',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]},null,2));
process.exit(results.every(r=>r.ok)?0:1);
