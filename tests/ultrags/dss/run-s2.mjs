// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {ConfigCard,crc32} from './config-card.mjs';
import {DiagCard} from './diag-card.mjs';
const root=resolve(process.argv[2]||'.'), build=resolve(process.argv[3]||'build');
const bytes=readFileSync(join(build,'ultrags/dss/UGCFG.EXE')), h=parseExe(bytes), Z80=loadZ80(root);
const catalog=readFileSync(process.env.UG_S2_CATALOG || join(build,'host/s2-catalog.bin'));
const results=[];
const diagnostic=new DiagCard();diagnostic.writePort(0x1d0,0xcc);diagnostic.writePort(0x1d0,1);diagnostic.writePort(0x1d0,0xcc);
if(diagnostic.readPort(0x1d0)!==1)throw Error('diagnostic unlock changed selector');
diagnostic.writePort(0x1d0,0);if(diagnostic.readPort(0x1d0)!==0||diagnostic.readPort(0x1d2)!==0xdd)throw Error('diagnostic magic port');
const reference=JSON.parse(readFileSync(join(build,'host/s2-config-fixtures.json')));
const differential=new ConfigCard(readFileSync(join(build,'host/s2-catalog.bin')),{mode:8});
for(const c of reference){
 differential.writePort(0x1d0,0xcc);differential.o.busy=!c.idle;differential.writePort(0x1d0,c.selector);differential.writePort(0x1d1,c.low);differential.writePort(0x1d2,c.high);
 for(const field of ['result','base','alias','desired','gs'])if(Number(differential[field])!==c[field])throw Error('C/model differential: '+field+' selector='+c.selector);
}
const productionInputs=JSON.parse(readFileSync(join(build,'host/config-exchange-inputs.json')));
for(const [p,hash] of Object.entries(productionInputs))if(createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex')!==hash)throw Error('stale production config input '+p);
const productionCatalog=Object.keys(productionInputs).find(p=>p.endsWith('catalog.bin'));
const portModel=new ConfigCard(readFileSync(resolve(root,productionCatalog)),{mode:8});
const portTrace=JSON.parse(readFileSync(join(build,'host/config-exchange.json')));
for(const [write,port,value] of portTrace){if(write)portModel.writePort(port,value);else if(portModel.readPort(port)!==value)throw Error('production C/model port mismatch '+port.toString(16)+' selector '+portModel.sel);}
console.log('PASS production picogus.cpp config branches / model: '+portTrace.length+' transactions');
console.log('PASS S2 actual C/model differential fixtures: '+reference.length);
function test(name,cli,expected=0,opts={}) {
 const card=opts.card??new ConfigCard(opts.catalog??catalog,opts);
 const m=new SprinterMachine({card:opts.absent?null:card,page3Init:opts.page3??3,turboInit:opts.turboInit,cardSlot:opts.slot??0,cpuHz:opts.cpuHz??21000000,turboHardware:opts.turboHardware??(opts.cpuHz!==3500000),commandLine:cli,movingClock:!opts.stopped,escAfter:opts.escAfter??Infinity,logLimit:1000});
 const dss=m.dssCall.bind(m);
 m.dssCall=s=>{const fn=s.c;
  if(opts.escInSave&&card.saveSamples?.some(x=>x.value===255))m.escAfter=0;
  const result=dss(s);if(result!=='exit'){
   s.ix=0xdead;s.iy=0xbeef;
   if(opts.clobberDss){s.d=0xa1;s.e=0xb2;s.c=0xc3;
    if(fn!==0x21){s.h=0xd4;s.l=0xe5;s.b=0xf6;}if(fn!==0x31)s.a=0x97;}
  }return result;};
 m.mem.set(opts.exe??bytes,h.loadAddr);const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:opts.iff??1,budget:opts.budget??30000000});
 const errors=[...m.violations];
 if(m.maxDiUs>=10000 || m.maxWindowUs>=10000)errors.push("ISA/DI budget >=10ms");
 if(m.turboWrites && !m.turbo)errors.push("DSS Turbo not enabled");
 if((cli.trim()==="/?" || expected===1) && m.turboWrites)errors.push("Turbo touched before argument validation");
 if(m.system!==m.systemInit||m.page3!==m.page3Init||!!run.end.iff1!==!!(opts.iff??1)||run.end.sp!==h.stack-2)errors.push('context');
 if(opts.noMutation&&card.mutations.length)errors.push('mutated');
 if(opts.check&&!opts.check(card,m))errors.push('postcondition');
 const ok=run.exitCode===expected&&!errors.length&&m.text.includes(`RESULT ${expected?'FAIL':'PASS'} code=${expected}`);
 console.log(`${ok?'PASS':'FAIL'} S2 ${name} exit=${run.exitCode} ${ok?'':JSON.stringify({text:m.text,errors,trace:m.trace})}`);
 results.push({name,ok,exit:run.exitCode,expected,text:m.text,errors,variantSha256:opts.exe?createHash('sha256').update(opts.exe).digest('hex'):undefined,steps:run.steps,maxWindowUs:m.maxWindowUs,maxDiUs:m.maxDiUs});return card;
}
const listing=readFileSync(join(build,'ultrags/dss/ugcfg.lst'),'utf8');
function label(name){const m=listing.replace(/;.*$/gm,'').match(new RegExp('^\\s*\\d+\\+*\\s*([0-9A-F]{4})\\s+'+name+':\\s*$','m'));if(!m)throw Error('missing '+name);return parseInt(m[1],16)-h.loadAddr;}
const badPort=Buffer.from(bytes),data8=label('UG_CFG_DATA8');
// Data8: CALL open / LD A,(C1D2). Old UG_OPEN read CONTROL as magic.
if(badPort[data8+3]!==0x3a||badPort[data8+4]!==0xd2)throw Error('unexpected DATA8 instruction');badPort[data8+4]=0xd0;
test('regression-wrong-magic-port','INFO',2,{exe:badPort,noMutation:true});
const unchecked=Buffer.from(bytes),select=label('UG_CFG_SELECT');unchecked[select]=0xaf;unchecked[select+1]=0xc9;
test('regression-unconfirmed-selector','LIST',2,{exe:unchecked,selectorDelayUs:800,requireEcho:true,noMutation:true,check:c=>c.staleReads>0});
test('info','INFO',0,{check:(c,m)=>m.text.includes('bulk_alias=OFF')});
test('info-alias-range','INFO',0,{mode:8,alias:0x280,check:(c,m)=>m.text.includes('bulk_alias=0280-029F')});
for(const [base,alias] of [[0,0xffff],[0x400,0xffff],[0x2a1,0xffff],[0x2a0,0x2a0],[0x2a0,0]])
 test(`invalid committed ports ${base}/${alias}`,'INFO /DIAG',9,{mode:8,base,alias,noMutation:true,check:(c,m)=>!c.request.length&&!c.responseReads&&m.text.includes('CONFIG_PORTS')&&m.isaLog.every(e=>e.isa>=0x1d0&&e.isa<=0x1d2)});
