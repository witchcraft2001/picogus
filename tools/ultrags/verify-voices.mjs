// SPDX-License-Identifier: GPL-2.0-or-later
// Independent extraction of the frozen delivery and negative identity probes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from './build-evidence.mjs';
import {readZip,readFat12} from './verify-package.mjs';

export function verifyVoices(directory,{mutations=false}={}){
 const out=resolve(directory),delivery=JSON.parse(readFileSync(join(out,'DELIVERY.json')));
 assert.equal(delivery.status,'SOFTWARE_PASS / REAL_PENDING');assert.equal(delivery.S7,'IN_PROGRESS');
 assert.equal(delivery.independentMatch,true);assert.equal(delivery.proof.length,2);
 assert.deepEqual(delivery.proof[0].executedExes,delivery.proof[1].executedExes);
 const expected=new Map(delivery.files.map(e=>[e.name,e]));
 assert.equal(expected.size,delivery.files.length);
 const hashes=(entries)=>{
  const names=new Set();
  for(const line of entries.get('HASHES.TXT').toString('ascii').trim().split(/\r?\n/)){
   const m=/^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);assert(m,'invalid HASHES.TXT line');
   assert(!names.has(m[2]),'duplicate checksum '+m[2]);names.add(m[2]);
   assert(entries.has(m[2]),'checksum refers to missing file '+m[2]);assert.equal(sha256(entries.get(m[2])),m[1],m[2]+' checksum');
  }
  return names;
 };
 const check=(name,data)=>{const e=expected.get(name);assert(e,'unlisted payload '+name);assert.equal(data.length,e.size,name+' length');assert.equal(sha256(data),e.sha256,name+' hash');};
 for(const [name] of expected)check(name,readFileSync(join(out,name)));
 hashes(new Map([...expected.keys()].map(n=>[n,readFileSync(join(out,n))])));
 const exes=delivery.proof[0].executedExes.filter(e=>!e.name.startsWith('ST-'));
 assert.equal(exes.length,9);
 for(const name of ['ug-host.zip','ug-host.img','ug-full.zip']){
  const bytes=readFileSync(join(out,name)),entries=name.endsWith('.zip')?readZip(bytes):readFat12(bytes);
  assert.equal([...entries.keys()].filter(n=>n.endsWith('.EXE')).length,9);
  for(const e of exes){const data=entries.get(e.name);assert(data,e.name+' missing in '+name);assert.equal(data.length,e.size);assert.equal(sha256(data),e.sha256,e.name+' differs from executed EXE');}
  assert.deepEqual(entries.get('TESTER.TXT'),readFileSync(join(out,'TESTER.TXT')));
  assert.equal(hashes(entries).size,entries.size-1,'incomplete archive checksum list');
  if(name==='ug-full.zip'){
   check('PGMULTI.UF2',entries.get('PGMULTI.UF2'));
   assert.deepEqual(entries.get('UGHOST.IMG'),readFileSync(join(out,'ug-host.img')));
  }
 }
 let rejected=0;
 if(mutations)for(const [name] of expected){
  const bytes=Buffer.from(readFileSync(join(out,name)));bytes[Math.floor(bytes.length/2)]^=1;
  assert.throws(()=>check(name,bytes),undefined,'substitution survived '+name);rejected++;
 }
 let evidenceFiles=0;
 for(let i=0;i<delivery.proof.length;i++){
  const p=delivery.proof[i],ev=join(out,'evidence',i?'B':'A');
  assert.equal(p.firmwareSha256,expected.get('PGMULTI.UF2').sha256);
  assert.equal(p.execution.assembly,p.reports['ultrags/dss/asm-manifest.json']);
  assert.equal(p.execution.execution,p.reports['ultrags/logs/ugdiag-run.json']);
  for(const [path,hash] of Object.entries(p.reports)){
   const data=readFileSync(join(ev,path));assert.equal(sha256(data),hash,'evidence checksum '+path);evidenceFiles++;
   if(mutations){const changed=Buffer.from(data);changed[Math.floor(changed.length/2)]^=1;assert.throws(()=>assert.equal(sha256(changed),hash),'evidence substitution survived '+path);rejected++;}
  }
  const run=JSON.parse(readFileSync(join(ev,'ultrags/logs/ugdiag-run.json')));
  assert.equal(run.fail,0);assert(run.pass>0&&run.results.every(r=>r.ok));assert.deepEqual(run.executed,p.executedExes.map(({name,size,sha256})=>({name,size,sha256})));
 }
 return {files:expected.size,evidenceFiles,executedExes:exes.length,substitutionsRejected:rejected};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
 console.log('Frozen VLS1 executed EXE / ZIP / IMG identity PASS:',verifyVoices(process.argv[2]??'build/latest',{mutations:process.argv.includes('--mutations')}));
