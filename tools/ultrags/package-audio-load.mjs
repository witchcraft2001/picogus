// SPDX-License-Identifier: GPL-2.0-or-later
// Freeze matching executed kits; publish the firmware + three changed tools.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {repoRoot,verifyExecution,verifyBuild,sha256} from './build-evidence.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
import {readZip,readFat12} from './verify-package.mjs';
const builds=[resolve(process.argv[2]||'build/cfg-native-a'),resolve(process.argv[3]||'build/cfg-native-b')];
const prior=resolve(process.argv[4]||'build/ugtest-cli-review'),out=resolve(process.argv[5]||'build/audio-load-review');
const changed=['UGDUMP.EXE','UGLOAD.EXE','UGPLAY.EXE'],old=readZip(readFileSync(join(prior,'ug-cfg.zip'))),proofs=[];
const priorFw=readFileSync(join(prior,'PGMULTI.UF2')),flash=Buffer.alloc(0x200000,255);
for(let i=0;i<priorFw.length;i+=512){const offset=priorFw.readUInt32LE(i+12)-0x10000000,n=priorFw.readUInt32LE(i+16);assert(offset>=0&&offset+n<=flash.length&&n<=476);priorFw.copy(flash,offset,i+32,i+32+n);}
for(const build of builds){
 const dir=join(build,'ultrags/dss'),execution=verifyExecution(repoRoot,dir),assembly=verifyBuild(repoRoot,dir);
 execFileSync(process.execPath,[join(repoRoot,'tools/ultrags/s7-report.mjs'),'--build',build,'--verify-only'],{stdio:'pipe'});
 const s7=JSON.parse(readFileSync(join(build,'s7-dss-evidence.json')));
 const actual=assembly.files.filter(x=>old.get(x.name)&&sha256(old.get(x.name))!==x.sha256).map(x=>x.name);
 assert.deepEqual(actual,changed);assert.equal(assembly.files.length,old.size?[...old.keys()].filter(n=>n.endsWith('.EXE')).length:0);
 const audio=JSON.parse(readFileSync(join(build,'host/audio-render.json')));
 assert.equal(audio.status,'LINKED_AUDIO_INSTRUCTION_PASS / REAL_PENDING');assert.equal(audio.cases.length,6);
 assert(audio.cases.every(c=>!c.division64Calls&&c.independentOracle==='PASS'&&c.baseline&&c.baseline.outputSha256===c.outputSha256&&c.instructionRatio>1));
 const speed=JSON.parse(readFileSync(join(build,'ultrags/throughput/throughput.json')));
 const comparisons=speed.results.filter(c=>c.name.includes('file comparison'));
 assert.equal(comparisons.length,4);assert(comparisons.every(c=>c.ok));
 assert(comparisons.filter(c=>c.verify).every(c=>c.instructionCycleRatio>1.1));
 const mapping=JSON.parse(readFileSync(join(build,'multifw-release/generated/multifw/flash-map.json'))),images=[];
 for(const image of mapping.images.filter(x=>x.mode!==8)){
  const record=0x7c00+16+16*(image.mode-1),offset=flash.readUInt32LE(record+4),length=flash.readUInt32LE(record+8);
  assert.equal(flash[record],image.mode);
  const previous=flash.subarray(offset,offset+length),current=readFileSync(join(build,'multifw-release',image.name+'-multifw.bin'));
  assert.deepEqual(current,previous,'changed legacy firmware '+image.name);images.push({mode:image.mode,sha256:sha256(current)});
 }
 proofs.push({build,execution,assembly:assembly.files,unchangedLegacyImages:images,arm:audio.cases,fileComparisons:comparisons,nativeS7Checks:s7.results.length,nativeS7SharedVectors:s7.sharedCount});
}
assert.deepEqual(proofs[0].assembly,proofs[1].assembly);
for(const name of ['ug-cfg.zip','ug-cfg.img','PGMULTI.UF2'])assert.equal(sha256(readFileSync(join(builds[0],'ultrags/cfg-package',name))),sha256(readFileSync(join(builds[1],'ultrags/cfg-package',name))));
const payload=new Map(changed.map(name=>[name,readFileSync(join(builds[0],'ultrags/dss',name))]));
payload.set('TESTER.TXT',readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/AUDIO-LOAD-TEST.md')));
payload.set('HASHES.TXT',Buffer.from([...payload].map(([n,d])=>`${sha256(d)}  ${n}`).join('\r\n')+'\r\n'));
const entries=[...payload].sort(([a],[b])=>a.localeCompare(b));
const containers={'ug-host.zip':makeZip(entries),'ug-host.img':makeImg(entries)};
for(const [name,data] of Object.entries(containers))assert.deepEqual([...(name.endsWith('.zip')?readZip(data):readFat12(data))],entries);
mkdirSync(out);
for(let i=0;i<2;i++){
 const evidence=join(out,'evidence',i?'B':'A');mkdirSync(evidence,{recursive:true});cpSync(join(builds[i],'ultrags/cfg-package'),join(evidence,'kit'),{recursive:true});
 for(const [name,path] of [['EXE-RUN.json','ultrags/logs/ugdiag-run.json'],['ASSEMBLY.json','ultrags/dss/asm-manifest.json'],['AUDIO-ARM.json','host/audio-render.json'],['S6-HOST.json','host/s6/s6-host-evidence.json'],['FILE-SPEED.json','ultrags/throughput/throughput.json']])writeFileSync(join(evidence,name),readFileSync(join(builds[i],path)));
 for(const [name,path] of [['S7-EXE.json','s7-dss-evidence.json'],['S7-HOST.json','host/s7/s7-host-evidence.json']])writeFileSync(join(evidence,name),readFileSync(join(builds[i],path)));
}
for(const e of proofs[0].assembly.filter(x=>!x.name.startsWith('ST-')))writeFileSync(join(out,e.name),readFileSync(join(builds[0],'ultrags/dss',e.name)));
for(const name of ['ug-cfg.zip','ug-cfg.img','PGMULTI.UF2'])writeFileSync(join(out,name),readFileSync(join(builds[0],'ultrags/cfg-package',name)));
for(const [name,data] of [...payload,...Object.entries(containers)])writeFileSync(join(out,name),data);
const files=['PGMULTI.UF2',...changed,...Object.keys(containers),'ug-cfg.zip','ug-cfg.img'].map(name=>{const data=readFileSync(join(out,name));return {name,size:data.length,sha256:sha256(data)};});
writeFileSync(join(out,'DELIVERY.json'),JSON.stringify({status:'HOST/DSS/linked-ARM PASS / concurrent REAL_PENDING; S6/S7 IN_PROGRESS',firmwareChanged:true,changedExes:changed,independentMatch:true,proofs,files,
 packagingSha256:sha256(readFileSync(new URL(import.meta.url))),limits:['Instruction counts and peripheral models do not certify physical render deadlines','Mixer scale/rounding preserved; existing material clipping is not silently normalized','No speed claim in physical bytes/s until matching card run']},null,2)+'\n');
console.log('Independent firmware/EXE/ZIP/IMG identity and unchanged six legacy modes PASS:',out);