test('list','LIST',0,{check:(c,m)=>m.text.includes('08 ULTRAGS')&&m.text.includes('07 NE2000 ABSENT')});
test('default-info','',0,{check:(c,m)=>m.text.includes('ISA slot=00')&&m.text.includes('firmware=PicoGUS model')});
test('short-mode','ULTRAGS /SAVE',0,{check:c=>c.reboots===1&&c.saves===1&&c.flash.mode===8});
test('slot-space','ULTRAGS /SLOT 1',0,{slot:1});
test('help-examples','/?',0,{check:(c,m)=>!m.ioLog.length&&!m.isaLog.length&&m.text.includes('UGCFG GUS /SAVE')});
for(const selectorDelayUs of [150,800,5000]) {
 test('delayed-selector-'+selectorDelayUs,'ULTRAGS /SAVE /DIAG',0,{selectorDelayUs,requireEcho:true,check:c=>!c.staleReads&&c.saves===1&&c.reboots===1});
}
for(const dropSelectAt of [1,2,8,12])test('lost-selector-'+dropSelectAt,'LIST /DIAG',0,{dropSelectAt,requireEcho:true,check:c=>!c.staleReads});
for(const selectorDelayUs of [80000,200000])test('slow-selector-catalogue-'+selectorDelayUs,'LIST /DIAG',0,{selectorDelayUs,requireEcho:true,check:c=>!c.staleReads});
test('selector-timeout','LIST /DIAG',8,{selectorStuck:true,noMutation:true,check:(c,m)=>c.now>=2000000&&c.now<4000000&&m.text.includes('SELECTOR')});
test('selector-stopped-clock','LIST /DIAG',8,{selectorStuck:true,stopped:true,noMutation:true});
test('stopped-boot-timeout','ULTRAGS /SAVE',8,{timeout:true,stopped:true,noMutation:false,check:c=>c.reboots===1&&!c.saveRequests&&c.now<40000000});
test('stopped-save-timeout','SAVE',8,{saveTimeout:true,stopped:true,check:c=>c.saveRequests===1&&c.now<40000000});
test('stopped-INFO-init-timeout','VERIFY',8,{mode:8,notReady:true,stopped:true,budget:60000000,check:c=>!c.resets&&c.now<45000000});
test('stopped-unchanged-session-timeout','ULTRAGS /SAVE',8,{mode:8,ignoredReboot:true,stopped:true,budget:65000000,check:c=>c.reboots===1&&!c.saveRequests&&c.now<60000000});
test('selector-cancel','LIST /DIAG',10,{selectorStuck:true,escAfter:1,noMutation:true});
for(const page3 of [3,0xE9,0xFE])for(const slot of [0,1])for(const iff of [0,1])for(const turboInit of [false,true])for(const turboHardware of [false,true])
 test(`context-${page3}-${slot}-${iff}-${turboInit}-${turboHardware}`,`ULTRAGS /SAVE /SLOT ${slot} /DIAG`,0,{page3,slot,iff,turboInit,turboHardware,clobberDss:true,check:c=>c.saves===1&&c.reboots===1});
