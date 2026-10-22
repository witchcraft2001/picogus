// SPDX-License-Identifier: GPL-2.0-or-later
// Fail-closed proof regression; restore every deliberately altered input.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {verifyTurbo} from './gs-turbo-evidence.mjs';
import {verifyS8b} from './s8b-evidence.mjs';
import {verifyBuild,sha256,repoRoot} from './build-evidence.mjs';
const b=resolve(process.argv[2]??'build'),assembly=verifyBuild(repoRoot,join(b,'ultrags/dss'));
const verify=()=>verifyS8b(b,assembly),turbo=()=>verifyTurbo(b,assembly);verify();turbo();
const jsonChange=fn=>data=>Buffer.from(JSON.stringify(fn(JSON.parse(data))));
const flip=data=>{const v=Buffer.from(data);v[v.length-1]^=1;return v;};
const cases=[
 ['failed host','host/s8b/host-evidence.json',jsonChange(e=>({...e,status:'FAIL'}))],
 ['missing UBSan program','host/s8b/host-evidence.json',jsonChange(e=>({...e,commands:{}}))],
 ['missing ARM profiles','evidence/s8b-arm.json',jsonChange(e=>({...e,results:[]}))],
 ['missing FLT4/multichannel ARM','evidence/s8b-arm.json',jsonChange(e=>({...e,extended:[]}))],
 ['missing cancellation','evidence/s8b-exe.json',jsonChange(e=>({...e,results:e.results.filter(r=>r.exit!==10)}))],
 ['resident corruption','evidence/s8b-exe.json',jsonChange(e=>({...e,results:e.results.map(r=>({...r,residentWrites:1}))}))],
 ['substituted EXE','ultrags/dss/UGTEST.EXE',flip],
 ['substituted fixture','host/s8b/fixtures/FLT8.MOD',flip],
 ['stale linked ELF','multifw-release/pg-ultrags-multifw.elf',flip],
 ['stale UF2','multifw-release/picogus.uf2',flip],
 ['cancelled SHARED profile','host/gs-turbo/config/config-exchange-profile.json',jsonChange(e=>({...e,compat:false,turbo:true})),turbo],
 ['old R15 PIO matrix','host/gs-turbo/compat/compat.json',jsonChange(e=>({...e,addressCases:1048576})),turbo]
];
if(JSON.parse(readFileSync(join(b,'host/s8b/host-evidence.json'))).commands.dope)cases.push(
 ['missing full DOPE audio','host/s8b/host-evidence.json',jsonChange(e=>{delete e.commands['dope-audio'];return e;})]);
const outputs=['CURRENT.UF2','CURRENT.ZIP','CURRENT.IMG'].map(n=>[n,sha256(readFileSync(join(b,n)))]);
for(const [name,path,mutate,check=verify]of cases){const p=join(b,path),before=readFileSync(p);try{writeFileSync(p,mutate(before));assert.throws(check,undefined,name+' accepted');}finally{writeFileSync(p,before);}console.log('PASS rejects',name);}
verify();for(const[n,h]of outputs)assert.equal(sha256(readFileSync(join(b,n))),h);
writeFileSync(join(b,'host/s8b/evidence-negative.json'),JSON.stringify({status:'PASS',cases:cases.map(c=>c[0]),checkerSha256:sha256(readFileSync(new URL(import.meta.url))),gateSha256:sha256(readFileSync(new URL('./s8b-evidence.mjs',import.meta.url)))},null,2)+'\n');
