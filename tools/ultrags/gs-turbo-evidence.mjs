// SPDX-License-Identifier: GPL-2.0-or-later
// R17 COMPAT gates, bound to freshly linked ELF/UF2. Historical failures stay history.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {sha256,executionInputs,repoRoot} from './build-evidence.mjs';
const json=p=>JSON.parse(readFileSync(p)),hash=p=>sha256(readFileSync(p));
function current(e){assert(Object.keys(e.inputs??{}).length);for(const[p,h]of Object.entries(e.inputs))assert.equal(hash(resolve(repoRoot,p)),h,'stale R17 evidence '+p);}
export function verifyTurbo(b,assembly){
 const paths=['host/gs-turbo/compat/compat.json','host/gs-turbo/independent-pio.json','evidence/gs-turbo-exe.json'];
 const [pio,independent,exe]=paths.map(p=>json(join(b,p)));
 for(const e of [pio,independent]){assert.equal(e.status,'HOST_PASS / REAL_PENDING');current(e);}
 assert.equal(pio.pio0Words,32);assert.equal(pio.addressCases,524288);assert.equal(pio.configGsBytes,1280);
 assert(pio.coupledMutationRejected);assert.equal(pio.guard,'PASS');
 // R3 also owns the 32-port OPL block: 64 ports with GS off, 96 with
 // GS on, across three relocation offsets and both feedback levels.
 assert.equal(independent.cases,12288);assert.equal(independent.aborted,3*2*(64+96));assert.deepEqual(independent.offsets,[0,5,10]);
 // Paired checks execute and compare both fixed build directories, then the
 // dependency manifests bind every linked object and UF2 payload to sources.
 const shared=['host/compat-linked.json','host/catalog-fast-linked.json','host/gs-fast-linked.json'].map(p=>join(repoRoot,'build',p));
 const [linked,catalog,gs]=shared.map(json);for(const e of [linked,catalog,gs]){current(e);assert(e.status.includes('PASS'));}
 assert.equal(linked.builds.length,2);assert.equal(catalog.builds.length,2);assert.equal(gs.results.length,8);
 for(const row of linked.builds){assert.equal(row.firmware,'pg-ultrags-adlib-r3 v4.1.1');assert(row.catalogFast&&row.gsStatusFast);assert.deepEqual(row.pioWords,{iow_program_instructions:10,ug_compat_ior_program_instructions:22});}
 assert(linked.builds.some(r=>resolve(r.build)===resolve(b,'multifw-release')));
 assert(catalog.builds.every(r=>r.cases===37891&&r.noCallsBeforeFIFO&&r.completionAccountingAfterFIFO&&r.fifoBeforeIndex));
 for(const r of catalog.builds)assert.deepEqual(r.instructionsThroughFIFOStore,[14,18]);
 assert(gs.results.every(r=>r.beforeSubmit===13&&r.accounted));
 const cfgdir=join(b,'host/gs-turbo/config'),profile=json(join(cfgdir,'config-exchange-profile.json'));
 assert.equal(profile.status,'HOST_PASS / REAL_PENDING');assert(profile.compat&&profile.fast&&profile.gsFast&&!profile.turbo);
 assert.equal(profile.fastOrderedBytes,148);assert.equal(profile.fastMutationsRejected,2);
 assert(profile.cachedOplReply&&profile.fwstringFast&&profile.scalarFast&&profile.scalarCommitRefresh);assert.equal(profile.readMutationsRejected,4);
 const cinputs=join(cfgdir,'config-exchange-inputs.json');assert.equal(profile.inputsSha256,hash(cinputs));current({inputs:json(cinputs)});
 assert.equal(profile.executableSha256,hash(join(cfgdir,'config-exchange')));
 assert.equal(profile.traceSha256,hash(join(cfgdir,'config-exchange.json')));
 assert.equal(exe.status,'DSS_EXE_PASS / REAL_PENDING');assert.deepEqual(exe.assembly,assembly);assert.deepEqual(exe.inputs,executionInputs(repoRoot));
 assert.equal(exe.runnerSha256,hash(join(repoRoot,'tests/ultrags/dss/run-gs-turbo.mjs')));assert.equal(exe.adapterSha256,hash(join(b,'native/native-card-build.json')));assert.equal(exe.results.length,56);
 for(const[app,h]of Object.entries(exe.images))assert.equal(hash(join(b,'ultrags/dss',app+'.EXE')),h);
 for(const slot of [0,1])for(const iff of [0,1]){
  const rows=exe.results.filter(r=>r.slot===slot&&r.iff===iff);assert.equal(rows.length,14);
  assert(rows.every(r=>r.residentWrites===0&&r.exitSP===0xbffc&&r.minSp>=0xbd90));
  assert(rows.some(r=>r.exit===0&&r.cli===''&&(r.text.match(/FULL_READBACK/g)||[]).length===4));
  assert(rows.some(r=>r.exit===4)&&rows.some(r=>r.exit===8&&r.stallDB));
  assert(rows.some(r=>r.exit===9&&r.losePcmAck)&&rows.some(r=>r.exit===9&&r.corruptRead));
  assert(rows.some(r=>r.exit===10&&r.cancelUpload)&&rows.some(r=>r.exit===8&&!r.aliases));
 }
 const report={status:'HOST_PASS / DSS_EXE_PASS / REAL_PENDING',profile:'COMPAT R17',firmware:linked.builds,S7:'IN_PROGRESS',
  pioWords:32,pioAddressCases:pio.addressCases,independentAddressCases:independent.cases,diagnosticExeCases:exe.results.length,
  inputs:Object.fromEntries([...paths.map(p=>join(b,p)),...shared,cinputs,join(cfgdir,'config-exchange-profile.json'),join(repoRoot,'tools/ultrags/gs-turbo-evidence.mjs')].map(p=>[resolve(p),hash(p)])),
  physical:'Owner confirmed UGGSC, UGGST and PROPLAY with Turbo ON (S8b task context). Slots and electrical measurements not specified.',
  limits:['Functional PIO/ARM/DSS models are software evidence, not measured ISA timing.',
   'Historical R13/R14/R15 failures remain recorded in the specification; R17 owner confirmation does not erase them.',
   'S7 final physical gates remain open; S8b requires separate physical audio/return confirmation; streaming optimization is next.']};
 writeFileSync(join(b,'GS-TURBO.json'),JSON.stringify(report,null,2)+'\n');
 writeFileSync(join(b,'GS-TURBO.txt'),['GS Turbo R17 COMPAT — '+report.status,'IOW10/IOR22, direct CONFIG/GS handlers, PIO GS alias classification.',report.physical,...report.limits,''].join('\r\n'));
 return report;
}