for(const [name,o,code] of [['fallback',{fallback:true},9],['api',{api:2},3],['memory',{bootState:1},4],['audio',{bootState:3},7],['info-crc',{badInfoCrc:true},9],['ready-timeout',{notReady:true},8]])
 test('no-flash-before-verified-'+name,'ULTRAGS /SAVE /DIAG',code,{...o,check:c=>c.saveRequests===0&&c.flash.mode===1});
test('api-minor','INFO /DIAG',3,{mode:8,apiMinor:1,check:(c,m)=>m.text.includes('Expected=00 received=01')});
test('ultra-ports-save','PORTS 0280 OFF /SAVE',0,{mode:8,check:c=>c.saves===1&&c.flash.base===0x280});
const unverified=new ConfigCard(catalog);unverified.desired=8;
test('standalone-save-unverified','SAVE',9,{card:unverified,check:c=>c.saveRequests===0&&c.flash.mode===1});
const previousSave=new ConfigCard(catalog,{mode:8});previousSave.flash.mode=1;previousSave.snapshot={...previousSave.flash};previousSave.result=5;previousSave.saveAt=1000000;
test('previous-save-not-our-acceptance','SAVE',8,{card:previousSave,check:c=>c.saveRequests===0&&c.flash.mode===1});
test('delayed-ready','ULTRAGS /SAVE',0,{readyAtUs:1800000,check:c=>c.saves===1&&c.flash.mode===8});
for(const [name,o,code] of [['lost-save',{dropSave:true},9],['lost-answer',{lostSaveResult:true},9],['fast-unobserved',{saveDelayUs:1},9],['save-failed',{saveFail:true},9],['save-timeout',{saveTimeout:true},8]])
 test(name,'ULTRAGS /SAVE /DIAG',code,{...o,check:(c,m)=>c.mode===8&&c.reboots===1&&c.saveRequests===1&&m.text.includes('already active')&&m.text.includes('SAVE_UNCONFIRMED')});
