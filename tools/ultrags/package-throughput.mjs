// SPDX-License-Identifier: GPL-2.0-or-later
// Host-only delivery: executed release/experimental EXEs, no firmware image.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {verifyExecution,verifyBuild,executionInputs,sha256,repoRoot} from './build-evidence.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
import {readZip,readFat12} from './verify-package.mjs';

const expected=[['UGMEM.EXE',8,false],['UGM64.EXE',64,false],['UGM256.EXE',256,false],
 ['UGM8T.EXE',8,true],['UGM64T.EXE',64,true],['UGM256T.EXE',256,true]];
const build=resolve(process.argv[2]||'build/cfg-native-a');
const other=process.argv[3]&&resolve(process.argv[3]);
function checked(b) {
 const dir=join(b,'ultrags/dss'),out=join(b,'ultrags/throughput');
 const provenance=verifyExecution(repoRoot,dir),assembly=verifyBuild(repoRoot,dir);
 const bytes=readFileSync(join(out,'throughput.json')),r=JSON.parse(bytes);
 assert.equal(r.status,'HOST_THROUGHPUT_PASS / REAL_PENDING');
 assert.equal(r.scriptSha256,sha256(readFileSync(join(repoRoot,'tests/ultrags/dss/throughput.mjs'))));
 assert.deepEqual(r.inputs,executionInputs(repoRoot));assert.deepEqual(r.buildInputs,assembly.inputs);
 assert(r.results.length>=160&&r.results.every(x=>x.ok));
 assert.equal(r.executed.length,expected.length);
 const payload=new Map();
 for(const [i,[name,window,turbo]] of expected.entries()) {
  const e=r.executed[i];assert.equal(e.name,name);assert.equal(e.window,window);
  assert.equal(e.writeTurbo,turbo);assert.equal(e.readTurbo,false);
  assert(r.results.some(x=>x.profile===name.slice(0,-4)&&x.bytes===65536&&x.exit===0));
  const data=readFileSync(join(name==='UGMEM.EXE'?dir:out,name));
  assert.equal(data.length,e.size);assert.equal(sha256(data),e.sha256);payload.set(name,data);
 }
 const regular=assembly.files.find(e=>e.name==='UGMEM.EXE');
 assert.equal(regular.sha256,r.executed[0].sha256);
 payload.set('TESTER.TXT',readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/FAST-TEST.md')));
 payload.set('HASHES.TXT',Buffer.from([...payload].map(([n,d])=>`${sha256(d)}  ${n}`).join('\r\n')+'\r\n'));
 const entries=[...payload].sort(([a],[b])=>a.localeCompare(b));
 const containers={'ug-fast.zip':makeZip(entries),'ug-fast.img':makeImg(entries)};
 for(const [name,container] of Object.entries(containers)) {
  const extracted=name.endsWith('zip')?readZip(container):readFat12(container);
  assert.deepEqual([...extracted.keys()].sort(),[...payload.keys()].sort());
  for(const [n,d] of payload)assert.deepEqual(extracted.get(n),d,`${name}: ${n}`);
 }
 return {out,payload,containers,executed:r.executed,provenance,report:sha256(bytes)};
}
const kit=checked(build),second=other&&checked(other);
if(second) {
 assert.deepEqual(kit.executed,second.executed);
 for(const name of Object.keys(kit.containers))assert.deepEqual(kit.containers[name],second.containers[name],name);
}
for(const k of second?[kit,second]:[kit]) {
 const dst=join(k.out,'package');mkdirSync(dst,{recursive:true});
 for(const [n,d] of k.payload)writeFileSync(join(dst,n),d);
 for(const [n,d] of Object.entries(k.containers))writeFileSync(join(dst,n),d);
 const proof={status:'HOST_PASS / REAL_PENDING; S7 IN_PROGRESS',provenance:k.provenance,
  throughputReport:k.report,executed:k.executed,independentMatch:!!second,
  packagingInputs:Object.fromEntries(['package-throughput.mjs','disk-formats.mjs','verify-package.mjs'].map(n=>[n,sha256(readFileSync(join(repoRoot,'tools/ultrags',n)))])),
  containers:Object.entries(k.containers).map(([name,data])=>({name,size:data.length,sha256:sha256(data)}))};
 writeFileSync(join(dst,'REPRO.JSN'),JSON.stringify(proof,null,2)+'\n');
 console.log(dst,JSON.stringify(proof.containers));
}
