// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {verifyBuild,sha256,repoRoot} from './build-evidence.mjs';
import {verifyS3m} from './s3m-evidence.mjs';
const b=resolve(process.argv[2]??'build'),assembly=verifyBuild(repoRoot,join(b,'ultrags/dss'));
const positive=verifyS3m(b,assembly),cases=[];
for(const [file,name,change]of [
 ['host-evidence.json','bad host status',d=>d.status='FAIL'],
 ['host-evidence.json','missing reference cases',d=>d.comparisons=[]],
 ['host-evidence.json','stale C',d=>d.inputs[join(repoRoot,'sw/ultrags/ug_s3m.c')]='00'],
 ['host-evidence.json','changed PCM',d=>d.artifacts['MOU8.s16le']='00'],
 ['dss-evidence.json','missing EXEs',d=>d.results=[]],
 ['dss-evidence.json','stale runner',d=>d.runnerSha256='00'],
 ['dss-evidence.json','stale adapter',d=>d.adapterSha256='00'],
 ['arm-evidence.json','low SRAM',d=>d.sram.free_main=16383],
 ['arm-evidence.json','missing full32',d=>d.results=d.results.filter(r=>r.voices!==32)],
 ['arm-evidence.json','stack overrun',d=>d.results[0].stack=2049],
 ['arm-evidence.json','altered audio',d=>d.results[0].sha256='00']]) {
 const target=join(b,'host/s3m',file);
 assert.throws(()=>verifyS3m(b,assembly,{readJson:p=>{const d=JSON.parse(readFileSync(p));if(p===target)change(d);return d;}}),undefined,name);cases.push(name);
}
writeFileSync(join(b,'host/s3m/evidence-negative.json'),JSON.stringify({status:'PASS',positive,cases,checkerSha256:sha256(readFileSync(new URL(import.meta.url))),gateSha256:sha256(readFileSync(join(repoRoot,'tools/ultrags/s3m-evidence.mjs')))},null,2)+'\n');
console.log('S3M current evidence PASS;',cases.length,'stale/substitution cases rejected');
