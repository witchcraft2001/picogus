// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {verifyBuild} from '../../../tools/ultrags/build-evidence.mjs';
import {DiagCard} from './diag-card.mjs';
const root=resolve(process.argv[2]||'.'), build=resolve(process.argv[3]||'build/ultrags');
verifyBuild(root,join(build,'dss'));
const Z80=loadZ80(root), results=[], executed=[];
for(const name of ['UGTEST','ST-S1-BENCH','ST-S1-DROP','ST-S1-DUP','ST-S1-COUNTER','ST-S1-OVERBLOCK','ST-S1-DSSWIN','ST-S1-CLEANUP','ST-S1-FUSE']) {const bytes=readFileSync(join(build,'dss',name+'.EXE'));executed.push({name:name+'.EXE',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
function test(name,exe,cli,expected=0,opts={}) {
  const bytes=readFileSync(join(build,'dss',exe+'.EXE')), h=parseExe(bytes);
  const card=opts.absent?null:new DiagCard(opts.card);
  const m=new SprinterMachine({card,cardSlot:opts.slot??0,cpuHz:opts.cpuHz??21000000,commandLine:cli,movingClock:!opts.stopped,clockStart:opts.clockStart??86390,escAfter:opts.escAfter??Infinity,logLimit:1000});
  m.mem.set(bytes,h.loadAddr);
  const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:opts.iff??1,budget:opts.budget??150000000});
  const violations=[...m.violations];
  if(m.system!==m.systemInit||m.page3!==m.page3Init||!!run.end.iff1!==!!(opts.iff??1)||run.end.sp!==h.stack-2)violations.push('cleanup context mismatch');
  if(m.maxWindowUs>=10000)violations.push('DI >=10ms');
  if(card?.state)violations.push('live diagnostic grant after exit');
  if(card?.profile&&run.exitCode!==0)violations.push('live spike after failure');
  if(opts.noNative&&card&&(card.totalWritten||card.totalRead||card.session!==2))violations.push('native access before CLI/identity validation');
  if(opts.shortTiming&&(!m.text.includes('SPEED=INSUFFICIENT_INTERVAL')||m.text.includes('bytes_per_second=')))violations.push('unqualified speed from short interval');
  if(opts.nonzeroTiming&&!/total_seconds=0x(?!00000000)[0-9A-F]{8}/.test(m.text))violations.push('timing regression must include a nonzero short interval');
  if(opts.card?.fuseReported&&run.exitCode===0)violations.push('unhandled diagnostic fuse');
  const matchedViolations=opts.expectedViolation ? violations.length>0&&violations.every(v=>opts.expectedViolation.test(v)) : violations.length===0;
  const ok=run.exitCode===expected&&matchedViolations&&m.text.includes(`RESULT ${expected?'FAIL':'PASS'} code=${expected}`);
  results.push({name,ok,exit:run.exitCode,expected,steps:run.steps,cycles:run.cycles,text:m.text,violations,card:card?{written:card.totalWritten,read:card.totalRead}:null,maxWindowUs:m.maxWindowUs});
  console.log(`${ok?'PASS':'FAIL'} S1 ${name} code=${run.exitCode} ${run.steps}i violations=${violations.length} ${ok?'':violations.slice(0,2).join(';')+' '+m.text}`);
  return results.at(-1);
}
// Small smoke first; million-byte machine runs are intentionally real loops.
test('smoke','ST-S1-BENCH','/BYTES:256 /LOOPS:1 /CHECK:NONE',0,{shortTiming:true});
if(!results[0].ok) {mkdirSync(join(build,'logs'),{recursive:true});writeFileSync(join(build,'logs/s1-run.json'),JSON.stringify({results,executed},null,2));process.exit(1);}
for(const slot of [0,1]) for(const [cpuHz,cpu] of [[21000000,'21'],[3500000,'3.5']]) for(const iff of [0,1])
  test(`slot${slot}-${cpu}-IFF${iff}`,'ST-S1-BENCH',`/SLOT:${slot} /CPU:${cpu} /BYTES:1025 /BLOCK:512 /LOOPS:1 /CHECK:BOTH`,0,{slot,cpuHz,iff,shortTiming:cpuHz===3500000,nonzeroTiming:cpuHz===3500000});
for(const block of [1,256,512,1024])test(`block${block}`,'ST-S1-BENCH',`/BYTES:1025 /BLOCK:${block} /LOOPS:1 /CHECK:BOTH`);
for(const [name,cli,code,opts] of [
  ['absent','BUS',2,{absent:true}],['wrong-mode','BUS',2,{card:{mode:8}}],['wrong-version','BUS',3,{card:{version:2}}],['wrong-protocol','BUS',3,{card:{protocol:5}}],
  ['corrupt','/BYTES:256 /LOOPS:1',9,{card:{corrupt:true}}],['lost-byte','/BYTES:256 /LOOPS:1',9,{card:{drop:true}}],['duplicate-byte','/BYTES:256 /LOOPS:1',9,{card:{duplicate:true}}],['wrong-counter','/BYTES:256 /LOOPS:1',9,{card:{badCounter:true}}],['unhandled-fuse','/BYTES:256 /LOOPS:1',9,{card:{fuse:true}}],
  ['cancel','/BYTES:65536 /LOOPS:1',10,{escAfter:1}],['clock-stopped','/BYTES:1 /LOOPS:1 /SOAK:1',8,{stopped:true}],
])test(name,['absent','wrong-mode','wrong-version','wrong-protocol'].includes(name)?'UGTEST':'ST-S1-BENCH',cli,code,opts);
for(const cli of ['/SLOT:2','/BASE:06A0','/BYTES:0','/BYTES:4294967296','/BLOCK:1025','/LOOPS:0','/CPU:7','/WHAT','BUSX'])test('CLI '+cli,'ST-S1-BENCH',cli,1);
for(const method of ['STACK','ALIAS','SLOW'])test('unsupported-'+method,'ST-S1-BENCH','/METHOD:'+method,3,{noNative:true});
test('timeout','ST-S1-BENCH','/BYTES:256 /LOOPS:1',8,{card:{timeout:true}});
test('fuse-reported','ST-S1-BENCH','/BYTES:256 /LOOPS:1',9,{card:{fuseReported:true}});
for(const [name,code,opts] of [['DROP',9,{}],['DUP',9,{}],['COUNTER',9,{}],['OVERBLOCK',9,{}],['DSSWIN',0,{expectedViolation:/DSS call .* while ISA window open/}],['CLEANUP',0,{expectedViolation:/DSS call .* while ISA window open|cleanup context mismatch/}],['FUSE',0,{card:{fuseReported:true},expectedViolation:/unhandled diagnostic fuse/}]])
  test('defective-selftest-'+name,'ST-S1-'+name,'/BYTES:256 /LOOPS:1 /CHECK:NONE',code,opts);
test('finite-delay-CLI','ST-S1-BENCH','/ASSERT:1000 /RESPONSE:1000 /BYTES:33 /BLOCK:32 /LOOPS:1 /CHECK:NONE');
test('delay-over-limit','ST-S1-BENCH','/ASSERT:1001',1);
test('aggregate-overflow','ST-S1-BENCH','/BYTES:4294967295 /LOOPS:2',1);
test('hex-and-case','ST-S1-BENCH','/slot:0 /bytes:0x101 /loops:1 /block:0x100 /check:none');
test('spike1','ST-S1-BENCH','/SPIKE:1 /BYTES:32 /LOOPS:1 /CHECK:NONE');
test('spike2','ST-S1-BENCH','/SPIKE:2 /BYTES:32 /LOOPS:1 /CHECK:NONE');
test('spike-command-busy-retry','ST-S1-BENCH','/SPIKE:1 /BYTES:32 /LOOPS:1 /CHECK:NONE',0,{card:{spikeBusy:2}});
test('spike-command-busy-timeout','ST-S1-BENCH','/SPIKE:1 /BYTES:32 /LOOPS:1 /CHECK:NONE',8,{card:{spikeBusy:1000}});
test('spike-snapshot-busy-retry','ST-S1-BENCH','/SPIKE:1 /BYTES:32 /LOOPS:1 /CHECK:NONE',0,{card:{spikeSnapshotBusy:2}});
test('spike-snapshot-busy-timeout','ST-S1-BENCH','/SPIKE:1 /BYTES:32 /LOOPS:1 /CHECK:NONE',8,{card:{spikeSnapshotBusy:1000}});
test('spike-wrong-profile','ST-S1-BENCH','/SPIKE:1 /BYTES:32 /LOOPS:1 /CHECK:NONE',8,{card:{spikeWrongProfile:true}});
test('spike-not-started','ST-S1-BENCH','/SPIKE:1 /BYTES:32 /LOOPS:1 /CHECK:NONE',8,{card:{spikeInit:true}});
test('spike-cancel-cleanup','ST-S1-BENCH','/SPIKE:1 /BYTES:32 /LOOPS:1 /CHECK:NONE',10,{escAfter:1,card:{spikeSnapshotBusy:2}});
for(const fault of ['spikeUnderruns','spikeFetchErrors','spikeBgErrors','spikeResFaults','spikeNoAudit','spikeFuse'])
  test(fault,'ST-S1-BENCH','/SPIKE:1 /BYTES:32 /LOOPS:1 /CHECK:NONE',7,{card:{[fault]:true}});
test('mirror-corruption-cleanup','UGTEST','BUS /MIRROR',9,{card:{mirrorCorrupt:true}});
test('spike-fault','ST-S1-BENCH','/SPIKE:1 /BYTES:32 /LOOPS:1 /CHECK:NONE',7,{card:{spikeFault:true}});
test('moving-clock-midnight','ST-S1-BENCH','/BYTES:1 /LOOPS:1 /SOAK:2 /CHECK:NONE',0,{clockStart:86399});
test('moving-clock-midnight-lowcpu','ST-S1-BENCH','/BYTES:1 /LOOPS:1 /SOAK:2 /CHECK:NONE /CPU:3.5',0,{clockStart:86399,cpuHz:3500000,iff:0});
test('help','ST-S1-BENCH','/?');
test('quiet','ST-S1-BENCH','/QUIET /BYTES:256 /LOOPS:1 /CHECK:NONE');
for(const slot of [0,1])for(const [cpuHz,cpu] of [[21000000,'21'],[3500000,'3.5']])test(`million-byte-slot${slot}-${cpu}`,'UGTEST',`BUS /SLOT:${slot} /CPU:${cpu} /QUIET${slot?' /MIRROR':''}`,0,{slot,cpuHz,iff:slot?0:1});
const fail=results.filter(r=>!r.ok).length;
mkdirSync(join(build,'logs'),{recursive:true});writeFileSync(join(build,'logs/s1-run.json'),JSON.stringify({executed,results,pass:results.length-fail,fail},null,2));
process.exit(fail?1:0);
