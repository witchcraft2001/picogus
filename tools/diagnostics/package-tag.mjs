// SPDX-License-Identifier: GPL-2.0-or-later
// R8: freeze verified payload/evidence; atomically publish stable CURRENT names.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, realpathSync,
  symlinkSync, renameSync, readdirSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256} from '../ultrags/build-evidence.mjs';
import {makeZip, makeImg} from '../ultrags/disk-formats.mjs';
import {readZip, readFat12} from '../ultrags/verify-package.mjs';
assert(process.argv[2], 'output directory required');
const out=resolve(process.argv[2]), previous=realpathSync('build/latest');
assert(!existsSync(out), 'refuse to overwrite a frozen delivery');
const prior=JSON.parse(readFileSync(join(previous,'LED.json')));
for(const [n,e] of Object.entries(prior.files))
  assert.equal(sha256(readFileSync(join(previous,n))),e.sha256, 'prior payload '+n);
for(const [n,h] of Object.entries(prior.evidence))
  assert.equal(sha256(readFileSync(join(previous,n))),h, 'prior evidence '+n);
const roots=['a','b'].map(s=>resolve(`build/config-tag8-${s}`));
const fw=roots.map(p=>join(p,'multifw-release'));
const uf2=fw.map(p=>readFileSync(join(p,'picogus.uf2')));
assert.deepEqual(uf2[0],uf2[1],'independent firmware mismatch');
for(const dir of fw) {
  execFileSync('python3',['-c',
    "import sys;sys.path.insert(0,'tools/ultrags');from cfg_evidence import verify_multifw;verify_multifw(sys.argv[1])",dir]);
  const flags=readFileSync(join(dir,'CMakeFiles/pg-ultrags-multifw.dir/flags.make'),'utf8');
  for(const d of ['-DUG_LED_DIAG=1','-DUG_ISA_EARLY_READ=1','-DUG_CONFIG_TRACE=1']) assert(flags.includes(d));
  assert(!flags.includes('-DPGDEBUG=1'));
  for(const name of ['gus','adlib','mpu','psg','sb','usb']) {
    assert.deepEqual(readFileSync(join(dir,`pg-${name}-multifw.bin`)),
      readFileSync(`build/config-led-a/multifw-release/pg-${name}-multifw.bin`));
    assert(!readFileSync(join(dir,`CMakeFiles/pg-${name}-multifw.dir/flags.make`),'utf8').includes('UG_LED_DIAG'));
  }
}
const reports=['host/led/led.json','host/guard-on/guard.json','host/guard-off/guard.json',
  'host/pio-isa.json','host/ownership/ownership.json','host/independent-pio.json',
  'host/budgets/budgets.json','host/write-window/write-window.json','host/config-read-arm.json','s7-stack.json'];
for(const name of reports) {
  const r=JSON.parse(readFileSync(join(roots[0],name)));
  assert(r.status.includes('PASS'), name);
  for(const [p,h] of Object.entries(r.inputs)) assert.equal(sha256(readFileSync(p)),h,'stale '+p);
}
for(const variant of ['on','off'])
  assert(JSON.parse(readFileSync(join(roots[0],`host/guard-${variant}/guard.json`))).ignoredProgressMutationRejected);
