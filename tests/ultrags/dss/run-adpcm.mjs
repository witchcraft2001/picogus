// SPDX-License-Identifier: GPL-2.0-or-later
// Actual DSS EXEs against production C with WAV IMA ADPCM (format 0x11)
// fixtures from tools/ultrags/gen-adpcm.py. The DSS client is unchanged:
// the card parses the WAV, so UGLOAD/UGPLAY/UGDUMP must work as for PCM WAV.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {NativeCard} from './native-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {crc32} from './config-card.mjs';
import {verifyBuild,executionInputs,sha256} from '../../../tools/ultrags/build-evidence.mjs';
const root=resolve(process.argv[2]??'.'),build=resolve(process.argv[3]??'build');
const assembly=verifyBuild(root,join(build,'ultrags/dss')),before=executionInputs(root),results=[],images={};
const manifestPath=join(build,'native/native-card-build.json'),manifest=JSON.parse(readFileSync(manifestPath));
for(const [p,h]of Object.entries(manifest.inputs))assert.equal(sha256(readFileSync(p)),h);
assert.equal(sha256(readFileSync(join(build,'native/native-card.node'))),manifest.artifact);
const Z80=loadZ80(root),catalog=readFileSync(join(build,'host/s2-catalog.bin'));
function card(){return new NativeCard(catalog,{addon:join(build,'native/native-card.node')});}
function run(app,cli,o={}) {
 const c=o.card??card(),bytes=readFileSync(join(build,'ultrags/dss',app+'.EXE')),h=parseExe(bytes);images[app]=sha256(bytes);
 const m=new SprinterMachine({card:c,cardSlot:o.slot??0,commandLine:cli,movingClock:true,files:o.files??{},page3Init:0x71,logLimit:100});
 m.mem.set(bytes,h.loadAddr);const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:o.iff??1,budget:500000000});
 assert.equal(r.exitCode,o.expected??0,app+' '+cli+'\n'+m.text);assert.deepEqual(m.violations,[]);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(m.fileHandles.size,0);
 assert(m.maxDiUs<10000&&m.maxWindowUs<10000);assert.equal(m.residentWrites,0);
 results.push({app,cli,exit:r.exitCode,text:m.text,slot:o.slot??0,iff:o.iff??1,maxDiUs:m.maxDiUs,maxWindowUs:m.maxWindowUs,steps:r.steps});
 console.log('PASS ADPCM actual EXE',app,cli);return {card:c,m};
}
function objectInfo(c,handle){return c.command(18,Buffer.from([handle&255,handle>>8]))[1];}

const fixtures=join(build,'host/adpcm/fixtures');
for(const slot of [0,1])for(const iff of [0,1])for(const name of ['M11K','S22K']) {
 const data=readFileSync(join(fixtures,name.toLowerCase()+'.wav')),file=name+'.WAV',files={[file]:data};
 const suffix=` /SLOT:${slot}`,opts={files,slot,iff};
 const {card:c,m}=run('UGLOAD',file+' /TYPE:WAV /VERIFY'+suffix,opts);
 assert.match(m.text,/handle=0x0001/);
 const info=objectInfo(c,1);
 assert.equal(info[2],2);assert.equal(info[3],1);assert.equal(info[35],4);assert.equal(info[36],3);
 assert.equal(info[34],name[0]==='S'?2:1);assert.equal(info.readUInt32LE(14),crc32(data));
 run('UGPLAY','HANDLE 1 /WAIT'+suffix,{card:c,slot,iff});assert.equal(c.command(80)[1][24],3);
 run('UGPLAY','FXHANDLE 1 /WAIT'+suffix,{card:c,slot,iff});
 const dump=run('UGDUMP','1 BACK.WAV /VERIFY'+suffix,{card:c,slot,iff});assert(dump.m.files.get('BACK.WAV').equals(data));
 run('UGMEM','FREE 1'+suffix,{card:c,slot,iff});assert.equal(c.command(2)[1].readUInt16LE(16),0);
 const direct=run('UGPLAY',file+' /WAIT'+suffix,opts).card;assert.equal(direct.command(80)[1][24],3);
 run('UGPLAY','FX '+file+' /WAIT'+suffix,opts);
}
// A broken block layout is reported as a format error (exit 6), not played.
const broken=Buffer.from(readFileSync(join(fixtures,'m11k.wav')));broken[32]=34;
for(const slot of [0,1]) {
 run('UGLOAD',`BAD.WAV /TYPE:WAV /SLOT:${slot}`,{files:{'BAD.WAV':broken},slot,expected:6});
 run('UGPLAY',`BAD.WAV /SLOT:${slot}`,{files:{'BAD.WAV':broken},slot,expected:6});
}
assert.deepEqual(executionInputs(root),before);assert.deepEqual(verifyBuild(root,join(build,'ultrags/dss')),assembly);
writeFileSync(join(build,'host/adpcm/dss-evidence.json'),JSON.stringify({status:'HOST_ACTUAL_EXE_PASS / REAL_PENDING',runnerSha256:sha256(readFileSync(new URL(import.meta.url))),assembly,inputs:before,images,adapterSha256:sha256(readFileSync(manifestPath)),results},null,2)+'\n');
console.log('ADPCM',results.length,'actual EXE scenarios PASS');
