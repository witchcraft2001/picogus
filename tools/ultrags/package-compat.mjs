// SPDX-License-Identifier: GPL-2.0-or-later
// Freeze a COMPAT candidate/probe and publish only after payload readback.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,cpSync,readdirSync,realpathSync,symlinkSync,renameSync} from 'node:fs';
import {resolve,join,relative,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256} from './build-evidence.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
import {readZip,readFat12} from './verify-package.mjs';

const root=resolve('.'),a=resolve(process.argv[2]),b=resolve(process.argv[3]),out=resolve(process.argv[4]);
const noled=process.argv.includes('--no-led');
const probe=process.argv.includes('--probe');
const fast=process.argv.includes('--fast');assert(!(fast&&probe));
assert(noled,'COMPAT delivery must have LED diagnostic disabled');
const label=fast?'R12':probe?'R11':'R10';
const reportDoc=fast?'CONFIG-FAST-R12.md':probe?'CONFIG-PROBE-R11.md':'CONFIG-COMPAT-R10.md';
const identity=fast?'pg-ultrags-cfgfast-r12 v4.1.1':probe?'pg-ultrags-cfgprobe-r11 v4.1.1':'pg-ultrags-compat-r10 v4.1.1';
assert(!existsSync(out),'do not overwrite frozen delivery');
const prior=realpathSync('build/latest');
execFileSync('python3',['tools/ultrags/compat-linked.py',a,b],{stdio:'inherit'});
const sourcePaths=new Set(),reports=new Map();
function validateInputs(entries){
 for(const [name,hash]of Object.entries(entries)){
  const p=resolve(name);assert.equal(sha256(readFileSync(p)),hash,'stale input '+p);
  if(p.startsWith(root+'/'))sourcePaths.add(p);
 }
}
for(const [name,status]of [
 ['host/compat-linked.json','LINKED_PASS / REAL_PENDING'],
 ['host/compat/compat.json','HOST_PASS / REAL_PENDING'],
 ['host/independent-pio.json','HOST_PASS / REAL_PENDING'],
 ['host/budgets/budgets.json','LINKED_BUDGETS_PASS / REAL_PENDING'],
 ...(fast?[['host/catalog-fast-linked.json','LINKED_FAST_CATALOG_PASS / REAL_PENDING']]:[]),
 ...(probe?[['host/probe/probe.json','HOST_PROBE_PASS / REAL_PENDING']]:[]),
 ...(!noled?[['host/led/led.json','HOST_LED_DIAG_PASS / REAL_PENDING']]:[]),
 ['s7-stack.json','PASS'],['host/apps-reassembled.json','PASS'],
]){
 const path=join(a,name),r=JSON.parse(readFileSync(path));assert.equal(r.status,status,name);
 assert(Object.keys(r.inputs).length);validateInputs(r.inputs);reports.set(name,readFileSync(path));
}
const linked=JSON.parse(reports.get('host/compat-linked.json'));
assert(linked.builds.every(x=>x.ledDiagnostic===!noled&&x.firmware===identity&&x.configProbe===probe&&x.catalogFast===fast));
if(probe)assert(linked.builds.every(x=>x.probeCheck.dataCases===256&&x.probeCheck.adjacentLoadStore&&x.probeCheck.pioIdenticalToR10));
const compat=JSON.parse(reports.get('host/compat/compat.json'));
assert(!compat.referenceWordsIdentical&&compat.addressCases===262144&&compat.configGsBytes===1280&&compat.guard==='PASS');
assert.equal(compat.timing.length,6);
assert(compat.timing.every(t=>t.old.capture-t.new.capture===5&&t.old.wait-t.new.wait===5&&t.new.release-t.new.drive===4&&t.oldSample===255&&t.newSample===36));
const independent=JSON.parse(reports.get('host/independent-pio.json'));
assert.equal(independent.cases,12288);
assert.equal(independent.aborted,384);
const budgets=JSON.parse(reports.get('host/budgets/budgets.json'));
assert.equal(budgets.legacy_images.length,6);
assert(budgets.legacy_images.every(x=>x.comparison==='BYTE_IDENTICAL'));
const production=JSON.parse(readFileSync(join(a,'host/config-exchange-inputs.json')));
validateInputs(production);
const s2path=join(a,'ultrags/logs/s2-run.json'),s2=JSON.parse(readFileSync(s2path));
assert.equal(s2.results.length,270);assert(s2.results.every(r=>r.ok));
assert.equal(s2.scriptSha256,sha256(readFileSync('tests/ultrags/dss/run-s2.mjs')));
assert.equal(s2.productionTraceSha256,sha256(readFileSync(join(a,'host/config-exchange.json'))));
assert.equal(s2.productionInputsSha256,sha256(readFileSync(join(a,'host/config-exchange-inputs.json'))));
assert.equal(s2.catalogSha256,sha256(readFileSync(join(a,'host/s2-catalog.bin'))));
assert.equal(s2.executed[0].sha256,sha256(readFileSync(join(a,'ultrags/dss/UGCFG.EXE'))));
for(const n of ['ultrags/logs/s2-run.json','host/config-exchange.json','host/config-exchange-inputs.json',
 'host/s2-catalog.bin','host/s2-config-fixtures.json','s2-run.log','s2-host.log'])
 reports.set(n,readFileSync(join(a,n)));

