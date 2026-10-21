// SPDX-License-Identifier: GPL-2.0-or-later
// Actual Z80 native MOD4 regression evidence. Full GS/audio conformance remains open.
import {readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {PcmCard} from './pcm-card.mjs';
import {verifyBuild,executionInputs,sha256} from '../../../tools/ultrags/build-evidence.mjs';
const root=resolve(process.argv[2]||'.'),build=resolve(process.argv[3]||'build'),out=join(build,'s7-dss-evidence.json');
rmSync(out,{force:true});
const before=executionInputs(root),assembly=verifyBuild(root,join(build,'ultrags/dss'));
const catalog=readFileSync(process.env.UG_S2_CATALOG||join(build,'host/s2-catalog.bin'));
const Z80=loadZ80(root),results=[],executed=new Map();
const vectorPath=join(build,'host/s7/s7-commands.jsonl'),vectors=readFileSync(vectorPath),shared=new PcmCard(catalog);
shared.session=17n;let sharedCount=0;
for(const line of vectors.toString().trim().split('\n')){
 const f=JSON.parse(line);sharedCount++;
 if('render'in f){shared.render(f.render);continue;}
 if(f.data){for(const b of Buffer.from(f.data,'hex'))shared.writePort(shared.base+0x13,b);continue;}
 const [status,r]=shared.command(f.op,Buffer.from(f.q,'hex')),expected=Buffer.from(f.r,'hex'),mask=f.mask?Buffer.from(f.mask,'hex'):Buffer.alloc(expected.length,255);
 if(status!==f.status||r.length!==expected.length||r.some((b,i)=>(b&mask[i])!==(expected[i]&mask[i])))throw Error('S7 C/model mismatch '+JSON.stringify({f,status,r:r.toString('hex')}));
 if([32,34].includes(f.op)&&!status){shared.transfer.granted=true;shared.transfer.last=shared.now;}
}
console.log(`PASS S7 production C/independent model: ${sharedCount} vectors`);
function mod4(signature='M.K.',patterns=1){
 const b=Buffer.alloc(1084+patterns*1024+1024);b.write(signature,1080);b[950]=1;b[953]=patterns-1;
 b.writeUInt16BE(512,42);b[45]=64;b.writeUInt16BE(512,48);
 b[1084]=1;b[1085]=0xac;b[1086]=0x10;b.fill(64,1084+patterns*1024);return b;
}
function test(name,app,cli,expected=0,o={}){
 const bytes=readFileSync(join(build,'ultrags/dss',app+'.EXE')),h=parseExe(bytes),card=o.card??new PcmCard(catalog,o),callsBefore=card.calls.length;
 executed.set(app,{name:app+'.EXE',size:bytes.length,sha256:sha256(bytes)});
 const m=new SprinterMachine({card,cardSlot:o.slot??0,commandLine:cli,files:o.files??{},disk:o.disk??{},movingClock:!o.stopped,
  clockStart:86399,escAfter:o.escAfter??Infinity,turboInit:o.turbo??true,turboHardware:o.hardware??true,page3Init:o.page3??3,logLimit:1000});
 const listing=readFileSync(join(build,'ultrags/dss',app.toLowerCase()+'.lst'),'utf8');
 for(const line of listing.split('\n')){const x=line.match(/\+*([0-9A-F]{4})\s+UG_CRC32(?:_FOLD)?:\s*$/);if(x)m.crcEntries.add(parseInt(x[1],16));}
 const call=m.dssCall.bind(m);m.dssCall=st=>{o.onDss?.(st,card,m);const v=call(st);if(v!=='exit'){if(st.c!==0x15)st.ix=0xdead;st.iy=0xbeef;}return v;};
 m.mem.set(bytes,h.loadAddr);const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:o.iff??1,budget:o.budget??150000000});card.tickUs(3000);
 const errors=[...m.violations];
 if(m.maxDiUs>=10000||m.maxWindowUs>=10000)errors.push('ISA/DI budget');
 if(m.page3!==m.page3Init||m.system!==m.systemInit||!!r.end.iff1!==!!(o.iff??1)||r.end.sp!==h.stack-2)errors.push('context');
 if(m.turboWrites&&!m.turbo)errors.push('DSS Turbo');if(m.fileHandles.size)errors.push('file leak');
 if(expected===1||cli==='/?')if(m.turboWrites||card.calls.length!==callsBefore)errors.push('hardware touched for syntax/help');
 if(!expected&&!/VERIFY/.test(cli)&&m.crcCalls)errors.push('host CRC in FAST');
 if(o.check&&!o.check(card,m))errors.push('postcondition');
 const pass=r.exitCode===expected&&m.text.includes(`RESULT ${expected?'FAIL':'PASS'} code=${expected}`)&&!errors.length;
 results.push({name,pass,expected,exit:r.exitCode,text:m.text,errors,maxWindowUs:m.maxWindowUs,maxDiUs:m.maxDiUs,steps:r.steps});
 console.log(`${pass?'PASS':'FAIL'} S7 ${name}`);if(!pass)throw Error(JSON.stringify(results.at(-1)));return {card,m};
}
let {card}=test('verified MOD4 upload','UGLOAD','FOUR.MOD /TYPE:MOD /VERIFY',0,{files:{'FOUR.MOD':mod4()},check:c=>c.objects.get(1)?.kind===3&&c.objects.get(1).state===1});
test('native playback by persistent handle','UGPLAY','HANDLE 1 /LOOP',0,{card,check:c=>c.foreground?.tracker&&c.objects.get(1).pins===1});
const firstPlay=card.foreground.id;
test('active foreground requires REPLACE','UGPLAY','HANDLE 1 /LOOP',7,{card,check:c=>c.foreground?.id===firstPlay});
test('same MOD handle repeats with REPLACE','UGPLAY','HANDLE 1 /LOOP /REPLACE',0,{card,check:c=>c.foreground?.id!==firstPlay&&c.objects.get(1).pins===1});
test('MOD snapshot monitor','UGMON','/COUNT:1 /HZ:10',0,{card,check:(c,m)=>c.foreground?.tracker&&m.text.includes('order,row,tick,speed,bpm=0,')&&m.text.includes(',6,125')});
test('pause freezes instance','UGPLAY','PAUSE',0,{card,check:c=>c.foreground?.paused});
const position=[card.foreground.tracker.order,card.foreground.tracker.row,card.foreground.tracker.tick];
test('paused snapshot unchanged','UGMON','/COUNT:2 /HZ:10',0,{card,check:c=>JSON.stringify(position)===JSON.stringify([c.foreground.tracker.order,c.foreground.tracker.row,c.foreground.tracker.tick])});
test('paused foreground requires REPLACE','UGPLAY','HANDLE 1',7,{card});
test('resume same handle','UGPLAY','RESUME',0,{card,check:c=>c.foreground&&!c.foreground.paused});
test('MOD handle ignores GAIN rejected','UGPLAY','HANDLE 1 /GAIN:32 /REPLACE',3,{card,check:c=>c.objects.size===1&&c.objects.get(1).pins===1});
test('STOP retains READY','UGPLAY','STOP',0,{card,check:c=>!c.foreground&&c.objects.get(1).state===1&&!c.objects.get(1).pins});
test('explicit FREE','UGMEM','FREE 1',0,{card,check:c=>!c.objects.size});
for(const cli of ['FOUR.MOD /GS','FX FOUR.MOD','FOUR.MOD /GAIN:32','FOUR.MOD /PAN:1'])test('unsupported option before hardware '+cli,'UGPLAY',cli,1);
for(const app of ['UGLOAD','UGPLAY','UGMON'])test(app+' help',''+app,'/?');
test('BLOB type marker regression','UGLOAD','TEST.BIN /TYPE:BLOB',0,{files:{'TEST.BIN':Buffer.alloc(16,42)},check:c=>c.objects.get(1)?.kind===0});
test('no MOD capability before ALLOC','UGLOAD','FOUR.MOD /TYPE:MOD',3,{noCaps:true,files:{'FOUR.MOD':mod4()},check:c=>!c.objects.size&&!c.calls.includes(16)});
for(const [name,change] of [
 ['wrong signature',b=>b.write('8CHN',1080)],['invalid active order',b=>b[952]=128],['volume',b=>b[45]=65],
 ['loop start',b=>b.writeUInt16BE(512,46)],['truncated sample',b=>b.subarray(0,b.length-1)],['short header',b=>b.subarray(0,1083)]]){
 const data=mod4(),changed=change(data),b=Buffer.isBuffer(changed)?changed:data;
 test('FORMAT cleanup '+name,'UGLOAD','BAD.MOD /TYPE:MOD',6,{files:{'BAD.MOD':b},check:c=>!c.objects.size});
}
test('M!K! direct file','UGPLAY','FOUR.MOD /LOOP',0,{files:{'FOUR.MOD':mod4('M!K!')},check:c=>c.foreground?.tracker});
test('65 stored patterns / verified source above 64KiB','UGLOAD','LARGE.MOD /TYPE:MOD /VERIFY',0,{files:{'LARGE.MOD':mod4('M.K.',65)},budget:450000000,check:c=>c.objects.get(1)?.mod.sampleOffset===1084+65*1024});
test('file read error cleans upload','UGPLAY','FOUR.MOD',5,{files:{'FOUR.MOD':mod4()},disk:{shortRead:0},check:c=>!c.objects.size});
test('lost PLAY_MOD reply reconciled once','UGPLAY','FOUR.MOD /LOOP',0,{files:{'FOUR.MOD':mod4()},noReplyOp:49,check:c=>c.calls.filter(op=>op===49).length===1&&c.foreground?.tracker});
test('WAIT ESC stops own MOD','UGPLAY','FOUR.MOD /WAIT /LOOP',10,{files:{'FOUR.MOD':mod4()},onDss:(st,c,m)=>{if(st.c===0x31&&c.foreground)m.escAfter=0;},check:c=>!c.foreground&&c.objects.get(1).state===1&&!c.objects.get(1).pins});
const f00=mod4();f00[1086]|=15;f00[1087]=0;
({card}=test('F00 becomes foreground PAUSE','UGPLAY','FOUR.MOD /F00:PAUSE',0,{files:{'FOUR.MOD':f00},check:c=>c.foreground?.paused}));
test('F00 RESUME is accepted','UGPLAY','RESUME',0,{card,check:c=>c.foreground&&!c.foreground.paused});
for(const slot of [0,1])for(const iff of [0,1])for(const turbo of [false,true])for(const hardware of [false,true]){
 const o={slot,iff,turbo,hardware,page3:0x71+slot},tag=`${slot}/${iff}/${turbo}/${hardware}`;
 const {card}=test('file/handle context '+tag,'UGPLAY',`FOUR.MOD /LOOP /SLOT:${slot}${iff?' /SLOW':''}`,0,{...o,files:{'FOUR.MOD':mod4()},check:c=>c.foreground?.tracker&&c.objects.get(1).pins===1});
 test('monitor context '+tag,'UGMON',`/COUNT:1 /SLOT:${slot}`,0,{...o,card});
 test('STOP context '+tag,'UGPLAY',`STOP /SLOT:${slot}`,0,{...o,card,check:c=>!c.foreground&&!c.objects.get(1).pins});
}
if(JSON.stringify(before)!==JSON.stringify(executionInputs(root)))throw Error('S7 runner inputs changed during execution');
verifyBuild(root,join(build,'ultrags/dss'));
mkdirSync(build,{recursive:true});writeFileSync(out,JSON.stringify({status:'PASS',stage_status:'IN_PROGRESS',
 scope:'Native MOD4 review regressions only; full GS 1.05/effect audio conformance remains pending',inputs:before,buildInputs:assembly.inputs,
 catalogSha256:sha256(catalog),sharedCount,sharedSha256:sha256(vectors),executed:[...executed.values()],results},null,2)+'\n');
console.log(`S7 native MOD4 ${results.length}/${results.length} actual-EXE + ${sharedCount} C/model PASS; S7 IN_PROGRESS / GS PENDING / REAL_PENDING`);
