// SPDX-License-Identifier: GPL-2.0-or-later
// Additional release gates for the GS Turbo candidate. Never infer REAL PASS.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {sha256,executionInputs,repoRoot} from './build-evidence.mjs';
const json=p=>JSON.parse(readFileSync(p)),hash=p=>sha256(readFileSync(p));
function current(e){for(const[p,h]of Object.entries(e.inputs))assert.equal(hash(resolve(repoRoot,p)),h,'stale GS Turbo evidence '+p);}
export function verifyTurbo(b,assembly){
 const failurePath=join(repoRoot,'build/gs-turbo-r14-failure/manifest.json'),failure=json(failurePath);
 assert.equal(failure.status,'REAL_FAIL');assert(failure.owner_confirmation);
 for(const[p,h]of Object.entries(failure.files))assert.equal(hash(join(repoRoot,'build/gs-turbo-r14-failure',p)),h,'changed R14 failure baseline '+p);
 const paths=['host/gs-turbo/pio.json','host/gs-turbo/independent.json','host/gs-turbo/guard/guard.json',
  'host/gs-turbo/linked.json','host/config-read-arm.json','evidence/gs-turbo-exe.json','host/gs-turbo/config-entry.json'];
 const [pio,independent,guard,linked,config,exe,entry]=paths.map(p=>json(join(b,p)));
 for(const e of [pio,independent,guard,linked,config,entry]){assert(e.status.includes('PASS'));current(e);}
 assert.equal(pio.pio0_words,32);assert.equal(pio.addresses,1048576);assert.equal(pio.maps,512);
 assert.equal(independent.cases,2097152);assert.equal(independent.maps,256);
 assert.equal(independent.delayed.length,12);assert(independent.delayed.every(r=>r[2]===0x7e));
 assert.deepEqual(independent.delayed,linked.delayed);assert.equal(linked.linked.length,48);assert.equal(linked.read_cleanup_overlap.length,16);
 assert.equal(guard.configEntryAddressPairs,2097152);assert.equal(entry.cases.length,6);
 assert(entry.cases.every(r=>r.negative.delivered===r.negative.queued&&r.positive.sampled===36&&r.positive.delivered&&!r.stale.delivered&&!r.short.delivered&&r.ample.delivered));
 assert.equal(guard.readReleaseOverlapCases,2048);assert(guard.readReleaseMutationRejected);
 assert.equal(guard.ignoredProgressMutationRejected,true);assert.equal(config.cases.length,12);
 const cfgdir=join(b,'host/gs-turbo/config'),profile=json(join(cfgdir,'config-exchange-profile.json'));
 assert.equal(profile.status,'HOST_PASS / REAL_PENDING');assert(profile.turbo&&profile.fast&&profile.gsFast&&!profile.compat);
 assert.equal(profile.fastOrderedBytes,148);assert.equal(profile.fastMutationsRejected,2);
 const cinputs=join(cfgdir,'config-exchange-inputs.json');assert.equal(profile.inputsSha256,hash(cinputs));current({inputs:json(cinputs)});
 assert.equal(profile.executableSha256,hash(join(cfgdir,'config-exchange')));
 assert.equal(exe.status,'DSS_EXE_PASS / REAL_PENDING');assert.deepEqual(exe.assembly,assembly);
 assert.deepEqual(exe.inputs,executionInputs(repoRoot));
 assert.equal(exe.runnerSha256,hash(join(repoRoot,'tests/ultrags/dss/run-gs-turbo.mjs')));
 assert.equal(exe.adapterSha256,hash(join(b,'native/native-card-build.json')));
 assert.equal(exe.results.length,56);
 for(const[app,h]of Object.entries(exe.images))assert.equal(hash(join(b,'ultrags/dss',app+'.EXE')),h);
 for(const slot of [0,1])for(const iff of [0,1]){
  const rows=exe.results.filter(r=>r.slot===slot&&r.iff===iff);assert.equal(rows.length,14);
  assert(rows.every(r=>r.residentWrites===0&&r.exitSP===0xbffc&&r.minSp>=0xbd90));
  assert(rows.some(r=>r.exit===0&&r.cli===''&&(r.text.match(/FULL_READBACK/g)||[]).length===4));
  assert(rows.some(r=>r.exit===4)&&rows.some(r=>r.exit===8&&r.stallDB));
  assert(rows.some(r=>r.exit===9&&r.losePcmAck)&&rows.some(r=>r.exit===9&&r.corruptRead));
  assert(rows.some(r=>r.exit===10&&r.cancelUpload)&&rows.some(r=>r.exit===8&&!r.aliases));
 }
 const negativePath=join(repoRoot,'build/gs-turbo-baseline/replayed.json'),negative=json(negativePath);current(negative);
 assert.equal(negative.captures,262144);assert.equal(negative.traces.length,12);
 assert.equal(negative.independentSha256,hash(join(repoRoot,'build/gs-turbo-baseline/replayed-independent.json')));
 assert(negative.traces.some(r=>r.port===0xbb&&r.latencyTicks===4096&&r.sampled===255));
 const report={status:'HOST_PASS / DSS_EXE_PASS / REAL_PENDING',firmware:linked.identity,S7:'IN_PROGRESS',
  pioWords:32,pioAddressCases:pio.addresses,independentAddressCases:independent.cases,
  delayedControls:12,linkedArmReplies:48,linkedReadWriteOverlaps:16,configEntryRegressionCases:6,diagnosticExeCases:exe.results.length,
  previousRealFailure:failure.owner_confirmation,
  inputs:Object.fromEntries([...paths.map(p=>join(b,p)),cinputs,join(cfgdir,'config-exchange-profile.json'),negativePath,failurePath,
   join(repoRoot,'tools/ultrags/gs-turbo-evidence.mjs')].map(p=>[resolve(p),hash(p)])),
  limits:['Functional models and linked machine code are software evidence, not measured ISA timing.',
   'R14 mode-switch/CONFIG REAL_FAIL with hardware Turbo enabled is retained; R15 needs physical confirmation.',
   'Reduced CONFIG entry latency is verified in software; it does not establish the cause of the photographed R14 failure.',
   'Both slots, original PROPLAY detection/load/audio, DSS return, and oscilloscope margins remain REAL_PENDING.',
   'S7 IN_PROGRESS; FLT8 and streaming optimization remain separate work.']};
 writeFileSync(join(b,'GS-TURBO.json'),JSON.stringify(report,null,2)+'\n');
 writeFileSync(join(b,'GS-TURBO.txt'),[
  'GS Turbo R15 — '+report.status,'S7 IN_PROGRESS',
  'PIO: 32 words, SM0/SM1; exact 00B3/00BB ownership when GSALIAS is ON.',
  `Primary PIO: ${pio.addresses} addresses; independent rp2040js: ${independent.cases}.`,
  'Same delayed-ARM controls: old low GS loses 128/4096-tick cases; new holds through reply.',
  'Linked ELF/UF2 binding; 48 Cortex-M0 replies; 16 IOR-cleanup/next-IOW overlaps; 12 CONFIG tests.',
  'R14/R15 linked CONFIG entry: FIFO, port decode and capture; 3 old failures and 3 queued controls at a fixed 80-tick window.',
  'Production C: map snapshot, preceding-write fence, catalog order, stopped-core0 WAIT guard.',
  'UGGST0/1: 56 actual EXE cases; both slots/IFF; low GS Turbo ON, native/CONFIG Turbo OFF.',
  'MOD/FX full readback, ESC, timeout, lost ACK, occupied store, explicit RESET, DSS RAM/PAGE3/IFF/SP.',
  'See GS105-CONFORMANCE.md and DELIVERY.json for complete regression identities.',...report.limits,''].join('\r\n'));
 return report;
}
