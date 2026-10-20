// SPDX-License-Identifier: GPL-2.0-or-later
// Publish an immutable R7 LED diagnostic with stable CURRENT names.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,cpSync,realpathSync,symlinkSync,renameSync,readdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256} from '../ultrags/build-evidence.mjs';
import {makeZip,makeImg} from '../ultrags/disk-formats.mjs';
import {readZip,readFat12} from '../ultrags/verify-package.mjs';
import {verifyVoices} from '../ultrags/verify-voices.mjs';
const out=resolve(process.argv[2]),previous=realpathSync('build/latest');
assert(!existsSync(out),'refuse to overwrite a frozen delivery');
verifyVoices(previous);
const roots=['a','b'].map(x=>resolve(`build/config-led-${x}`));
const fw=roots.map(p=>join(p,'multifw-release'));
const bytes=fw.map(p=>readFileSync(join(p,'picogus.uf2')));
assert.deepEqual(bytes[0],bytes[1],'independent firmware mismatch');
for(const dir of fw) {
 execFileSync('python3',['-c',"import sys;sys.path.insert(0,'tools/ultrags');from cfg_evidence import verify_multifw;print(verify_multifw(sys.argv[1]))",dir]);
 const flags=readFileSync(join(dir,'CMakeFiles/pg-ultrags-multifw.dir/flags.make'),'utf8');
 for(const define of ['-DUG_LED_DIAG=1','-DUG_ISA_EARLY_READ=1','-DUG_CONFIG_TRACE=1'])assert(flags.includes(define));
 assert(!flags.includes('-DPGDEBUG=1'));
 for(const name of ['gus','adlib','mpu','psg','sb','usb']) {
  assert(!readFileSync(join(dir,`CMakeFiles/pg-${name}-multifw.dir/flags.make`),'utf8').includes('UG_LED_DIAG'));
  assert.deepEqual(readFileSync(join(dir,`pg-${name}-multifw.bin`)),
   readFileSync(`build/config-edge6-a/multifw-release/pg-${name}-multifw.bin`));
 }
 assert.deepEqual(readFileSync(join(dir,'ug_handshake_ior.pio.h')),
  readFileSync('build/config-edge6-a/multifw-release/ug_handshake_ior.pio.h'));
}
const checks=['host/led/led.json','host/guard-on/guard.json','host/guard-off/guard.json',
 'host/pio-isa.json','host/budgets/budgets.json','s7-stack.json'];
for(const name of checks) {
 const report=JSON.parse(readFileSync(join(roots[0],name)));
 assert(report.status.includes('PASS'),name);
 for(const [p,h] of Object.entries(report.inputs))assert.equal(sha256(readFileSync(p)),h,'stale check: '+p);
}
assert(JSON.parse(readFileSync(join(roots[0],checks[1]))).ledDiagHooks);
assert(!JSON.parse(readFileSync(join(roots[0],checks[2]))).ledDiagHooks);
const exchangeInputs=JSON.parse(readFileSync(join(roots[0],'fixture/config-exchange-inputs.json')));
for(const [p,h] of Object.entries(exchangeInputs))assert.equal(sha256(readFileSync(p)),h,'stale CONFIG fixture '+p);
assert.equal(JSON.parse(readFileSync(join(roots[0],'fixture/config-exchange.json'))).length,213);
const notes=Buffer.from(`R7 LED DIAGNOSTIC - E1MAGIC REV1.5 / PICO_BASED GPIO25
REAL_PENDING. This diagnoses R6 failure; it is not a claimed fix.
Use CURRENT.UF2. No direct USB connection between running Sprinter and Mac.
Power Sprinter OFF and REMOVE the card from ISA before USB BOOTSEL flashing.
After flashing finishes disconnect USB, reinstall with power OFF, then power ON.
Use existing UG EXEs (unchanged; included here). Same ISA slot as before:
UGCFG GUS
UGCFG ULTRAGS
For slot1 add /SLOT:1 to both commands.
If GUS fails, stop switching and record that result and LED state.
After ULTRAGS returns wait/watch BLUE LED for at least20 seconds.
Count flashes between long pauses; ignore the first partial group.
Report count or constant ON/OFF, plus the UGCFG result. Video is useful.
Do not SAVE/reboot/switch again before recording.

Each flash is200ms ON/200ms OFF; long pause is at least2 seconds.
1 = diagnostic started after board detection; before core1 launch stage.
2 = core1 launch/guard-ready wait; ISA PIO enable not yet passed.
3 = ISA enabled, main/guard monitor not stalled; no CONFIG reads counted yet.
4 = as3, with CONFIG reads captured. NOT proof of correct replies or READY.
5 = core1 fuse: WAIT held without completions for at least10ms; ISA disabled.
6 = map update refused: IOR SM PC not safe; ISA disabled.
7 = map update refused: invalid base/alias; ISA disabled.
8 = core0 main counter stalled >=500ms while diagnostic IRQ runs.
9 = core0 main runs but core1 guard IRQ counter stalled >=500ms.
Codes8/9 only report; they do not themselves disable ISA.
First detected code5..9 stays until reset. Complete pulse groups never splice.
SRAM first-fault record is lost on reset/power-off; no Flash writes are added.
Constant ON/OFF is inconclusive: early boot/CPU/IRQ/clock/LED issues possible.
RED PWR and large RGB are not diagnostic indicators.
IRQ1/core0 alarm1 drives GPIO25; SDK uses alarm3, core1 fuse uses alarm2.
Indication may stop if core0 IRQs stop. Added instrumentation affects timing.
Do not use this diagnostic for audio/performance acceptance.
Full Russian instructions: NOTES.MD. S6/S7 remain IN_PROGRESS.
`.replace(/\n/g,'\r\n'),'ascii');
const delivery=JSON.parse(readFileSync(join(previous,'DELIVERY.json')));
const host=new Map();
for(const entry of delivery.files.filter(e=>e.name.endsWith('.EXE')&&!e.name.startsWith('ST-'))) {
 const b=readFileSync(join(previous,entry.name));assert.equal(sha256(b),entry.sha256);
 host.set(entry.name,b);
}
assert.equal(host.size,9);
const trace=JSON.parse(readFileSync(join(previous,'TRACE.json')));
for(const n of ['TRC0.EXE','TRC1.EXE']) {
 const b=readFileSync(join(previous,n));assert.equal(sha256(b),trace.files[n].sha256);host.set(n,b);
}
host.set('LEDTEST.TXT',notes);
const hashes=map=>Buffer.from([...map].map(([n,b])=>sha256(b)+'  '+n).join('\r\n')+'\r\n');
host.set('HASHES.TXT',hashes(host));
const img=makeImg([...host]);
for(const [n,b] of host)assert.deepEqual(readFat12(img).get(n),b);
const payload=new Map([...host].filter(([n])=>n!=='HASHES.TXT'));
payload.set('CURRENT.UF2',bytes[0]);payload.set('CURRENT.IMG',img);
payload.set('NOTES.MD',readFileSync('host/sprinter/ultrags/docs/CONFIG-LED-R7.md'));
payload.set('HASHES.TXT',hashes(payload));
const zip=makeZip([...payload]);
for(const [n,b] of payload)assert.deepEqual(readZip(zip).get(n),b);
mkdirSync(out,{recursive:true});
const files=new Map([...payload,['CURRENT.ZIP',zip]]);
for(const [n,b] of files)writeFileSync(join(out,n),b);
writeFileSync(join(out,'STATUS.TXT'),'R7 LED DIAGNOSTIC / REAL_PENDING. R6 REAL_FAIL. Use CURRENT.UF2; read NOTES.MD. S6/S7 IN_PROGRESS.\n');
const sourcePaths=['sw/ultrags/ug_led_diag.c','sw/ultrags/ug_led_diag.h','sw/ultrags/ug_handshake.c',
 'sw/ultrags/ug_handshake.h','sw/ultrags/ug_handshake_ior.pio','sw/ultrags/ug_hwmap.h',
 'sw/picogus.cpp','sw/CMakeLists.txt','tools/ultrags/led-diag-check.py',
 'tools/ultrags/handshake-guard-check.py','tools/ultrags/config-exchange.py',
 'tools/diagnostics/package-led.mjs','host/sprinter/ultrags/docs/CONFIG-LED-R7.md'];