const apps=JSON.parse(reports.get('host/apps-reassembled.json')),host=new Map();
assert.equal(Object.keys(apps.files).length,9);
for(const[n,h]of Object.entries(apps.files)){
 const bytes=readFileSync(join(a,'ultrags/dss',n));assert.equal(sha256(bytes),h);
 assert.deepEqual(bytes,readFileSync(join(prior,n)));host.set(n,bytes);
}
if(probe){
 const p=JSON.parse(reports.get('host/probe/probe.json'));
 assert.equal(p.results.length,112);assert.deepEqual(Object.keys(p.files).sort(),['UGCL0.EXE','UGCL1.EXE']);
 for(const[n,h]of Object.entries(p.files)){
  const bytes=readFileSync(join(a,'host/probe/a',n));
  assert.equal(sha256(bytes),h);assert.deepEqual(bytes,readFileSync(join(a,'host/probe/b',n)));
  host.set(n,bytes);
 }
 const realPath=join(a,'host/r10-real-fail.json'),real=JSON.parse(readFileSync(realPath));
 assert.equal(real.status,'REAL_FAIL');assert.equal(real.computedCRC_LE,'DB C4 2D 1F');
 validateInputs(real.inputs);reports.set('host/r10-real-fail.json',readFileSync(realPath));
}
if(fast){
 const f=JSON.parse(reports.get('host/catalog-fast-linked.json'));
 assert(f.builds.length===2&&f.builds.every(x=>x.cases===37891&&x.fifoBeforeIndex&&x.noCallsInSpan));
 const profile=JSON.parse(readFileSync(join(a,'host/config-exchange-profile.json')));
 assert(profile.fast&&profile.compat&&!profile.probe&&profile.fastOrderedBytes===148&&profile.fastMutationsRejected===2);
 assert.equal(profile.traceSha256,s2.productionTraceSha256);
 assert.equal(profile.inputsSha256,s2.productionInputsSha256);
 reports.set('host/config-exchange-profile.json',readFileSync(join(a,'host/config-exchange-profile.json')));
 const realPath=join(a,'host/r11-real-2101.json'),real=JSON.parse(readFileSync(realPath));
 assert.equal(real.status,'REAL_FAIL');assert.equal(real.changes.length,8);
 assert.equal(real.ultragsComputedCRC_LE,'5E 7C 17 5E');validateInputs(real.inputs);
 reports.set('host/r11-real-2101.json',readFileSync(realPath));
 reports.set('host/r11-observed-catalog.bin',readFileSync(join(a,'host/r11-observed-catalog.bin')));
}
const notes=Buffer.from(fast?
`ULTRAGS R12 DIRECT CATALOGUE - HOST PASS / REAL_PENDING\r\nFirmware: ${identity}\r\nR11 REAL FAIL remains open. This is a candidate, not a proven hardware fix.\r\nFlash CURRENT.UF2 with Sprinter powered off; unplug USB before powering on.\r\nSlot0:\r\n  UGCFG GUS\r\n  UGCFG INFO /DIAG\r\n  UGCFG ULTRAGS\r\n  UGCFG INFO /DIAG\r\nPhotograph ULTRAGS and full INFO output, including after FAIL. Stop on failure.\r\nIf both pass, repeat INFO /DIAG five times; stop and photograph the first failure.\r\nCheck firmware identity. Do not use UGCL0/UGCL1: R12 has no R11 probe registers.\r\nNo SAVE or LED codes. For slot1 add /SLOT:1 to each command. See NOTES.MD.\r\n`:
probe?
`ULTRAGS R11 CONFIG REPLY PROBE - HOST PASS / REAL_PENDING\r\nFirmware: ${identity}\r\nR10 REAL FAIL remains open. This build measures a possible late reply, not a confirmed fix.\r\nUse CURRENT.UF2. Flash with Sprinter powered off; unplug USB before powering on.\r\nSlot0, native BASE02A0:\r\n  UGCFG GUS\r\n  UGCFG ULTRAGS\r\n  UGCL0\r\nRun UGCL0 immediately after ULTRAGS, including after FAIL. Photograph both outputs.\r\nDo NOT run INFO or change mode between ULTRAGS and UGCL0: a new catalog read resets the probe.\r\nIf ULTRAGS and probe both work, run once:\r\n  UGCFG INFO /DIAG\r\n  UGCL0\r\nPhotograph both outputs. No SAVE, TRC0, UGW0, repeated series or LED codes required.\r\nLATE>00 means IOR was high before the data FIFO store in this diagnostic build.\r\nLATE=00 does not prove correct delivery. FLAGS=A0 means no catalog sample; A4 means samples/no late event.\r\nFor slot1: add /SLOT:1 to UGCFG commands and use UGCL1.\r\nRead NOTES.MD for timing perturbation and other limits.\r\n`:
`ULTRAGS ${label} COMPAT - HOST PASS / REAL_PENDING\r\nFirmware: ${identity}\r\nUse CURRENT.UF2 from this package. Flash with Sprinter powered off.\r\nDisconnect USB before powering Sprinter on.\r\nSlot0, native BASE02A0:\r\n  UGCFG GUS\r\n  UGCFG ULTRAGS\r\n  UGCFG INFO /DIAG\r\nCheck firmware identity above. Repeat INFO /DIAG ten times, then UGMEM INFO.\r\nIf any command fails, photograph the first failure and stop.\r\nLED diagnostic is OFF: no pulse code expected. No TRC0/UGW trace probe.\r\nExpect active08, boot_state0, memory8388608, objects0. No SAVE required.\r\nFor slot1 add /SLOT:1 to each command. See NOTES.MD for limitations.\r\n`);
host.set(label+'TEST.TXT',notes);
const hashes=m=>Buffer.from([...m].map(([n,v])=>sha256(v)+'  '+n).join('\r\n')+'\r\n');
host.set('HASHES.TXT',hashes(host));
const img=makeImg([...host]);
for(const[n,bytes]of host)assert.deepEqual(readFat12(img).get(n),bytes);
const uf2=readFileSync(join(a,'multifw-release/picogus.uf2'));
assert.deepEqual(uf2,readFileSync(join(b,'multifw-release/picogus.uf2')));
const payload=new Map([...host,['CURRENT.UF2',uf2],['CURRENT.IMG',img],
 ['NOTES.MD',readFileSync('host/sprinter/ultrags/docs/'+reportDoc)],
 ['STATUS.TXT',Buffer.from(fast?
 'R12 DIRECT CATALOGUE: HOST PASS / REAL_PENDING. R11 REAL FAIL: eight bit-setting substitutions without stream shift. Direct SRAM reply removes generic CONFIG calls before the FIFO store; stale/address guards and PIO are preserved. Hardware recovery remains unconfirmed. S6/S7 IN_PROGRESS.\n':
 probe?
 'R11 CONFIG PROBE: HOST PASS / REAL_PENDING. R10 REAL FAIL: catalog byte 101 C8->FF reproduces the reported CRC. R11 samples IOR immediately before data submission; it is a diagnostic, not a confirmed fix. Electrical cause and hardware recovery remain unconfirmed. S6/S7 IN_PROGRESS.\n':
 `${label} COMPAT: HOST PASS / REAL_PENDING. R9-NOLED REAL FAIL: intermittent CONFIG bytes. R10 reduces low-port classification latency and extends data setup. Electrical cause and hardware recovery remain unconfirmed. S6/S7 IN_PROGRESS.\n`)]]);