// Transient FF on CFG_RESULT is a missed non-consuming sample, not a
// reason to replay SAVE. In particular a whole lost BUSY phase must still
// remain unconfirmed even if Flash really changed. No stream reads repeat.
function saveResultFault(mask,opts={}) {
 const c=new ConfigCard(catalog,{mode:8,saveDelayUs:50000,...opts});
 c.flash.mode=1;
 const rd=c.readPort.bind(c);let count=0;
 c.saveSamples=[];
 c.readPort=p=>{
  const v=rd(p);
  if(p!==0x1d2||c.sel!==0x78||!c.saveRequests)return v;
  const sample={index:++count,result:v,done:!!c.saves};
  const value=mask(sample,c)?255:v;
  c.saveSamples.push({...sample,value});return value;
 };
 return c;
}
for(const [name,mask] of [
 ['initial',s=>s.index<=2],['middle',s=>s.index===3||s.index===5],
 ['first-completion',(s,c)=>s.done&&!c.maskedCompletion&&(c.maskedCompletion=true)],
])for(const slot of [0,1])for(const iff of [0,1]) {
 const c=saveResultFault(mask);
 test(`SAVE transient FF ${name} slot${slot} iff${iff}`,'SAVE /DIAG /SLOT:'+slot,0,
  {card:c,slot,iff,clobberDss:true,check:(c,m)=>c.saveRequests===1&&c.saves===1&&c.flash.mode===8&&
   c.saveSamples.some(s=>s.value===255)&&c.saveSamples.some(s=>s.value===5)&&
   c.responseReads===42&&!c.overreads&&m.text.includes('save_result_ff_reads=000')});
}
const allBusyLost=saveResultFault(s=>s.result===5);
test('SAVE FF throughout BUSY remains unconfirmed','SAVE /DIAG',9,{card:allBusyLost,
 check:(c,m)=>c.saveRequests===1&&c.saves===1&&c.flash.mode===8&&
 !c.saveSamples.some(s=>s.value===5)&&m.text.includes('SAVE_UNCONFIRMED')});
const corruptedSave=saveResultFault(s=>s.index>=2&&s.index<=9),corruptedRead=corruptedSave.readPort.bind(corruptedSave);
corruptedSave.readPort=p=>{
 const v=corruptedRead(p),s=corruptedSave.saveSamples.at(-1);
 if(p===0x1d2&&corruptedSave.sel===0x78&&corruptedSave.saveRequests&&s?.index===10){s.value=0x9f;return 0x9f;}
 return v;
};
test('SAVE BUSY eight FF then corrupted 9F remains failure','SAVE /DIAG',9,{card:corruptedSave,
 check:(c,m)=>c.saveRequests===1&&c.saveSamples.filter(s=>s.value===255).length===8&&
 m.text.includes('save_result_ff_reads=0008')&&m.text.includes('received=9F')});
const ffCancel=saveResultFault(()=>true);
test('SAVE FF ESC does not replay','SAVE /DIAG',10,{card:ffCancel,escInSave:true,
 check:c=>c.saveRequests===1&&c.saveSamples.length===1});
test('SAVE FF stopped clock bounded','SAVE /DIAG',9,{mode:8,lostSaveResult:true,stopped:true,budget:60000000,
 check:c=>c.saveRequests===1&&c.now<40000000});