for(const p of sourcePaths) {
 const dest=join(out,'led-evidence/source',p);mkdirSync(dirname(dest),{recursive:true});cpSync(p,dest);
}
for(let i=0;i<fw.length;i++)for(const name of ['CMakeCache.txt','pg-ultrags-multifw.elf',
 'pg-ultrags-multifw.evidence.json','picogus.bin','ug_handshake_ior.pio.h','generated/multifw']) {
 const dest=join(out,'led-evidence',i?'B':'A',name);mkdirSync(dirname(dest),{recursive:true});cpSync(join(fw[i],name),dest,{recursive:true});
}
for(const name of ['host','fixture','s7-stack.json','build-final.log']) {
 const dest=join(out,'led-evidence/checks',name);mkdirSync(dirname(dest),{recursive:true});cpSync(join(roots[0],name),dest,{recursive:true});
}
const manifest={status:'R7_LED_DIAGNOSTIC / REAL_PENDING',S6:'IN_PROGRESS',S7:'IN_PROGRESS',
 previous:previous,previousStatus:'R6 REAL_FAIL',independentFirmware:true,nonUltraGSImagesByteIdenticalToR6:true,
 pioProgramByteIdenticalToR6:true,standardExesReused:true,
 sources:Object.fromEntries(sourcePaths.map(p=>[p,sha256(readFileSync(p))])),
 files:Object.fromEntries([...files].map(([n,b])=>[n,{size:b.length,sha256:sha256(b)}])),evidence:{}};
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())walk(p);else manifest.evidence[p.slice(out.length+1)]=sha256(readFileSync(p));}}
walk(join(out,'led-evidence'));
writeFileSync(join(out,'LED.json'),JSON.stringify(manifest,null,2)+'\n');
for(const [n,e] of Object.entries(manifest.files))assert.equal(sha256(readFileSync(join(out,n))),e.sha256);
for(const [n,h] of Object.entries(manifest.evidence))assert.equal(sha256(readFileSync(join(out,n))),h);
if(process.argv.includes('--publish')) {
 const tmp=resolve('build/latest-led.tmp');assert(!existsSync(tmp));symlinkSync(out,tmp,'dir');renameSync(tmp,resolve('build/latest'));
}
console.log(JSON.stringify({directory:out,firmware:manifest.files['CURRENT.UF2'],zip:manifest.files['CURRENT.ZIP'],
 evidenceFiles:Object.keys(manifest.evidence).length,status:manifest.status},null,2));
