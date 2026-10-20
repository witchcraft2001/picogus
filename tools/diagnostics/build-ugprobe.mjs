// SPDX-License-Identifier: GPL-2.0-or-later
// A diagnostic supplement, not a new production firmware or acceptance.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,cpSync,realpathSync,symlinkSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {sha256} from '../ultrags/build-evidence.mjs';
import {makeZip,makeImg} from '../ultrags/disk-formats.mjs';
import {readZip,readFat12} from '../ultrags/verify-package.mjs';
import {verifyVoices} from '../ultrags/verify-voices.mjs';
const root=resolve('.'),out=resolve(process.argv[2]??'build/boot-probe-20261020');
assert(!existsSync(out),'do not overwrite a frozen diagnostic');
const previous=realpathSync('build/latest');verifyVoices(previous);
const source='host/sprinter/diagnostics/ugprobe.asm',gen='build/voices-r2-a/ultrags/gen';
const includes=['host/sprinter/ultrags/lib','host/sprinter/ultrags/include',gen];
const version=spawnSync('sjasmplus',['--version'],{encoding:'utf8'});assert.equal(version.status,0);assert((version.stdout+version.stderr).includes('v1.22.0'));
const Z80=loadZ80(root),kits=[],proof=[];
for(const build of ['A','B']){
 const dir=join(out,'probe-evidence',build);mkdirSync(dir,{recursive:true});const entries=new Map(),results=[];
 for(const slot of [0,1]){
  const name=`UGP${slot}.EXE`,path=join(dir,name);
  execFileSync('sjasmplus',[...includes.map(p=>'--inc='+p),`-DPROBE_SLOT=${slot}`,'--raw='+path,'--lst='+join(dir,`UGP${slot}.lst`),source],{stdio:'pipe'});
  const bytes=readFileSync(path),h=parseExe(bytes);entries.set(name,bytes);
  for(const [state,values] of [['discovery-failed-native-alive',[255,0,0]],['all-FF',[255,255,255]],['native-initializing',[255,4,0]],['configuration-alive',[1,0,0]],['transport-error',[255,32,17]]])
   for(const iff of [0,1])for(const turbo of [false,true]){
    const reads=[];const card={base:0x2a0,alias:65535,tickUs(){},readPort(p){reads.push(p);assert([0x1d0,0x2a1,0x2a6].includes(p));return values[[0x1d0,0x2a1,0x2a6].indexOf(p)];},writePort(){throw Error('diagnostic wrote a card port');}};
    const m=new SprinterMachine({card,cardSlot:slot,seed:results.length+123,page3Init:0x19,turboInit:turbo,logLimit:100});m.mem.set(bytes,h.loadAddr);
    const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff});assert.equal(r.exitCode,0,m.text);assert.deepEqual(m.violations,[]);
    assert.equal(m.page3,0x19);assert.equal(m.system,1);assert.equal(m.turbo,true);assert.equal(!!r.end.iff1,!!iff);
    assert.deepEqual(reads,Array.from({length:16},()=>[0x1d0,0x2a1,0x2a6]).flat());assert(m.isaLog.every(x=>x.dir==='r'&&x.slot===slot));
    const line=`CFG_1D0=${hex(values[0])} STATUS_2A1=${hex(values[1])} ERROR_2A6=${hex(values[2])}`;
    assert.equal(m.text.split(line).length-1,16,m.text);assert(!m.text.includes('RESULT PASS'));
    results.push({name,state,iff,turbo,exit:r.exitCode,sha256:sha256(bytes),steps:r.steps});
   }
 }
 kits.push(entries);const report={status:'ACTUAL_EXE_DIAGNOSTIC_PASS / HARDWARE_RESULT_UNKNOWN',results};proof.push(report);
 writeFileSync(join(dir,'actual-exe.json'),JSON.stringify(report,null,2)+'\n');
}
for(const [n,b]of kits[0])assert.deepEqual(kits[1].get(n),b);
const notes=Buffer.from(`Диагностика отказа старта ULTRAGS, 2026-10-20.\r\nЭто диагностическое дополнение; оно не меняет UF2 и основные UG EXE.\r\nПосле неудачного UGCFG ULTRAGS, не выключая карту, запустить UGP0\r\n(только для известной карты в слоте0 и native BASE=02A0).\r\nUGP1 — тот же probe для карты в слоте1. Пришлите полный вывод.\r\nЧитаются только CFG selector 1D0, native STATUS 2A1, ERROR 2A6.\r\nНет записи портов карты, потребления DATA/RESPONSE, SAVE или reset.\r\nСохраняются PAGE3/IFF; переключение Turbo2->ISA->3 как в UG утилитах.\r\nCOMPLETE означает завершение сбора данных, не исправность карты.\r\nНе запускать на неизвестных устройствах/другом BASE.\r\n`);
const payload=new Map([...kits[0],['TESTER.TXT',notes],['UGPROBE.ASM',readFileSync(source)]]);
payload.set('HASHES.TXT',Buffer.from([...payload].map(([n,b])=>`${sha256(b)}  ${n}`).join('\r\n')+'\r\n'));
const zip=makeZip([...payload]),img=makeImg([...payload]);
for(const extracted of [readZip(zip),readFat12(img)])for(const [n,b]of payload)assert.deepEqual(extracted.get(n),b);
// Preserve every byte of the preceding frozen delivery, add a clearly
// separate read-only diagnostic, and atomically retain the stable path.
for(const name of ['UGP0.EXE','UGP1.EXE','TESTER.TXT'])writeFileSync(join(out,'probe-evidence',name),payload.get(name));
const production=JSON.parse(readFileSync(join(previous,'DELIVERY.json')));
for(const name of [...production.files.map(e=>e.name),'DELIVERY.json','evidence'])
 cpSync(join(previous,name),join(out,name),{recursive:true});
for(const [n,b]of kits[0])writeFileSync(join(out,n),b);
writeFileSync(join(out,'BOOTPROB.ZIP'),zip);writeFileSync(join(out,'BOOTPROB.IMG'),img);
const inputs=Object.fromEntries([source,'host/sprinter/ultrags/lib/isa.asm','host/sprinter/ultrags/include/ugmem.inc',join(gen,'ug_wire.inc'),
 'tests/ultrags/dss/ug-harness.mjs','tests/ultrags/dss/Z80core.js','tools/diagnostics/build-ugprobe.mjs'].map(p=>[p,sha256(readFileSync(p))]));
writeFileSync(join(out,'PROBE.json'),JSON.stringify({status:'DIAGNOSTIC_ONLY / REAL_PENDING',inputs,proof,
 files:Object.fromEntries([...kits[0],['BOOTPROB.ZIP',zip],['BOOTPROB.IMG',img]].map(([n,b])=>[n,{bytes:b.length,sha256:sha256(b)}]))},null,2)+'\n');
verifyVoices(out,{mutations:true});
if(process.argv.includes('--publish')){
 const temp=resolve('build/latest-probe.tmp');assert(!existsSync(temp));symlinkSync(out,temp,'dir');renameSync(temp,resolve('build/latest'));
}
console.log('Read-only diagnostic: two independent assemblies, 80 actual-EXE cases, ZIP/IMG byte identity PASS:',out);
function hex(n){return n.toString(16).toUpperCase().padStart(2,'0');}