const oldSave=Buffer.from(bytes),saveStart=label('SAVE'),saveEnd=label('START_WAIT');
const sites=[];
for(let i=saveStart;i<saveEnd-8;i++)if(oldSave[i]===0xfe&&oldSave[i+1]===5&&oldSave[i+2]===0x28&&oldSave[i+4]===0xfe&&oldSave[i+5]===255&&oldSave[i+6]===0x20)sites.push(i);
if(sites.length!==1)throw Error('SAVE sample mutation instruction mismatch');
oldSave[sites[0]+6]=0x18; // reproduce the previous immediate failure on FF
test('regression SAVE immediate FF failure','SAVE /DIAG',9,{exe:oldSave,card:saveResultFault(s=>s.index<=2),
 check:(c,m)=>c.saveRequests===1&&c.saveSamples.length===1&&m.text.includes('SAVE_UNCONFIRMED')});
test('info-visible-before-api-failure','INFO /DIAG',3,{mode:8,api:2,check:(c,m)=>m.text.includes('active=08 ULTRAGS')&&m.text.includes('firmware=PicoGUS model')&&m.text.includes('API_VERSION')});
for(const n of [0,1,35,37,128])test('INFO announced length '+n,'VERIFY /DIAG',9,{mode:8,infoLength:n,check:c=>c.responseReads===n+6&&!c.overreads&&!c.response.length&&!c.resets});
test('INFO short error response','VERIFY /DIAG',9,{mode:8,infoLength:0,infoStatus:5,check:c=>c.responseReads===6&&!c.overreads&&!c.response.length&&!c.resets});
test('INFO invalid length resets only owned frame','VERIFY /DIAG',9,{mode:8,infoDeclaredLength:129,check:c=>c.responseReads===2&&!c.overreads&&!c.response.length&&c.resets===1});
test('INFO corrupt short length cancels unread owned tail','VERIFY /DIAG',9,{mode:8,infoDeclaredLength:0,check:c=>c.responseReads===6&&!c.overreads&&!c.response.length&&c.resets===1});
const lostInfoLength=new ConfigCard(catalog,{infoReadFFAt:1});
test('native late length MODE no Flash','ULTRAGS /SAVE',9,{card:lostInfoLength,check:(c,m)=>c.mode===8&&c.reboots===1&&c.saveRequests===0&&c.responseReads===2&&!c.overreads&&c.resets===1&&m.text.includes('INFO_LENGTH')});
test('native late length INFO diagnostics','INFO /DIAG',9,{card:lostInfoLength,check:(c,m)=>c.mode===8&&c.reboots===1&&c.saveRequests===0&&c.responseReads===4&&!c.overreads&&c.resets===2&&m.text.includes('INFO bytes/raw frame=02 00 FF')});
test('native late length LIST remains valid','LIST /DIAG',0,{card:lostInfoLength,check:c=>c.reboots===1&&c.saveRequests===0&&c.resets===2});
for(const infoReadFFAt of [2,20,41])test('native lost response byte '+infoReadFFAt,'VERIFY /DIAG',9,{mode:8,infoReadFFAt,check:(c,m)=>c.responseReads===42&&!c.overreads&&c.saveRequests===0&&m.text.includes('INFO_CRC')});
test('INFO normal summary','INFO',0,{mode:8,check:(c,m)=>m.text.includes('api=1.0 boot_state=READY')&&m.text.includes('build=0123456789abcde+')&&!c.overreads});
test('fast reboot into ULTRAGS','ULTRAGS /SAVE',0,{rebootDownUs:1,check:c=>c.mode===8&&c.saves===1&&c.reboots===1});
test('fast reboot into GUS','GUS /SAVE',0,{mode:8,rebootDownUs:1,check:c=>c.mode===1&&c.saves===1&&c.reboots===1});
test('fast same-mode reboot proves changed session','ULTRAGS /SAVE /SLOT 1',0,{mode:8,rebootDownUs:1,slot:1,page3:0xfe,iff:0,turboInit:false,turboHardware:false,clobberDss:true,check:c=>c.mode===8&&c.saves===1&&c.reboots===1&&c.session===2n});
test('fast reboot fallback','ULTRAGS /SAVE',9,{rebootDownUs:1,fallback:true,check:c=>!c.saveRequests&&c.boot===2});
test('fast same-mode fallback','ULTRAGS /SAVE',9,{mode:8,rebootDownUs:1,fallback:true,check:c=>!c.saveRequests&&c.boot===2});
test('same-mode probe ESC never reboots','ULTRAGS /SAVE',10,{mode:8,escAfter:1,check:c=>!c.reboots&&!c.saveRequests});
test('global boot deadline includes slow selector','ULTRAGS /SAVE',8,{selectorDelayAfterRebootUs:600000,check:c=>!c.saveRequests&&c.now>=9000000&&c.now<11000000});
const unowned=new ConfigCard(catalog,{mode:8,ignoredReboot:true});unowned.response=[0,0,0,0,0,0];
test('same-mode does not consume or reset an unowned reply','ULTRAGS /SAVE',8,{card:unowned,check:c=>!c.responseReads&&!c.resets&&c.response.length===6&&!c.saveRequests});

