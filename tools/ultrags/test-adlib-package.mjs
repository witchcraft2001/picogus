// SPDX-License-Identifier: GPL-2.0-or-later
// Check the published files as well as the bytes inside ZIP/FAT. Restore each
// controlled mutation before proceeding; CURRENT archives are never modified.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {repoRoot,sha256} from './build-evidence.mjs';
const builds=[join(repoRoot,'build'),join(repoRoot,'build/reproducibility')];
const packager=join(repoRoot,'tools/ultrags/package-gs105.mjs');
const verify=()=>execFileSync(process.execPath,[packager,'--adlib','--verify-only'],{cwd:repoRoot,stdio:'pipe',maxBuffer:16<<20});
verify();
const mutateJson=fn=>bytes=>{const v=JSON.parse(bytes);fn(v);return Buffer.from(JSON.stringify(v));};
const cases=[
 ['stale independent EXE',join(builds[1],'UGOPL.EXE'),bytes=>{const v=Buffer.from(bytes);v[0]^=1;return v;}],
 ['missing independent notes',join(builds[1],'ADLIB.TXT'),null],
 ['missing independent report hashes',join(builds[1],'ADLIB.json'),mutateJson(v=>v.files=[])],
 ['failed independent report',join(builds[1],'ADLIB.json'),mutateJson(v=>v.status='PENDING')],
 ['oversized independent render stack',join(builds[1],'s7-stack.json'),mutateJson(v=>v.render_with_reserve=2049)],
 ['missing delivery hashes',join(builds[0],'DELIVERY.json'),mutateJson(v=>v.files=[])],
];
const protectedPaths=builds.flatMap(b=>['CURRENT.UF2','CURRENT.ZIP','CURRENT.IMG','UGOPL.EXE','ADLIB.TXT','ADLIB.json'].map(n=>join(b,n))).concat(join(builds[0],'DELIVERY.json'),join(builds[1],'s7-stack.json'));
const before=Object.fromEntries(protectedPaths.map(p=>[p,sha256(readFileSync(p))]));
for(const [name,path,mutate]of cases){
 const bytes=readFileSync(path),backup=path+'.package-test-backup';
 assert(!existsSync(backup),'unrestored prior test backup: '+backup);
 try{
  if(mutate)writeFileSync(path,mutate(bytes));else renameSync(path,backup);
  assert.throws(verify,undefined,name+' was accepted');
 }finally{
  if(mutate)writeFileSync(path,bytes);else if(existsSync(backup))renameSync(backup,path);
 }
 console.log('PASS rejects '+name);
}
verify();
for(const [path,h]of Object.entries(before))assert.equal(sha256(readFileSync(path)),h,'test failed to restore '+path);
const report={status:'PASS',cases:cases.map(([name])=>name),checkerSha256:sha256(readFileSync(new URL(import.meta.url))),gateSha256:sha256(readFileSync(packager)),artifacts:before};
for(const b of builds)writeFileSync(join(b,'host/adlib/package-negative.json'),JSON.stringify(report,null,2)+'\n');
console.log('Both published payloads/reports verified; six negative controls rejected; all files restored');
