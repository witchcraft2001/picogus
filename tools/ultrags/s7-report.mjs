// SPDX-License-Identifier: GPL-2.0-or-later
// Verify the executed native subset. Never promote this report to full S7 PASS.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyBuild,executionInputs,sha256,repoRoot} from './build-evidence.mjs';
const i=process.argv.indexOf('--build'),build=resolve(i<0?'build':process.argv[i+1]),verifyOnly=process.argv.includes('--verify-only');
execFileSync(process.env.UG_PYTHON||'python3',[join(repoRoot,'tools/ultrags/s7-host.py'),'--build',join(build,'host/s7'),'--verify-only'],{stdio:'pipe'});
const host=JSON.parse(readFileSync(join(build,'host/s7/s7-host-evidence.json'))),run=JSON.parse(readFileSync(join(build,'s7-dss-evidence.json'))),assembly=verifyBuild(repoRoot,join(build,'ultrags/dss'));
assert.equal(run.status,'PASS');assert.equal(run.stage_status,'IN_PROGRESS');assert.equal(host.sanitizer,'UBSan');
assert.deepEqual(run.inputs,executionInputs(repoRoot),'stale DSS inputs');assert.deepEqual(run.buildInputs,assembly.inputs,'stale assembly');
assert(run.results.length>=75&&run.results.every(x=>x.pass&&!x.errors.length),'missing/failed native actual-EXE cases');
const names=new Set(run.results.map(x=>x.name));
for(const name of ['BLOB type marker regression','MOD snapshot monitor','paused snapshot unchanged','F00 becomes foreground PAUSE','F00 RESUME is accepted',
 'no MOD capability before ALLOC','65 stored patterns / verified source above 64KiB','lost PLAY_MOD reply reconciled once','WAIT ESC stops own MOD'])assert(names.has(name),'missing '+name);
for(const prefix of ['file/handle context ','monitor context ','STOP context '])assert.equal(run.results.filter(x=>x.name.startsWith(prefix)).length,16,'incomplete context matrix');
assert.deepEqual(run.executed.map(x=>x.name).sort(),['UGLOAD.EXE','UGMEM.EXE','UGMON.EXE','UGPLAY.EXE']);
for(const x of run.executed){const b=readFileSync(join(build,'ultrags/dss',x.name));assert.equal(b.length,x.size);assert.equal(sha256(b),x.sha256,'stale/substituted executed EXE');}
const vectors=readFileSync(join(build,'host/s7/s7-commands.jsonl'));
assert.equal(run.sharedSha256,sha256(vectors),'stale C/model vectors');assert.equal(run.sharedCount,vectors.toString().trim().split('\n').length);assert(run.sharedCount>=60);
const report=`S7 code review: IN_PROGRESS\nNative regression subset: HOST_PASS / DSS-EXE_PASS / REAL_PENDING\n${run.results.length} actual-EXE cases, ${run.sharedCount} shared production C / independent-model vectors.\nMOD parser, immediate tick0, 65-pattern exact EOF, ED/EC/E6/EE/9xx, tempo, pins, F00, seek, errors, PCM/BLOB regressions pass.\nBoth slots, EI/DI, software Turbo on/off, hardware inhibit and PAGE3 checked on native file/play/monitor/STOP.\nHOST inputs, header/script/model sources, executable bytes and vectors are hash-verified.\nThis is not full S7 acceptance. GS dispatcher/streams/FX/reset/manual ticks, UGPLAY /GS, UGTEST GS/MOD4, full independent normative-effect/audio conformance and physical gates remain open.\nStandalone/MULTIFW builds and packaged artifacts are recorded separately; this report alone does not certify their provenance or the full S0-S6 software gate.\n`;
if(!verifyOnly)writeFileSync(join(build,'REPORT-S7-NATIVE.txt'),report);
console.log(`S7 native review evidence PASS: ${run.results.length} EXE / ${run.sharedCount} C-model; full S7 IN_PROGRESS`);