const dependencies=JSON.parse(readFileSync(join(roots[0],'fixture/config-exchange-inputs.json')));
for(const [p,h] of Object.entries(dependencies)) assert.equal(sha256(readFileSync(p)),h,'stale fixture '+p);
assert.equal(JSON.parse(readFileSync(join(roots[0],'fixture/config-exchange.json'))).length,213);
const notes=Buffer.from(`R8 ISA OWNERSHIP FIX / HOST PASS / REAL_PENDING
Use CURRENT.UF2. Full instructions: NOTES.MD.
Power Sprinter OFF and remove the card from ISA before USB BOOTSEL flashing.
After flashing, disconnect USB. Reinstall with power OFF, then power ON.
Do not connect powered Sprinter and Mac directly by USB.
Same ISA slot as before; slot0 commands:
UGCFG GUS
UGCFG ULTRAGS
If GUS fails, stop and record the result.
If ULTRAGS passes:
UGCFG INFO /DIAG
UGMEM INFO
Wait two minutes at the prompt, then UGCFG INFO again.
If ULTRAGS fails: TRC0 immediately, before INFO/SAVE/reboot/mode commands.
Record all output and BLUE LED count immediately and after two minutes.
For slot1 add /SLOT:1 to UG commands; use TRC1.
LED codes unchanged from R7: 4=CONFIG seen, 5=ISA hold fuse.
Code5 disconnects ISA until reset. No further TRC is needed after code5.
No SAVE/audio/GS/performance acceptance yet. S6/S7 IN_PROGRESS.
Fix: explicit PIO ownership tag, no GPIO26 feedback used as ownership.
Ignored foreign captures no longer postpone the hold fuse.
Host EXEs unchanged. Physical startup success still requires REAL evidence.
`.replace(/\n/g,'\r\n'),'ascii');
const host=new Map();
for(const [name,e] of Object.entries(prior.files).filter(([n])=>n.endsWith('.EXE'))) {
  const b=readFileSync(join(previous,name));assert.equal(sha256(b),e.sha256);host.set(name,b);
}
assert.equal(host.size,11);
host.set('R8TEST.TXT',notes);
const hashes=map=>Buffer.from([...map].map(([n,b])=>sha256(b)+'  '+n).join('\r\n')+'\r\n');
host.set('HASHES.TXT',hashes(host));
const img=makeImg([...host]);
for(const [n,b] of host) assert.deepEqual(readFat12(img).get(n),b);
const payload=new Map([...host].filter(([n])=>n!=='HASHES.TXT'));
payload.set('CURRENT.UF2',uf2[0]);payload.set('CURRENT.IMG',img);
payload.set('NOTES.MD',readFileSync('host/sprinter/ultrags/docs/CONFIG-TAG-R8.md'));
payload.set('HASHES.TXT',hashes(payload));
const zip=makeZip([...payload]);
for(const [n,b] of payload) assert.deepEqual(readZip(zip).get(n),b);
const sources=['sw/ultrags/ug_led_diag.c','sw/ultrags/ug_led_diag.h','sw/ultrags/ug_handshake.c',
  'sw/ultrags/ug_handshake.h','sw/ultrags/ug_handshake_ior.pio','sw/ultrags/ug_hwmap.h',
  'sw/picogus.cpp','sw/CMakeLists.txt','tools/ultrags/led-diag-check.py',
  'tools/ultrags/handshake-guard-check.py','tools/ultrags/config-exchange.py',
  'tools/ultrags/pio-isa-check.py','tools/ultrags/ownership-tag-check.py',
  'tools/ultrags/ownership-independent.cjs','tests/ultrags/reference/handshake-r7.pio',
  'tools/diagnostics/package-tag.mjs','host/sprinter/ultrags/docs/CONFIG-TAG-R8.md'];
mkdirSync(out,{recursive:true});
const files=new Map([...payload,['CURRENT.ZIP',zip]]);
files.set('STATUS.TXT',Buffer.from('R8 ISA OWNERSHIP FIX / HOST PASS / REAL_PENDING. Use CURRENT.UF2; read NOTES.MD. S6/S7 IN_PROGRESS.\n'));
for(const [n,b] of files) writeFileSync(join(out,n),b);
for(const p of sources) {
  const dest=join(out,'r8-evidence/source',p);mkdirSync(dirname(dest),{recursive:true});cpSync(p,dest);
}
for(let i=0;i<fw.length;i++) for(const name of ['CMakeCache.txt','pg-ultrags-multifw.elf',
  'pg-ultrags-multifw.evidence.json','picogus.bin','ug_handshake_ior.pio.h','generated/multifw']) {
  const dest=join(out,'r8-evidence',i?'B':'A',name);mkdirSync(dirname(dest),{recursive:true});
  cpSync(join(fw[i],name),dest,{recursive:true});
}
for(const name of ['host','fixture','s7-stack.json','build-final.log']) {
  const dest=join(out,'r8-evidence/checks',name);mkdirSync(dirname(dest),{recursive:true});
  cpSync(join(roots[0],name),dest,{recursive:true});
}
const manifest={status:'R8_HOST_PASS / REAL_PENDING',S6:'IN_PROGRESS',S7:'IN_PROGRESS',
  previous,independentFirmware:true,nonUltraGSImagesByteIdenticalToR7:true,standardExesReused:true,
  sources:Object.fromEntries(sources.map(p=>[p,sha256(readFileSync(p))])),
  files:Object.fromEntries([...files].map(([n,b])=>[n,{size:b.length,sha256:sha256(b)}])),evidence:{}};
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){
  const p=join(dir,e.name);if(e.isDirectory())walk(p);else manifest.evidence[p.slice(out.length+1)]=sha256(readFileSync(p));
}}
walk(join(out,'r8-evidence'));
writeFileSync(join(out,'R8.json'),JSON.stringify(manifest,null,2)+'\n');
for(const [n,e] of Object.entries(manifest.files))assert.equal(sha256(readFileSync(join(out,n))),e.sha256);
for(const [n,h] of Object.entries(manifest.evidence))assert.equal(sha256(readFileSync(join(out,n))),h);
if(process.argv.includes('--publish')) {
  const tmp=resolve('build/latest-tag.tmp');assert(!existsSync(tmp));
  symlinkSync(out,tmp,'dir');renameSync(tmp,resolve('build/latest'));
}
console.log(JSON.stringify({directory:out,firmware:manifest.files['CURRENT.UF2'],
  zip:manifest.files['CURRENT.ZIP'],evidenceFiles:Object.keys(manifest.evidence).length,status:manifest.status},null,2));
