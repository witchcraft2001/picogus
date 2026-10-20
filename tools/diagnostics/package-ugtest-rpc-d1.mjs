// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,symlinkSync,renameSync,cpSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {sha256,verifyBuild} from '../ultrags/build-evidence.mjs';
import {makeZip,makeImg} from '../ultrags/disk-formats.mjs';
import {readZip,readFat12} from '../ultrags/verify-package.mjs';
const root=resolve('.'),build=resolve(process.argv[2]),out=resolve(process.argv[3]);
const deadlineFix=process.argv.includes('--deadline-fix'),label=deadlineFix?'D2':'D1';
const note=deadlineFix?'RPC-DEADLINE-D2.md':'UGTEST-RPC-D1.md';
const prior=resolve('build/config-fast12-delivery'),old=JSON.parse(readFileSync(join(prior,'R12.json')));
assert(!existsSync(out),'frozen output already exists');
const report=JSON.parse(readFileSync(join(build,'actual-exe.json')));
assert.equal(report.status,'HOST_PASS / REAL_PENDING');assert.equal(report.results.length,30);
for(const[p,h]of Object.entries(report.inputs))assert.equal(sha256(readFileSync(p)),h,'stale test input '+p);
const payload=new Map(),evidence=new Map();
const extra=[];
if(deadlineFix){
 for(const[name,count]of [['deadline.json',27],['host-smoke.json',20]]){
  const proof=JSON.parse(readFileSync(join(build,name)));
  assert.equal(proof.status,'HOST_PASS / REAL_PENDING');assert.equal(proof.results.length,count);
  for(const[p,h]of Object.entries(proof.inputs))assert.equal(sha256(readFileSync(p)),h,'stale '+p);
  extra.push(name,name.replace('.json','.log'));
 }
 for(const name of ['s3','s4']){
  const p='a/ultrags/logs/'+name+'-run.json',proof=JSON.parse(readFileSync(join(build,p)));
  assert(proof.results.length>90&&proof.results.every(r=>r.ok),p);
  for(const e of proof.executed)assert.equal(sha256(readFileSync(join(build,'a/ultrags/dss',e.name))),e.sha256);
  extra.push(p,name+'-run.log');
 }
}
function preserve(path,name){
 const bytes=readFileSync(path);evidence.set(name,bytes);
}
const manifests=['a','b'].map(v=>verifyBuild(root,join(build,v,'ultrags/dss')));
for(const name of Object.keys(old.files).filter(n=>n.endsWith('.EXE'))){
 const a=readFileSync(join(build,'a/ultrags/dss',name)),b=readFileSync(join(build,'b/ultrags/dss',name));
 assert.deepEqual(a,b);
 if(deadlineFix?['UGCFG.EXE','UGDIAG.EXE'].includes(name):name!=='UGTEST.EXE')
  assert.equal(sha256(a),old.files[name].sha256,name);
 payload.set(name,a);
}
assert.equal(payload.size,9);assert.notEqual(sha256(payload.get('UGTEST.EXE')),old.files['UGTEST.EXE'].sha256);
const uf2=readFileSync(join(prior,'CURRENT.UF2'));
assert.equal(sha256(uf2),'e48ac11ef4e69958b1d57c9a706c509acd947102740b3e4ea2a53c415b3f35d5');
payload.set(label+'TEST.TXT',Buffer.from(deadlineFix?
 'D2: copy all nine UG*.EXE. Do not reflash: firmware remains R12.\r\nRun UGMEM INFO; expect objects=0 before MIX.\r\nThen UGTEST MIX /VOICES:32 /SECONDS:60\r\nOn FAIL photograph the full output including UGTEST-D2 and stop.\r\nAfter PASS run UGMEM INFO; expect objects=0.\r\nNo SAVE or mode change required. Listening is a separate audio-quality check.\r\nBare UGTEST MIX uses all available voices and 60 seconds.\r\nHOST PASS / REAL_PENDING for the timeout correction.\r\n':
 'UGTEST-D1: replace UGTEST.EXE only. Do not reflash: firmware remains R12.\r\nRun UGTEST PCM. On FAIL photograph the full output including UGTEST-D1 and stop.\r\nIf PCM passes, run UGTEST FX. No SAVE or mode change required.\r\nHOST PASS / REAL_PENDING for D1; PCM/FX hardware failure remains open.\r\n'));
