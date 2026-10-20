// SPDX-License-Identifier: GPL-2.0-or-later
// Freeze R13 only after its independent linked builds and executed checks.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,symlinkSync,renameSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {sha256,verifyBuild} from '../ultrags/build-evidence.mjs';
import {makeZip,makeImg} from '../ultrags/disk-formats.mjs';
import {readZip,readFat12} from '../ultrags/verify-package.mjs';
const root=resolve('.'),a=resolve('build/gs-fast13-a'),b=resolve('build/gs-fast13-b');
const prior=resolve('build/gs-probe-d3-delivery'),out=resolve(process.argv[2]);
assert(!existsSync(out),'frozen delivery exists');
const payload=new Map(),evidence=new Map(),sources=new Set();
function preserve(p,n){evidence.set(n,readFileSync(p));}
function input(entries){
 for(const[p,h]of Object.entries(entries??{})){
  assert.equal(sha256(readFileSync(p)),h,'stale '+p);
  if(resolve(p).startsWith(root+'/')&&!relative(root,resolve(p)).startsWith('build/'))sources.add(resolve(p));
 }
}
function report(name,status){
 const r=JSON.parse(readFileSync(join(a,name)));if(status)assert.equal(r.status,status,name);
 input(r.inputs);preserve(join(a,name),name);return r;
}
const linked=report('host/compat-linked.json','LINKED_PASS / REAL_PENDING');
assert(linked.builds.length===2&&linked.builds.every(r=>r.gsStatusFast&&r.catalogFast&&!r.configProbe&&!r.ledDiagnostic&&r.firmware==='pg-ultrags-gsfast-r13 v4.1.1'));
const gs=report('host/gs-fast-linked.json','LINKED_GS_FAST_PASS / REAL_PENDING');
assert.equal(gs.results.length,8);assert(gs.results.every(r=>r.instructions===12));
const cat=report('host/catalog-fast-linked.json','LINKED_FAST_CATALOG_PASS / REAL_PENDING');
assert(cat.builds.length===2&&cat.builds.every(r=>r.cases===37891&&r.fifoBeforeIndex));
const pio=report('host/compat/compat.json','HOST_PASS / REAL_PENDING');assert.equal(pio.addressCases,262144);
const independent=report('host/independent-pio.json','HOST_PASS / REAL_PENDING');assert.equal(independent.cases,12288);
const budget=report('host/budgets/budgets.json','LINKED_BUDGETS_PASS / REAL_PENDING');assert.equal(budget.legacy_images.length,6);
report('s7-stack.json','PASS');
const profile=report('host/config-exchange-profile.json','HOST_PASS / REAL_PENDING');assert(profile.gsFast&&profile.fast&&profile.compat);
const configInputs=JSON.parse(readFileSync(join(a,'host/config-exchange-inputs.json')));input(configInputs);
assert.equal(sha256(readFileSync(join(a,'host/config-exchange-inputs.json'))),profile.inputsSha256);
assert.equal(sha256(readFileSync(join(a,'host/config-exchange.json'))),profile.traceSha256);
const s2=report('ultrags/logs/s2-run.json');assert.equal(s2.results.length,270);assert(s2.results.every(r=>r.ok));
assert.equal(s2.scriptSha256,sha256(readFileSync('tests/ultrags/dss/run-s2.mjs')));
assert.equal(s2.productionTraceSha256,profile.traceSha256);
assert.equal(s2.productionInputsSha256,profile.inputsSha256);
const native=report('host/native/actual-exe.json','HOST_ACTUAL_EXE_PASS / REAL_PENDING');
assert.equal(native.results.length,198);assert(native.privateProplay);
const adapter=report('native/native-card-build.json');assert.equal(sha256(readFileSync(join(a,'native/native-card.node'))),adapter.artifact);
assert.equal(native.adapterSha256,sha256(readFileSync(join(a,'native/native-card-build.json'))));
verifyBuild(root,join(a,'ultrags/dss'));
const apps=report('host/apps-reassembled.json','PASS');assert.equal(Object.keys(apps.files).length,9);
for(const[n,h]of Object.entries(apps.files)){
 const bytes=readFileSync(join(a,'ultrags/dss',n));assert.equal(sha256(bytes),h);
 assert.deepEqual(bytes,readFileSync(join(prior,n)));payload.set(n,bytes);
 assert.equal(native.images[n.replace('.EXE','')]?.sha256??h,h);
}
const d3=JSON.parse(readFileSync(join(prior,'D3.json')));
for(const n of ['UGGS0.EXE','UGGS1.EXE']){
 const bytes=readFileSync(join(prior,n));assert.equal(sha256(bytes),d3.files[n].sha256);payload.set(n,bytes);
}
const firmware=readFileSync(join(a,'multifw-release/picogus.uf2'));
assert.deepEqual(firmware,readFileSync(join(b,'multifw-release/picogus.uf2')));
assert.notEqual(sha256(firmware),d3.files['CURRENT.UF2'].sha256);
const notes=readFileSync('host/sprinter/ultrags/docs/GS-FAST-R13.md');
payload.set('TEST-R13.TXT',Buffer.from('R13 GS STATUS candidate: HOST PASS, REAL PENDING.\r\nFlash CURRENT.UF2; host tools D2 and UGGS0/1 D3 are unchanged.\r\nUGCFG ULTRAGS /GSALIAS ON\r\nUGCFG INFO\r\nUGGS0\r\nExpected firmware pg-ultrags-gsfast-r13; GS ON; NATIVE7E ALIAS7E AFTER7E.\r\nIf any FF remains: stop and photograph all output.\r\nOnly after all rows pass: PROPLAY C:\\MEDIA\\MODS\\ATDT.MOD\r\nReport detection, loading and sound quality separately.\r\nSlot0 BASE02A0. Other ISA ports must remain passive.\r\n'));
const img=makeImg([...payload]);for(const[n,bytes]of payload)assert.deepEqual(readFat12(img).get(n),bytes);
payload.set('CURRENT.IMG',img);payload.set('CURRENT.UF2',firmware);payload.set('NOTES.MD',notes);
payload.set('HASHES.TXT',Buffer.from([...payload].map(([n,bytes])=>sha256(bytes)+'  '+n).join('\r\n')+'\r\n'));
const zip=makeZip([...payload]);for(const[n,bytes]of payload)assert.deepEqual(readZip(zip).get(n),bytes);
payload.set('CURRENT.ZIP',zip);
for(const name of ['host/config-exchange-inputs.json','host/config-exchange.json','host/config-exchange.c',
 'host/s2-catalog.bin','host/s2-config-fixtures.json','host/real-2311.json',
 'native-exe.log','s2-run.log','config-exchange.log','compat.log','independent.log','budgets.log','stack.log'])
 preserve(join(a,name),name);
