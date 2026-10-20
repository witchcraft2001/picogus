// SPDX-License-Identifier: GPL-2.0-or-later
// CRC-valid malformed held pages must not silently truncate enumeration.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {PcmCard,rawDescriptor} from './pcm-card.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from './ug-harness.mjs';
import {verifyBuild,sha256} from '../../../tools/ultrags/build-evidence.mjs';
const root=resolve(process.argv[2]??'.'),build=resolve(process.argv[3]??'build/voices-a');
const baseline=process.argv.includes('--previous');
const dir=join(build,'ultrags/dss');if(!baseline)verifyBuild(root,dir);
const bytes=readFileSync(join(dir,'UGMON.EXE')),h=parseExe(bytes),Z80=loadZ80(root),catalog=readFileSync(join(build,'host/s2-catalog.bin')),results=[];
for(const [name,op,total] of [['empty voice table',82,0],['half voice table',82,16],['truncated FX table',81,1]]){
 const card=new PcmCard(catalog);
 if(op===81){
  const q=Buffer.alloc(5);q[0]=1;q.writeUInt32LE(48000,1);const [e,r]=card.command(16,q);assert(!e);
  const object=card.objects.get(r.readUInt16LE());object.data.fill(192);object.uploaded=48000;
  assert(!card.command(20,Buffer.concat([r.subarray(0,2),rawDescriptor(48000)]))[0]);
  assert(!card.command(19,Buffer.concat([r.subarray(0,2),Buffer.alloc(5)]))[0]);
  const play=Buffer.from([r[0],r[1],255,255,128,1,128,2]);
  for(let i=0;i<2;i++)assert(!card.command(54,play)[0]);card.render(1);
 }
 const command=card.command.bind(card);let injected=0;
 card.command=(cmd,...args)=>{const result=command(cmd,...args);if(cmd===op&&!result[0]){
  const size=op===82?20:16,count=Math.min(Math.max(0,total-args[0].readUInt16LE(12)),result[1].readUInt16LE(14));
  result[1]=Buffer.from(result[1].subarray(0,20+count*size));result[1].writeUInt16LE(count,14);result[1].writeUInt16LE(total,16);injected++;
 }return result;};
 const m=new SprinterMachine({card,commandLine:'/COUNT:1',movingClock:true,logLimit:0});m.mem.set(bytes,h.loadAddr);
 const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,budget:30000000});
 assert(injected);assert.equal(r.exitCode,baseline?0:3,m.text);assert.deepEqual(m.violations,[]);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(m.fileHandles.size,0);
 results.push({name,exit:r.exitCode,text:m.text,injected});console.log('PASS held-page regression:',name,baseline?'previous accepted invalid total':'invalid total rejected');
}
if(!baseline){mkdirSync(join(build,'host/review'),{recursive:true});writeFileSync(join(build,'host/review/held-pages.json'),JSON.stringify({status:'PASS',scriptSha256:sha256(readFileSync(new URL(import.meta.url))),exeSha256:sha256(bytes),results},null,2)+'\n');}