payload.set('HASHES.TXT',hashes(new Map([...payload].filter(([n])=>n!=='HASHES.TXT'))));
const zip=makeZip([...payload]);for(const[n,v]of payload)assert.deepEqual(readZip(zip).get(n),v);
payload.set('CURRENT.ZIP',zip);mkdirSync(out,{recursive:true});
for(const[n,v]of payload)writeFileSync(join(out,n),v);
for(const[n,v]of reports){const dest=join(out,'evidence/reports',n);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,v);}
for(const [label,build]of [['a',a],['b',b]]){
 const fw=join(build,'multifw-release');
 for(const name of ['CMakeCache.txt','pg-ultrags-multifw.elf','pg-ultrags-multifw.bin',
  'pg-ultrags-multifw.dis','isa_io.pio.h','ug_compat_ior.pio.h','generated/multifw/catalog.bin',
  'generated/multifw/flash-map.json','CMakeFiles/pg-ultrags-multifw.dir/flags.make',
  ...readdirSync(fw).filter(n=>n.endsWith('.evidence.json'))]){
  const path=join(fw,name),dest=join(out,'evidence/build-'+label,name);
  mkdirSync(dirname(dest),{recursive:true});cpSync(path,dest);
  if(name.endsWith('.evidence.json'))validateInputs(JSON.parse(readFileSync(path)).inputs);
 }
 cpSync(join(build,'build-final.log'),join(out,'evidence/build-'+label,'build-final.log'));
}
for(const dir of ['tests/ultrags/dss','tools/ultrags']){
 for(const n of readdirSync(dir))if(/\.(mjs|cjs|js|py|json)$/.test(n))sourcePaths.add(resolve(dir,n));
}
for(const p of ['sw/ultrags/ug_compat.c','sw/ultrags/ug_compat.h','sw/ultrags/ug_compat_ior.pio',
 'tests/ultrags/reference/handshake-v1.pio','ultra-gs-docs/ultra-gs.md',
 'host/sprinter/ultrags/docs/'+reportDoc,'host/sprinter/ultrags/docs/CONFIG-R8-FOLLOWUP.md'])
 sourcePaths.add(resolve(p));