for(const[variant,dir]of [['a',a],['b',b]])for(const name of ['build.log','multifw-release/pg-ultrags-multifw.elf',
 'multifw-release/CMakeCache.txt','multifw-release/ug_compat_ior.pio.h','multifw-release/isa_io.pio.h',
 'multifw-release/generated/multifw/catalog.bin','multifw-release/CMakeFiles/pg-ultrags-multifw.dir/flags.make'])
 preserve(join(dir,name),variant+'/'+name);
for(const p of ['sw/CMakeLists.txt','sw/picogus.cpp','sw/ultrags/ug_minimal.c','sw/ultrags/ug_minimal.h',
 'tools/diagnostics/package-gs-fast13.mjs','host/sprinter/ultrags/docs/GS-FAST-R13.md'])sources.add(resolve(p));
for(const p of sources)preserve(p,'source/'+relative(root,p));
preserve(join(prior,'D3.json'),'previous-D3.json');
mkdirSync(out,{recursive:true});
for(const[n,bytes]of payload)writeFileSync(join(out,n),bytes);
for(const[n,bytes]of evidence){const path=join(out,'evidence',n);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);}
const manifest={status:'HOST_PASS / REAL_PENDING',profile:'COMPAT_R13_GS_STATUS_FAST',previous:realpathSync('build/latest'),
 mainToolsUnchanged:true,firmware:'pg-ultrags-gsfast-r13 v4.1.1',
 files:Object.fromEntries([...payload].map(([n,bytes])=>[n,{bytes:bytes.length,sha256:sha256(bytes)}])),
 evidence:Object.fromEntries([...evidence].map(([n,bytes])=>['evidence/'+n,sha256(bytes)]))};
writeFileSync(join(out,'R13.json'),JSON.stringify(manifest,null,2)+'\n');
for(const[n,v]of Object.entries(manifest.files))assert.equal(sha256(readFileSync(join(out,n))),v.sha256);
for(const[n,h]of Object.entries(manifest.evidence))assert.equal(sha256(readFileSync(join(out,n))),h);
if(process.argv.includes('--publish')){
 const temp=resolve('build/latest-r13.tmp');assert(!existsSync(temp));
 symlinkSync(out,temp,'dir');renameSync(temp,resolve('build/latest'));
}
console.log('R13 frozen; two identical UF2 builds, reports/input hashes, ZIP/IMG and all payload/evidence readback PASS');
console.log(out,sha256(firmware));
