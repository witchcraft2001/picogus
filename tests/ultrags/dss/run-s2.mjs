// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {ConfigCard,crc32} from './config-card.mjs';
const root=resolve(process.argv[2]||'.'), build=resolve(process.argv[3]||'build');
const bytes=readFileSync(join(build,'ultrags/dss/UGCFG.EXE')), h=parseExe(bytes), Z80=loadZ80(root);
const catalog=readFileSync(process.env.UG_S2_CATALOG || join(build,'host/s2-catalog.bin'));
const results=[];
const reference=JSON.parse(readFileSync(join(build,'host/s2-config-fixtures.json')));
const differential=new ConfigCard(readFileSync(join(build,'host/s2-catalog.bin')),{mode:8});
for(const c of reference){
 differential.o.busy=!c.idle;differential.writePort(0x1d0,c.selector);differential.writePort(0x1d1,c.low);differential.writePort(0x1d2,c.high);
 for(const field of ['result','base','alias','desired','gs'])if(Number(differential[field])!==c[field])throw Error('C/model differential: '+field+' selector='+c.selector);
}
console.log('PASS S2 actual C/model differential fixtures: '+reference.length);
function test(name,cli,expected=0,opts={}) {
 const card=opts.card??new ConfigCard(opts.catalog??catalog,opts);
 const m=new SprinterMachine({card:opts.absent?null:card,cardSlot:opts.slot??0,cpuHz:opts.cpuHz??21000000,commandLine:cli,movingClock:!opts.stopped,escAfter:opts.escAfter??Infinity,logLimit:1000});
 const dss=m.dssCall.bind(m);
 m.dssCall=s=>{const result=dss(s);if(result!=='exit'){s.ix=0xdead;s.iy=0xbeef;}return result;};
 m.mem.set(bytes,h.loadAddr);const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:opts.iff??1,budget:30000000});
 const errors=[...m.violations];
 if(m.system!==m.systemInit||m.page3!==m.page3Init||!!run.end.iff1!==!!(opts.iff??1)||run.end.sp!==h.stack-2)errors.push('context');
 if(opts.noMutation&&card.mutations.length)errors.push('mutated');
 if(opts.check&&!opts.check(card,m))errors.push('postcondition');
 const ok=run.exitCode===expected&&!errors.length&&m.text.includes(`RESULT ${expected?'FAIL':'PASS'} code=${expected}`);
 console.log(`${ok?'PASS':'FAIL'} S2 ${name} exit=${run.exitCode} ${ok?'':JSON.stringify({text:m.text,errors,trace:m.trace})}`);
 results.push({name,ok,exit:run.exitCode,expected,text:m.text,errors,steps:run.steps,maxWindowUs:m.maxWindowUs});return card;
}
test('info','INFO',0,{check:(c,m)=>m.text.includes('bulk_alias=OFF')});
test('info-alias-range','INFO',0,{mode:8,alias:0x280,check:(c,m)=>m.text.includes('bulk_alias=0280-029F')});
test('list','LIST');
test('mode','MODE ULTRAGS',0,{check:c=>c.mode===8&&c.reboots===1&&c.flash.mode===1});
test('same-mode-delayed-reboot','MODE ULTRAGS',0,{mode:8,rebootDelayUs:100000,check:c=>c.mode===8&&c.reboots===1&&!c.rebootAt});
test('old-fallback-delayed-reboot','MODE ULTRAGS',0,{boot:2,rebootDelayUs:100000,check:c=>c.mode===8&&!c.boot&&!c.rebootAt});
test('ignored-same-mode-reboot','MODE ULTRAGS',8,{mode:8,ignoredReboot:true,check:c=>c.reboots===1});
test('protocol-after-reboot','MODE ULTRAGS',3,{protocolAfterReboot:5});
test('catalog-fallback-after-reboot','MODE ULTRAGS',9,{catalogFailureAfterReboot:true,check:(c,m)=>m.text.includes('BOOT_FALLBACK')});
test('catalog-failure-handoff-info','INFO',0,{boot:5,check:(c,m)=>m.text.includes('CATALOG_INVALID')});
test('catalog-failure-handoff-readonly','MODE ULTRAGS',3,{boot:5,noMutation:true});
if(results.some(r=>!r.ok)){writeFileSync(join(build,'s2-dss-debug.json'),JSON.stringify(results,null,2));process.exit(1);}
for(const slot of [0,1])for(const cpuHz of [21000000,3500000])for(const iff of [0,1]){
 test(`mode-${slot}-${cpuHz}-${iff}`,`mode ultrags /slot:${slot} /save`,0,{slot,cpuHz,iff,check:c=>c.reboots===1&&c.saves===1&&c.flash.mode===8});
 test(`ports-${slot}-${cpuHz}-${iff}`,`PORTS 0280 02A0 /SLOT:${slot}`,0,{slot,cpuHz,iff,base:0x2a0,alias:0x280,check:c=>c.base===0x280&&c.alias===0x2a0});
}
for(const [cli,code,opts] of [
 ['VERIFY',0,{mode:8}],['MODE GUS',0,{mode:8}],['MODE 8',0,{}],['MODE 0x8',0,{}],['MODE 7',9,{noMutation:true}],['MODE 9',9,{noMutation:true}],['MODE 0',9,{noMutation:true}],
 ['MODE 08',0,{}],['MODE 0008',0,{}],['MODE 0x08',0,{}],['MODE 10',9,{noMutation:true}],['MODE 255',9,{noMutation:true}],['MODE 0xFF',9,{noMutation:true}],
 ['INFO',0,{legacy:true,noMutation:true}],['MODE 8',3,{legacy:true,noMutation:true}],['INFO',3,{protocol:5,noMutation:true}],['SAVE',3,{protocol:3,noMutation:true}],
 ['MODE 8',9,{fallback:true}],['MODE 8',8,{timeout:true}],['MODE 8',10,{escAfter:1}],['VERIFY',3,{mode:8,api:2}],['VERIFY',4,{mode:8,bootState:1}],['VERIFY',7,{mode:8,bootState:3}],['VERIFY',8,{mode:8,notReady:true}],
 ['PORTS 0280 02A0',9,{base:0x2a0,alias:0x280,rejectAt:2,check:c=>c.base===0x2a0&&c.alias===0x280&&!c.saves}],
 ['PORTS 0280 02A0 /SAVE',9,{base:0x2a0,alias:0x280,rollbackFail:true,check:(c,m)=>!c.saves&&m.text.includes('PARTIAL_CONFIGURATION')}],
 ['PORTS 0280 02A0 /SAVE',9,{base:0x2a0,alias:0x280,busy:true,check:(c,m)=>c.base===0x2a0&&c.alias===0x280&&!c.saves&&!m.text.includes('PARTIAL_CONFIGURATION')}],
 ['PORTS 0280 02A0 /SAVE',9,{base:0x2a0,alias:0x280,rejectAt:1,check:(c,m)=>c.base===0x2a0&&c.alias===0x280&&!c.saves&&!m.text.includes('PARTIAL_CONFIGURATION')}],
 ['GSALIAS ON',0,{mode:8,check:c=>c.gs}],['GSALIAS OFF',0,{mode:8}],['GSALIAS ON',9,{mode:1}],['SAVE',0,{check:c=>c.saves===1}],['SAVE',8,{busy:true,check:c=>!c.saves}],['MODE 8 /SAVE',9,{saveFail:true,check:c=>!c.reboots}],['SAVE',8,{saveTimeout:true}],
 ['/?',0,{noMutation:true}],['LIST /QUIET',0,{}],['PORTS 02A0 OFF /SAVE',0,{}],['INFO',2,{absent:true}],
])test(cli+' '+JSON.stringify(opts),cli,code,opts);
for(const state of [0,1,2,3])test('INFO bad CRC boot_state='+state,'VERIFY',9,{mode:8,bootState:state,badInfoCrc:true});
test('INFO bad CRC API','VERIFY',9,{mode:8,api:2,badInfoCrc:true});
test('MODE total boot/INFO deadline','MODE 8',8,{rebootDelayUs:8500000,notReady:true,check:c=>c.now>=9000000&&c.now<11000000});
for(const cli of ['','BOGUS','MODE','MODE 256','MODE 0x100','PORTS 01E0 OFF','PORTS 02A1 OFF','PORTS 0400 OFF','PORTS 0280 0280','GSALIAS X','GSALIAS ON /SAVE','INFO /SLOT:2','INFO /BASE:06A0','/WHAT','INFO EXTRA'])test('syntax '+cli,cli,1,{noMutation:true});
for(const [name,mut] of [
 ['crc',c=>c[144]^=1],['major',c=>c[4]=2],['minor',c=>c[5]=1],['count',c=>c[6]=7],['duplicate',c=>c[32]=1],['reserved',c=>c[18]=1],['flags',c=>c[17]=5],['absent-nonzero',c=>c[16+6*16+4]=1],['overlap',c=>c.copy(c,36,20,24)],['bounds',c=>c.writeUInt32LE(0x1ff000,20)],['short-image',c=>c.writeUInt32LE(263,24)],
]){
 const c=Buffer.from(catalog);mut(c);if(name!=='crc')c.writeUInt32LE(crc32(c.subarray(0,144)),144);
 test('catalog-'+name,'MODE 8',3,{catalog:c,invalidRaw:true,noMutation:true});
 test('recovery-'+name,'INFO',0,{catalog:c,invalidRaw:true,boot:5,noMutation:true,check:(c,m)=>m.text.includes('CATALOG_INVALID')});
}
const persistent=new ConfigCard(catalog,{mode:8});
test('volatile-on','GSALIAS ON',0,{card:persistent});test('save-volatile','SAVE',0,{card:persistent});persistent.powerCycle();test('powercycle-info','INFO',0,{card:persistent,check:c=>c.mode===8&&c.desired===8&&c.base===0x2a0&&!c.gs});
test('mode-no-save','MODE GUS',0,{card:persistent,check:c=>c.mode===1&&c.flash.mode===8});persistent.powerCycle();test('powercycle-persisted-mode','VERIFY',0,{card:persistent,check:c=>c.mode===8&&c.desired===8&&!c.gs});
mkdirSync(join(build,'ultrags/logs'),{recursive:true});writeFileSync(join(build,'ultrags/logs/s2-run.json'),JSON.stringify({results,executed:[{name:'UGCFG.EXE',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]},null,2));
process.exit(results.every(r=>r.ok)?0:1);
