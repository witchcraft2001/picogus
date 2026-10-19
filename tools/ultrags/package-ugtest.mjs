// SPDX-License-Identifier: GPL-2.0-or-later
// Freeze two independently executed kits and a small UGTEST-only update.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {repoRoot,verifyExecution,verifyBuild,sha256} from './build-evidence.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
import {readZip,readFat12} from './verify-package.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {PcmCard} from '../../tests/ultrags/dss/pcm-card.mjs';
const builds=[resolve(process.argv[2]||'build/cfg-native-a'),resolve(process.argv[3]||'build/cfg-native-b')];
const prior=resolve(process.argv[4]||'build/save-clock-review'),out=resolve(process.argv[5]||'build/ugtest-cli-review');
const oldPayload=readZip(readFileSync(join(prior,'ug-cfg.zip'))),proofs=[];
const installedFirmware=readFileSync(join(prior,'PGMULTI.UF2'));
assert.equal(sha256(installedFirmware),'2b6c25aa2546cbf623b65fb338a37f6b51661d32772f4a6c890680b002634f6d');
const installedFlash=Buffer.alloc(0x200000,255);
for(let i=0;i<installedFirmware.length;i+=512){
 assert.equal(installedFirmware.readUInt32LE(i),0x0a324655);
 const address=installedFirmware.readUInt32LE(i+12)-0x10000000,n=installedFirmware.readUInt32LE(i+16);
 assert(address>=0&&address+n<=installedFlash.length&&n<=476);
 installedFirmware.copy(installedFlash,address,i+32,i+32+n);
}
const installedMap=JSON.parse(readFileSync(join(prior,'evidence/A/kit/FLASHMAP.JSN')));
for(const build of builds){
 const dir=join(build,'ultrags/dss'),execution=verifyExecution(repoRoot,dir),assembly=verifyBuild(repoRoot,dir);
 const s6=JSON.parse(readFileSync(join(build,'ultrags/logs/s6-run.json')));
 assert(s6.results.length&&s6.results.every(x=>x.ok));
 assert(s6.results.some(x=>x.name==='UGTEST native dispatch " PCM"'&&x.exit===0));
 assert(s6.results.some(x=>x.name==='UGTEST native dispatch "/SLOT:0 PCM"'&&x.exit===0));
 assert(s6.results.some(x=>x.name==='UGTEST invalid dispatch "PCMX"'&&x.exit===1));
 const changed=assembly.files.filter(e=>oldPayload.get(e.name)&&sha256(oldPayload.get(e.name))!==e.sha256).map(e=>e.name);
 assert.deepEqual(changed,['UGTEST.EXE'],'only UGTEST must change');
 for(const e of assembly.files)assert(oldPayload.has(e.name),'unexpected EXE '+e.name);
 const bundle=readFileSync(join(build,'ultrags/cfg-package/PGMULTI.UF2'));
 // A new repository commit changes UG_BUILD_ID even for host-only edits.
 // Keep the physically accepted UF2 in the delivery; prove that the rebuilt
 // executable images differ only in that 16-byte identity, not ARM code/data.
 const imageComparison=[];
 for(const image of installedMap.images){
  const old=installedFlash.subarray(image.offset,image.offset+image.length);
  const rebuilt=readFileSync(join(build,'multifw-release',image.name+'-multifw.bin'));
  assert.equal(rebuilt.length,old.length);
  let identity=null;
  const normalized=Buffer.from(rebuilt);
  if(image.mode===8&&!old.equals(rebuilt)){
   const oldId=Buffer.from('52282713ccc7522+'),offset=old.indexOf(oldId);
   assert(offset>=0&&old.indexOf(oldId,offset+1)<0);
   const newId=rebuilt.subarray(offset,offset+16).toString('ascii');
   assert.match(newId,/^[0-9a-f]{15}\+$/);
   identity={offset,old:oldId.toString('ascii'),rebuilt:newId};
   oldId.copy(normalized,offset);
  }
  assert.deepEqual(normalized,old,'firmware change beyond UG_BUILD_ID: '+image.name);
  imageComparison.push({mode:image.mode,name:image.name,installedSha256:sha256(old),rebuiltSha256:sha256(rebuilt),identity});
 }
 proofs.push({build,execution,assembly:assembly.files,s6Checks:s6.results.length,
  s6ReportSha256:sha256(readFileSync(join(build,'ultrags/logs/s6-run.json'))),rebuiltFirmwareSha256:sha256(bundle),imageComparison});
}
assert.deepEqual(proofs[0].assembly,proofs[1].assembly);
for(const name of ['ug-cfg.zip','ug-cfg.img','PGMULTI.UF2'])
 assert.equal(sha256(readFileSync(join(builds[0],'ultrags/cfg-package',name))),sha256(readFileSync(join(builds[1],'ultrags/cfg-package',name))));
