// SPDX-License-Identifier: GPL-2.0-or-later
// Execute UGPLAY and UGPF against the production-C adapter, inspecting wire bytes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {NativeCard} from './native-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {crc32} from './config-card.mjs';
import {verifyBuild,executionInputs,sha256} from '../../../tools/ultrags/build-evidence.mjs';
import {makeF00Mod} from '../../../tools/ultrags/gen-f00.mjs';
const root=resolve(process.argv[2]??'.'),build=resolve(process.argv[3]??'build');
const assembly=verifyBuild(root,join(build,'ultrags/dss')),before=executionInputs(root),results=[],images={};
const manifestPath=join(build,'native/native-card-build.json'),manifest=JSON.parse(readFileSync(manifestPath));
for(const [p,h]of Object.entries(manifest.inputs))assert.equal(sha256(readFileSync(p)),h);
assert.equal(sha256(readFileSync(join(build,'native/native-card.node'))),manifest.artifact);
const Z80=loadZ80(root),catalog=readFileSync(join(build,'host/s2-catalog.bin'));
function card(){return new NativeCard(catalog,{addon:join(build,'native/native-card.node')});}
function run(app,cli,o={}) {
 const c=o.card??card(),bytes=readFileSync(join(build,'ultrags/dss',app+'.EXE')),h=parseExe(bytes);images[app]=sha256(bytes);
 const m=new SprinterMachine({card:c,cardSlot:o.slot??0,commandLine:cli,movingClock:true,files:o.files??{},page3Init:0x71,allowTurboBulkWrites:app==='UGPF',logLimit:100,escAfter:o.escAfter??Infinity});
 const wr=c.writePort.bind(c),rd=c.readPort.bind(c),requests=[];let packet=[],op=0,ri=0,rlen=0,reply=[];
 c.writePort=(p,v)=>{if(p===c.base+3){packet.push(v);if(packet.length===2+packet[1]+((packet[0]&128)?4:0)){op=packet[0];requests.push({op:op&127,request:Buffer.from(packet.slice(2,2+packet[1])).toString('hex')});ri=0;reply=[];packet=[];}}return wr(p,v);};
 c.readPort=p=>{let v=rd(p);if(p===c.base+3){
  if(ri===1)rlen=v;
  if(o.noPolicy&&(op&127)===1){
   if(ri===3)v&=~16;
   if(ri<2+rlen)reply.push(v);
   else if(op&128)v=(crc32(Buffer.from(reply))>>>((ri-2-rlen)*8))&255;
  }ri++;
 }return v;};
 const fn=m.dssCall.bind(m);m.dssCall=st=>{const r=fn(st);if(r!=='exit'){if(st.c!==0x15)st.ix=0xdead;st.iy=0xbeef;}return r;};
 m.mem.set(bytes,h.loadAddr);const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:1,budget:500000000});
 c.writePort=wr;c.readPort=rd;
 assert.equal(r.exitCode,o.expected??0,app+' '+cli+'\n'+m.text);assert.deepEqual(m.violations,[]);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert(r.end.iff1);assert.equal(r.end.sp,h.stack-2);assert.equal(m.fileHandles.size,0);
 assert(m.maxDiUs<10000&&m.maxWindowUs<10000);
 if(o.expected===1&&!o.handleSyntax){assert.equal(m.turboWrites,0);assert.equal(requests.length,0);}
 if(o.policy!==undefined){const plays=requests.filter(r=>r.op===49);assert.equal(plays.length,1);assert.equal(Buffer.from(plays[0].request,'hex')[2],o.policy|1);assert(m.text.includes('MOD F00='+ (o.policy===4?'PAUSE':'IGNORE')));}
 if(o.noPolicy){assert(m.text.includes('MOD_F00_POLICY_REQUIRES_NEW_FIRMWARE'));assert(!requests.some(r=>[16,49,50].includes(r.op)));}
 results.push({app,cli,exit:r.exitCode,text:m.text,requests,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs,steps:r.steps});
 console.log('PASS F00 actual EXE',app,cli);return {card:c,m};
}
for(const app of ['UGPLAY','UGPF']) {
 for(const channels of [4,8])for(const verify of ['', ' /VERIFY'])for(const [option,policy]of [['',2],[' /f00:ignore',2],[' /F00:pause',4]]) {
  const data=makeF00Mod(channels),{card:c}=run(app,'F00.MOD /LOOP'+option+verify,{files:{'F00.MOD':data},policy});
  c.tickUs(100000);const snap=c.command(80)[1];assert.equal(snap[24],policy===4?2:1);if(policy===4)assert.equal(snap[38],1);
  run(app,'HANDLE 1 /LOOP /REPLACE'+option+verify,{card:c,policy});c.tickUs(100000);assert.equal(c.command(80)[1][24],policy===4?2:1);
  const info=c.command(18,Buffer.from([1,0]))[1];assert.equal(info.readUInt32LE(14),crc32(data));assert.equal(info.readUInt16LE(4),1);
 }
 for(const cli of ['F00.MOD /F00:NO','F00.MOD /F00:','F00.MOD /F00:IGNORE /F00:IGNORE','F00.MOD /F00:IGNORE /F00:PAUSE','A.WAV /F00:IGNORE','A.RAW /F00:PAUSE','STREAM A.WAV /F00:IGNORE','FX F00.MOD /F00:PAUSE','FXHANDLE 1 /F00:IGNORE','STOP /F00:IGNORE','PAUSE /F00:IGNORE','RESUME /F00:PAUSE','FXSTOP ALL /F00:PAUSE','FXPAUSE 1 /F00:IGNORE','FXRESUME 1 /F00:PAUSE'])run(app,cli,{expected:1});
 const {card:c}=run(app,'F00.MOD /LOOP',{files:{'F00.MOD':makeF00Mod(4)},policy:2});c.tickUs(10000);const id=c.command(80)[1].readUInt16LE(20);
 run('UGLOAD','A.RAW /TYPE:RAW /RATE:48000 /BITS:8 /CH:1 /FMT:U8',{card:c,files:{'A.RAW':Buffer.alloc(32,192)}});
 run(app,'HANDLE 2 /REPLACE /F00:IGNORE',{card:c,expected:1,handleSyntax:true});assert.equal(c.command(80)[1].readUInt16LE(20),id);
 run(app,'HANDLE 1 /REPLACE',{card:c,noPolicy:true,expected:3});assert.equal(c.command(80)[1].readUInt16LE(20),id);
 run(app,'F00.MOD /REPLACE /F00:PAUSE',{card:c,noPolicy:true,files:{'F00.MOD':makeF00Mod(4)},expected:3});assert.equal(c.command(80)[1].readUInt16LE(20),id);
}
const originalPath=process.env.UG_F00_MOD,original=originalPath?{path:resolve(originalPath),sha256:sha256(readFileSync(originalPath))}:null;
if(original) {
 assert.equal(original.sha256,'024f4b4a2c4ab31524243dfaa389b7dd38b3af4d2cdd37d6cbf6efab03d70a8a');
 const data=readFileSync(originalPath);
 for(const app of ['UGPLAY','UGPF'])for(const option of ['', ' /F00:PAUSE']) {
  const {card:c}=run(app,'BST.MOD'+option,{files:{'BST.MOD':data}});c.tickUs(20000000);
  const snap=c.command(80)[1];assert.equal(snap[24],option?2:1);
  assert.equal(c.command(18,Buffer.from([1,0]))[1].readUInt32LE(14),crc32(data));
  if(option){assert.equal(snap.readUInt16LE(36),4);assert.equal(snap[38],55);run(app,'RESUME',{card:c});}
  c.tickUs(160000000);assert.equal(c.command(80)[1][24],3);
 }
 assert.equal(sha256(readFileSync(originalPath)),original.sha256);
}
assert.deepEqual(executionInputs(root),before);
mkdirSync(join(build,'evidence'),{recursive:true});
writeFileSync(join(build,'evidence/f00-exe.json'),JSON.stringify({status:'HOST_ACTUAL_EXE_PASS / REAL_PENDING',inputs:before,assembly,adapterSha256:sha256(readFileSync(manifestPath)),runnerSha256:sha256(readFileSync(new URL(import.meta.url))),original,fixtureGeneratorSha256:sha256(readFileSync(join(root,'tools/ultrags/gen-f00.mjs'))),images,results},null,2)+'\n');
console.log('PASS F00',results.length,'actual EXE scenarios');
