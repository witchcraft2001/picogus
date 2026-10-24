// SPDX-License-Identifier: GPL-2.0-or-later
// Execute native/GS clients against production C, inspecting the actual wire.
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
  if(o.noS3m&&(op&127)===1){
   if(ri===6)v&=~128;
   if(ri<2+rlen)reply.push(v);
   else if(op&128)v=(crc32(Buffer.from(reply))>>>((ri-2-rlen)*8))&255;
  }ri++;
 }return v;};
 const fn=m.dssCall.bind(m);m.dssCall=st=>{const r=fn(st);if(r!=='exit'){if(st.c!==0x15)st.ix=0xdead;st.iy=0xbeef;}return r;};
 m.mem.set(bytes,h.loadAddr);const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:o.iff??1,budget:500000000});
 c.writePort=wr;c.readPort=rd;
 assert.equal(r.exitCode,o.expected??0,app+' '+cli+'\n'+m.text);assert.deepEqual(m.violations,[]);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!r.end.iff1,!!(o.iff??1));assert.equal(r.end.sp,h.stack-2);assert.equal(m.fileHandles.size,0);
 assert(m.maxDiUs<10000&&m.maxWindowUs<10000);
 if(o.expected===1&&!o.handleSyntax){assert.equal(m.turboWrites,0);assert.equal(requests.length,0);}
 if(o.noS3m)assert(!requests.some(r=>[16,49,50].includes(r.op)),'CAPS must reject before allocation/replacement');
 for(const req of requests.filter(r=>r.op===49))assert.equal(Buffer.from(req.request,'hex')[2]&6,0,'S3M must never get MOD F00 flags');
 assert.equal(m.residentWrites,0);assert(m.minSpSeen>=0xbd90);
 results.push({app,cli,exit:r.exitCode,text:m.text,requests,slot:o.slot??0,iff:o.iff??1,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs,steps:r.steps});
 console.log('PASS S3M actual EXE',app,cli);return {card:c,m};
}

const fixtures=join(build,'host/s3m/fixtures');
for(const slot of [0,1])for(const iff of [0,1])for(const name of ['MOU8','STU16','M32','S16']) {
 const data=readFileSync(join(fixtures,name+'.S3M')),files={[name+'.S3M']:data},suffix=` /SLOT:${slot}`,opts={files,slot,iff};
 const {card:c}=run('UGPLAY',name+'.S3M /LOOP /VERIFY'+suffix,opts);c.tickUs(10000);
 const info=c.command(18,Buffer.from([1,0]))[1];assert.equal(info[2],5);assert.equal(info.readUInt32LE(14),crc32(data));
 const snap=c.command(80)[1];assert.equal(snap[25],2);assert.equal(snap.readUInt16LE(26),name==='M32'?32:name==='S16'?16:1);
 run('UGPLAY','PAUSE'+suffix,{card:c,slot,iff});run('UGPLAY','RESUME'+suffix,{card:c,slot,iff});
 const {m}=run('UGDUMP','1 BACK.S3M /VERIFY'+suffix,{card:c,slot,iff});assert(m.files.get('BACK.S3M').equals(data));
 run('UGMON','/COUNT:2'+suffix,{card:c,slot,iff});
 run('UGPLAY','STOP'+suffix,{card:c,slot,iff});run('UGMEM','FREE 1'+suffix,{card:c,slot,iff});assert.equal(c.command(2)[1].readUInt16LE(16),0);
 const g=run('UGPLAY',name+'.S3M /GS /VERIFY'+suffix,opts).card;g.tickUs(10000);
 const handle=g.command(22)[1].readUInt16LE();assert.equal(g.command(18,Buffer.from([handle&255,handle>>8]))[1][2],5);
 run('UGPLAY','PAUSE'+suffix,{card:g,slot,iff});run('UGPLAY','RESUME'+suffix,{card:g,slot,iff});
 run('UGMON','/GS /COUNT:2'+suffix,{card:g,slot,iff});
 const dump=run('UGDUMP',handle+' BACK.S3M /VERIFY'+suffix,{card:g,slot,iff});assert(dump.m.files.get('BACK.S3M').equals(data));
 run('UGPLAY','STOP'+suffix,{card:g,slot,iff});run('UGMEM','FREE '+handle+suffix,{card:g,slot,iff});assert.equal(g.command(2)[1].readUInt16LE(16),0);
}
const data=readFileSync(join(fixtures,'MOU8.S3M')),files={'T.S3M':data,'T.DAT':data};
for(const slot of [0,1]) {
 for(const cli of ['T.S3M /VERIFY','T.DAT /TYPE:S3M /VERIFY']) {
  const {card:c}=run('UGLOAD',cli+` /SLOT:${slot}`,{files,slot});assert.equal(c.command(18,Buffer.from([1,0]))[1][2],5);
  run('UGPLAY','HANDLE 1 /WAIT'+` /SLOT:${slot}`,{card:c,slot});assert.equal(c.command(80)[1][24],3);
  run('UGMEM','FREE 1'+` /SLOT:${slot}`,{card:c,slot});
 }
 run('UGPLAY',`T.DAT /TYPE:S3M /WAIT /SLOT:${slot}`,{files,slot});
 run('UGPLAY',`T.S3M /F00:IGNORE /SLOT:${slot}`,{files,slot,expected:1});
 run('UGPLAY',`T.S3M /F00:PAUSE /SLOT:${slot}`,{files,slot,expected:1});
 run('UGPLAY',`T.S3M /SLOT:${slot}`,{files,slot,noS3m:true,expected:3});
 run('UGLOAD',`T.S3M /SLOT:${slot}`,{files,slot,noS3m:true,expected:3});
 run('UGPLAY',`T.S3M /SLOT:${slot}`,{files:{'T.S3M':data.subarray(0,94)},slot,expected:6});
 run('UGPLAY',`T.S3M /GS /SLOT:${slot}`,{files:{'T.S3M':data.subarray(0,94)},slot,expected:6});
 run('UGPLAY',`T.S3M /SLOT:${slot}`,{files,slot,escAfter:10,expected:10});
}
assert.deepEqual(executionInputs(root),before);assert.deepEqual(verifyBuild(root,join(build,'ultrags/dss')),assembly);
writeFileSync(join(build,'host/s3m/dss-evidence.json'),JSON.stringify({status:'HOST_ACTUAL_EXE_PASS / REAL_PENDING',runnerSha256:sha256(readFileSync(new URL(import.meta.url))),assembly,inputs:before,images,adapterSha256:sha256(readFileSync(manifestPath)),results},null,2)+'\n');
console.log('S3M',results.length,'actual EXE scenarios PASS');