// Reproduce the released EXE failure, then run the exact replacement bytes.
const Z80=loadZ80(repoRoot),catalog=readFileSync(join(builds[0],'host/s2-catalog.bin')),reproduction=[];
const newExe=readFileSync(join(builds[0],'ultrags/dss/UGTEST.EXE'));
for(const [version,exe] of [['old',oldPayload.get('UGTEST.EXE')],['new',newExe]])for(const cli of ['PCM',' PCM','\tFX','/SLOT:0 PCM']){
 const h=parseExe(exe),card=new PcmCard(catalog),m=new SprinterMachine({card,commandLine:cli,movingClock:true,logLimit:1000});
 m.mem.set(exe,h.loadAddr);const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:1,budget:100000000});
 assert.equal(run.exitCode,version==='old'&&cli!=='PCM'?1:0);assert.equal(m.violations.length,0);
 reproduction.push({version,sha256:sha256(exe),cli,exit:run.exitCode,text:m.text});
}
const payload=new Map([['UGTEST.EXE',newExe],['TESTER.TXT',readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/UGTEST-CLI-TEST.md'))]]);
payload.set('HASHES.TXT',Buffer.from([...payload].map(([n,d])=>`${sha256(d)}  ${n}`).join('\r\n')+'\r\n'));
const entries=[...payload].sort(([a],[b])=>a.localeCompare(b));
const containers={'ug-test.zip':makeZip(entries),'ug-test.img':makeImg(entries)};
for(const [name,data] of Object.entries(containers))assert.deepEqual([...(name.endsWith('.zip')?readZip(data):readFat12(data))],entries);
// Never mutate an already published delivery.
mkdirSync(out);
for(let i=0;i<2;i++){
 const evidence=join(out,'evidence',i?'B':'A');mkdirSync(evidence,{recursive:true});
 cpSync(join(builds[i],'ultrags/cfg-package'),join(evidence,'kit'),{recursive:true});
 for(const [name,path] of [['EXE-RUN.json','ultrags/logs/ugdiag-run.json'],['S6-RUN.json','ultrags/logs/s6-run.json'],['ASSEMBLY.json','ultrags/dss/asm-manifest.json']])
  writeFileSync(join(evidence,name),readFileSync(join(builds[i],path)));
}
for(const e of proofs[0].assembly.filter(e=>!e.name.startsWith('ST-')))
 writeFileSync(join(out,e.name),readFileSync(join(builds[0],'ultrags/dss',e.name)));
for(const name of ['ug-cfg.zip','ug-cfg.img'])writeFileSync(join(out,name),readFileSync(join(builds[0],'ultrags/cfg-package',name)));
writeFileSync(join(out,'PGMULTI.UF2'),installedFirmware);
for(const [name,data] of [...payload,...Object.entries(containers)])writeFileSync(join(out,name),data);
writeFileSync(join(out,'DELIVERY.json'),JSON.stringify({status:'HOST_PASS / UGTEST CLI REAL_PENDING; S7 IN_PROGRESS',changedExes:['UGTEST.EXE'],firmwareUnchanged:true,firmwareSha256:sha256(installedFirmware),firmwarePolicy:'Retain physically accepted UF2. Rebuilt bundles in evidence only have a changed UG_BUILD_ID and consequent CRC metadata; all seven image bytes match after normalizing that identity.',independentMatch:true,proofs,reproduction,
 toolSha256:sha256(readFileSync(new URL(import.meta.url))),containers:Object.entries(containers).map(([name,data])=>({name,size:data.length,sha256:sha256(data)}))},null,2)+'\n');
console.log('Independent executed UGTEST and extracted ZIP/IMG identity PASS:',out);