test('mode','MODE ULTRAGS',0,{check:c=>c.mode===8&&c.reboots===1&&c.flash.mode===1});
test('same-mode-delayed-reboot','MODE ULTRAGS',0,{mode:8,rebootDelayUs:100000,check:c=>c.mode===8&&c.reboots===1&&!c.rebootAt});
test('old-fallback-delayed-reboot','MODE ULTRAGS',0,{boot:2,rebootDelayUs:100000,check:c=>c.mode===8&&!c.boot&&!c.rebootAt});
test('ignored-same-mode-reboot','MODE ULTRAGS',8,{mode:8,ignoredReboot:true,check:c=>c.reboots===1});
test('protocol-after-reboot','MODE ULTRAGS',3,{protocolAfterReboot:5});
test('catalog-fallback-after-reboot','MODE ULTRAGS',9,{catalogFailureAfterReboot:true,check:(c,m)=>m.text.includes('BOOT_FALLBACK')});
test('catalog-failure-handoff-info','INFO',3,{boot:5,check:(c,m)=>m.text.includes('CATALOG_INVALID')});
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
 ['GSALIAS ON',0,{mode:8,check:c=>c.gs}],['GSALIAS OFF',0,{mode:8}],['GSALIAS ON',9,{mode:1}],['SAVE',0,{check:c=>c.saves===1}],['SAVE',8,{busy:true,check:c=>!c.saves}],['MODE 8 /SAVE',9,{saveFail:true,check:c=>c.reboots===1&&c.mode===8&&c.flash.mode===1}],['SAVE',8,{saveTimeout:true}],
 ['/?',0,{noMutation:true}],['LIST /QUIET',0,{}],['PORTS 02A0 OFF /SAVE',0,{}],['INFO',2,{absent:true}],
])test(cli+' '+JSON.stringify(opts),cli,code,opts);
for(const state of [0,1,2,3])test('INFO bad CRC boot_state='+state,'VERIFY',9,{mode:8,bootState:state,badInfoCrc:true});
test('INFO bad CRC API','VERIFY',9,{mode:8,api:2,badInfoCrc:true});
test('MODE total boot/INFO deadline','MODE 8',8,{rebootDelayUs:8500000,notReady:true,check:c=>c.now>=9000000&&c.now<11000000});
for(const cli of ['BOGUS','MODE','MODE 256','MODE 0x100','PORTS 01E0 OFF','PORTS 02A1 OFF','PORTS 0400 OFF','PORTS 0280 0280','GSALIAS X','GSALIAS ON /SAVE','INFO /SLOT:2','INFO /BASE:06A0','/WHAT','INFO EXTRA','/SAVE','/SLOT','/SLOT 2','/SLOT 00','/SLOT 1X','GUS EXTRA'])test('syntax '+cli,cli,1,{noMutation:true});
for(const [name,mut] of [
 ['crc',c=>c[144]^=1],['major',c=>c[4]=2],['minor',c=>c[5]=1],['count',c=>c[6]=7],['duplicate',c=>c[32]=1],['reserved',c=>c[18]=1],['flags',c=>c[17]=5],['absent-nonzero',c=>c[16+6*16+4]=1],['overlap',c=>c.copy(c,36,20,24)],['bounds',c=>c.writeUInt32LE(0x1ff000,20)],['short-image',c=>c.writeUInt32LE(263,24)],
]){
 const c=Buffer.from(catalog);mut(c);if(name!=='crc')c.writeUInt32LE(crc32(c.subarray(0,144)),144);
 test('catalog-'+name,'MODE 8',3,{catalog:c,invalidRaw:true,noMutation:true});
 test('recovery-'+name,'INFO',3,{catalog:c,invalidRaw:true,boot:5,noMutation:true,check:(c,m)=>m.text.includes('CATALOG_INVALID')});
}
for(const every of [2,3,7]) {
 const card=new ConfigCard(catalog,{catalogReadFFEvery:every});
 test('late catalogue sample MODE '+every,'ULTRAGS /SAVE',3,{card,check:(c,m)=>c.mode===8&&c.index===148&&c.saveRequests===0&&c.reboots===1&&m.text.includes('CATALOG_HEADER')});
 test('late catalogue sample INFO '+every,'INFO /DIAG',3,{card,check:(c,m)=>c.saveRequests===0&&c.reboots===1&&m.text.includes('active=08 ULTRAGS')&&m.text.includes('catalog read/header=01')});
 test('late catalogue sample LIST '+every,'LIST /DIAG',3,{card,check:c=>c.saveRequests===0&&c.reboots===1});
}
const persistent=new ConfigCard(catalog,{mode:8});
test('volatile-on','GSALIAS ON',0,{card:persistent});test('save-volatile','SAVE',0,{card:persistent});persistent.powerCycle();test('powercycle-info','INFO',0,{card:persistent,check:c=>c.mode===8&&c.desired===8&&c.base===0x2a0&&!c.gs});
test('mode-no-save','MODE GUS',0,{card:persistent,check:c=>c.mode===1&&c.flash.mode===8});persistent.powerCycle();test('powercycle-persisted-mode','VERIFY',0,{card:persistent,check:c=>c.mode===8&&c.desired===8&&!c.gs});
const cycle=new ConfigCard(catalog);
test('workflow-save-ultra','ULTRAGS /SAVE',0,{card:cycle,check:c=>c.saveRequests===1&&c.flash.mode===8});cycle.powerCycle();
test('workflow-power-ultra','',0,{card:cycle,check:c=>c.mode===8});
test('workflow-save-gus','GUS /SAVE',0,{card:cycle,check:c=>c.saveRequests===2&&c.flash.mode===1});cycle.powerCycle();
test('workflow-power-gus','VERIFY',0,{card:cycle,check:c=>c.mode===1});
for(const r of results)if(r.ok&&r.expected!==0&&!/^RESULT FAIL code=\d+ reason=[A-Z0-9_]+\r?$/m.test(r.text)){
 r.ok=false;r.errors.push('RESULT failure footer must contain one stable reason token');
}
const hash=b=>createHash('sha256').update(b).digest('hex');
mkdirSync(join(build,'ultrags/logs'),{recursive:true});writeFileSync(join(build,'ultrags/logs/s2-run.json'),JSON.stringify({results,scriptSha256:hash(readFileSync(new URL(import.meta.url))),catalogSha256:hash(catalog),productionTraceSha256:hash(readFileSync(join(build,'host/config-exchange.json'))),productionInputsSha256:hash(readFileSync(join(build,'host/config-exchange-inputs.json'))),executed:[{name:'UGCFG.EXE',size:bytes.length,sha256:hash(bytes)}]},null,2));
process.exit(results.every(r=>r.ok)?0:1);
