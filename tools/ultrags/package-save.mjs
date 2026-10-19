// SPDX-License-Identifier: GPL-2.0-or-later
// Host-only SAVE polling fix: current actual-EXE proof in two independent builds.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {repoRoot,verifyExecution,verifyBuild,sha256} from './build-evidence.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
import {readZip,readFat12} from './verify-package.mjs';
const a=resolve(process.argv[2]||'build/cfg-native-a'),b=resolve(process.argv[3]||'build/cfg-native-b');
const out=resolve(process.argv[4]||'build/save-review');
const payloads=[],proofs=[];
for(const [tag,build] of [['A',a],['B',b]]) {
 const dir=join(build,'ultrags/dss'),proof=verifyExecution(repoRoot,dir),assembly=verifyBuild(repoRoot,dir);
 const exe=readFileSync(join(dir,'UGCFG.EXE')),entry=assembly.files.find(x=>x.name==='UGCFG.EXE');
 assert.equal(sha256(exe),entry.sha256);
 const s2=JSON.parse(readFileSync(join(build,'ultrags/logs/s2-run.json')));
 assert(s2.results.every(x=>x.ok));assert(s2.results.some(x=>x.name==='SAVE FF throughout BUSY remains unconfirmed'));
 assert(s2.results.some(x=>x.name==='regression SAVE immediate FF failure'));
 assert.equal(s2.executed[0].sha256,entry.sha256);
 assert.equal(s2.scriptSha256,sha256(readFileSync(join(repoRoot,'tests/ultrags/dss/run-s2.mjs'))));
 const payload=new Map([['UGCFG.EXE',exe],['TESTER.TXT',readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/SAVE-TEST.md'))]]);
 payload.set('HASHES.TXT',Buffer.from([...payload].map(([n,d])=>`${sha256(d)}  ${n}`).join('\r\n')+'\r\n'));
 const entries=[...payload].sort(([x],[y])=>x.localeCompare(y));
 const containers={'ug-save.zip':makeZip(entries),'ug-save.img':makeImg(entries)};
 for(const [name,data] of Object.entries(containers)) {
  const extracted=name.endsWith('.zip')?readZip(data):readFat12(data);
  assert.deepEqual([...extracted],entries,name);
 }
 payloads.push({payload,containers});
 proofs.push({tag,build,proof,executed:entry,s2Checks:s2.results.length,
  s2Report:sha256(readFileSync(join(build,'ultrags/logs/s2-run.json')))});
 const evidence=join(out,'evidence',tag);mkdirSync(evidence,{recursive:true});
 for(const [name,file] of [['EXE-RUN.json','ultrags/logs/ugdiag-run.json'],['S2-RUN.json','ultrags/logs/s2-run.json'],['ASSEMBLY.json','ultrags/dss/asm-manifest.json'],['CFG-REPRO.json','ultrags/cfg-package/REPRO.JSN']])
  copyFileSync(join(build,file),join(evidence,name));
}
assert.deepEqual(payloads[0],payloads[1],'independent host packages differ');
for(const [name,data] of [...payloads[0].payload,...Object.entries(payloads[0].containers)])writeFileSync(join(out,name),data);
writeFileSync(join(out,'REPRO.JSN'),JSON.stringify({status:'HOST_PASS / corrected SAVE acknowledgement REAL_PENDING; S7 IN_PROGRESS',
 firmwareUnchanged:true,independentMatch:true,proofs,
 packagingInputs:Object.fromEntries(['package-save.mjs','disk-formats.mjs','verify-package.mjs'].map(n=>[n,sha256(readFileSync(join(repoRoot,'tools/ultrags',n)))])),
 containers:Object.entries(payloads[0].containers).map(([name,data])=>({name,size:data.length,sha256:sha256(data)}))},null,2)+'\n');
console.log('Independent executed UGCFG + ZIP/IMG identity PASS:',out);
