// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {verifyS8c} from './s8c-evidence.mjs';
import {verifyBuild,sha256,repoRoot} from './build-evidence.mjs';
const b=resolve(process.argv[2]??'build'),assembly=verifyBuild(repoRoot,join(b,'ultrags/dss'));
const verify=()=>verifyS8c(b,assembly);verify();
const change=fn=>v=>Buffer.from(JSON.stringify(fn(JSON.parse(v))));
const flip=v=>{const x=Buffer.from(v);x[x.length-1]^=1;return x;};
const cases=[
 ['stale EXE','ultrags/dss/UGPF.EXE',flip],
 ['stale performance runner','host/s8c-performance/comparison.json',change(e=>({...e,inputs:{...e.inputs,[join(repoRoot,'tests/ultrags/dss/run-stream.mjs')]:'old'}}))],
 ['missing performance comparison','host/s8c-performance/comparison.json',change(e=>({...e,results:[]}))],
 ['insufficient PIPE speed','host/s8c-performance/comparison.json',change(e=>({...e,pipe:{...e.pipe,fast:{...e.pipe.fast,delta_frames:48000,Bps:131072}}}))],
 ['regressed windows','host/s8c-performance/comparison.json',change(e=>({...e,results:e.results.map(r=>({...r,after:{...r.after,windowCount:r.before.windowCount}}))}))],
 ['stale actual EXE','evidence/actual-exe-fast.json',change(e=>({...e,exeSha256:'old'}))],
 ['missing PIPE','evidence/actual-exe-fast.json',change(e=>({...e,results:e.results.filter(r=>!r.cli.includes('/BENCH:PIPE')&&!r.cli.includes('/BENCH:ALL'))}))],
 ['missing stopped clock','evidence/actual-exe.json',change(e=>({...e,results:e.results.filter(r=>r.clock)}))],
 ['unsafe DI','evidence/actual-exe.json',change(e=>({...e,results:e.results.map(r=>({...r,maxDiUs:10000}))}))],
 ['resident corruption','evidence/actual-exe.json',change(e=>({...e,results:e.results.map(r=>({...r,residentWrites:1}))}))],
 ['stale linked ELF','multifw-release/pg-ultrags-multifw.elf',flip],
 ['missing ARM profiles','evidence/stream-arm.json',change(e=>({...e,results:[]}))]
];
const outputs=['CURRENT.UF2','CURRENT.ZIP','CURRENT.IMG'].map(n=>[n,sha256(readFileSync(join(b,n)))]);
for(const[name,path,mutate]of cases){const p=join(b,path),before=readFileSync(p);try{writeFileSync(p,mutate(before));assert.throws(verify,undefined,name+' accepted');}finally{writeFileSync(p,before);}console.log('PASS rejects',name);}
verify();for(const[n,h]of outputs)assert.equal(sha256(readFileSync(join(b,n))),h);
writeFileSync(join(b,'host/s8c/evidence-negative.json'),JSON.stringify({status:'PASS',cases:cases.map(c=>c[0]),checkerSha256:sha256(readFileSync(new URL(import.meta.url))),gateSha256:sha256(readFileSync(new URL('./s8c-evidence.mjs',import.meta.url)))},null,2)+'\n');