const hashes=m=>Buffer.from([...m].map(([n,b])=>sha256(b)+'  '+n).join('\r\n')+'\r\n');
payload.set('HASHES.TXT',hashes(payload));
const img=makeImg([...payload]);
for(const[n,b]of payload)assert.deepEqual(readFat12(img).get(n),b);
payload.set('CURRENT.IMG',img);payload.set('CURRENT.UF2',uf2);
payload.set('NOTES.MD',readFileSync('host/sprinter/ultrags/docs/'+note));
payload.set('STATUS.TXT',Buffer.from(deadlineFix?
 'D2 HOST_PASS / REAL_PENDING. R12 firmware unchanged. D1 PCM/FX REAL_PASS control flow, audio quality unobserved; MIX REAL_FAIL host TIMEOUT. Premature whole-second timeout reproduced and corrected; physical retest pending. S6/S7 IN_PROGRESS.\n':
 'UGTEST-D1 HOST_PASS / REAL_PENDING. R12 firmware unchanged: CONFIG scoped REAL_PASS; memory quick and 65537 VERIFY reported PASS; PCM/FX REAL_FAIL source01/status03 under investigation. S6/S7 IN_PROGRESS.\n'));
payload.set('HASHES.TXT',hashes(new Map([...payload].filter(([n])=>n!=='HASHES.TXT'))));
const zip=makeZip([...payload]);for(const[n,b]of payload)assert.deepEqual(readZip(zip).get(n),b);
payload.set('CURRENT.ZIP',zip);
preserve(join(build,'actual-exe.json'),'actual-exe.json');
preserve(join(build,'actual-exe.log'),'actual-exe.log');
for(const p of extra)preserve(join(build,p),p);
if(deadlineFix)preserve(join(build,'real-2209.json'),'real-2209.json');
preserve(join(prior,'R12.json'),'firmware-R12.json');
preserve('build/config-fast12-real/r12-real-2128.json','r12-real-2128.json');
for(const v of ['a','b'])for(const n of ['asm-manifest.json','ugtest.lst'])
 preserve(join(build,v,'ultrags/dss',n),v+'/'+n);
const sources=new Set([...Object.keys(manifests[0].inputs.sources),
 ...Object.keys(report.inputs),...Object.keys(JSON.parse(readFileSync(join(build,'native/native-card-build.json'))).inputs),
 'tools/diagnostics/package-ugtest-rpc-d1.mjs','host/sprinter/ultrags/docs/'+note,
 ...(deadlineFix?['tools/diagnostics/check-rpc-deadline-d2.mjs','tools/diagnostics/check-host-deadline-d2.mjs',
 'tests/ultrags/dss/run-s3.mjs','tests/ultrags/dss/run-s4.mjs']:[])]);
for(const p of sources){const path=resolve(p);if(path.startsWith(root+'/'))preserve(path,'source/'+relative(root,path));}
mkdirSync(out,{recursive:true});
for(const[n,b]of payload)writeFileSync(join(out,n),b);
for(const[n,b]of evidence){const path=join(out,'evidence',n);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,b);}
const manifest={status:'HOST_PASS / REAL_PENDING',profile:'R12_HOST_'+label,previous:realpathSync('build/latest'),
 firmwareUnchanged:true,files:Object.fromEntries([...payload].map(([n,b])=>[n,{bytes:b.length,sha256:sha256(b)}])),
 evidence:Object.fromEntries([...evidence].map(([n,b])=>['evidence/'+n,sha256(b)]))};
writeFileSync(join(out,label+'.json'),JSON.stringify(manifest,null,2)+'\n');
for(const[n,b]of payload)assert.deepEqual(readFileSync(join(out,n)),b);
for(const[n,h]of Object.entries(manifest.evidence))assert.equal(sha256(readFileSync(join(out,n))),h);
if(process.argv.includes('--publish')){
 const tmp=resolve('build/latest-ugd1.tmp');assert(!existsSync(tmp));symlinkSync(out,tmp,'dir');renameSync(tmp,resolve('build/latest'));
}
console.log(label+': two identical builds, executed cases, unchanged R12 UF2, ZIP/IMG readback PASS');
console.log('UGTEST.EXE',sha256(payload.get('UGTEST.EXE')));