const inputs={};
for(const path of [...sourcePaths].sort()){
 const rel=relative(root,path),dest=join(out,'evidence/source',rel);
 inputs[rel]=sha256(readFileSync(path));mkdirSync(dirname(dest),{recursive:true});cpSync(path,dest);
}
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);}
const evidence=Object.fromEntries(walk(join(out,'evidence')).map(p=>[relative(out,p),sha256(readFileSync(p))]));
const manifest={status:'HOST_PASS / REAL_PENDING',previous:prior,profile:fast?'COMPAT_R12_FAST':probe?'COMPAT_R11_PROBE':'COMPAT_R10',inputs,
 commands:[
  `python3 tools/ultrags/config-exchange.py --compat ${fast?'--fast ':probe?'--probe ':''}--build build/config-compat9-a/fixture --catalog build/config-compat9-a/host/s2-catalog.bin`,
  'python3 tools/ultrags/compat-check.py --build build/config-compat9-a/multifw-release --out build/config-compat9-a/host/compat',
  'node tools/ultrags/compat-independent.cjs build/config-compat9-a/multifw-release/ug_compat_ior.pio.h build/config-compat9-a/host/independent-pio.json',
  'python3 tools/ultrags/compat-linked.py build/config-compat9-a build/config-compat9-b',
  'node tests/ultrags/dss/run-s2.mjs . build/config-compat9-a',
  ...(probe?['node tools/diagnostics/check-config-probe.mjs build/config-compat9-a']:[]),
  ...(fast?['UV_CACHE_DIR=build/uv-cache uv run --no-project --with unicorn==2.1.4 --python /Users/dmitry/dev/zx/sprinter/toolchain/py313/bin/python3 tools/ultrags/catalog-fast-linked.py build/config-compat9-a build/config-compat9-b']:[]),
 ].map(s=>s.replaceAll('build/config-compat9-a',relative(root,a)).replaceAll('build/config-compat9-b',relative(root,b))),
 files:Object.fromEntries([...payload].map(([n,v])=>[n,{bytes:v.length,sha256:sha256(v)}])),evidence};
writeFileSync(join(out,label+'.json'),JSON.stringify(manifest,null,2)+'\n');
for(const[n,v]of payload)assert.deepEqual(readFileSync(join(out,n)),v);
for(const[n,h]of Object.entries(evidence))assert.equal(sha256(readFileSync(join(out,n))),h);
if(process.argv.includes('--publish')){
 const temp=resolve('build/latest-compat.tmp');assert(!existsSync(temp));
 symlinkSync(out,temp,'dir');renameSync(temp,resolve('build/latest'));
}
console.log(label+' payload, ZIP/IMG readback, source/linked evidence and two identical UF2 PASS:',out);
console.log('UF2 SHA256:',sha256(uf2));
