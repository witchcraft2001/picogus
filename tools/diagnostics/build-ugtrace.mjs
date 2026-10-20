// SPDX-License-Identifier: GPL-2.0-or-later
// Freeze a separately named diagnostic; never replace the production UF2.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,cpSync,realpathSync,symlinkSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {sha256} from '../ultrags/build-evidence.mjs';
import {makeZip,makeImg} from '../ultrags/disk-formats.mjs';
import {readZip,readFat12} from '../ultrags/verify-package.mjs';
import {verifyVoices} from '../ultrags/verify-voices.mjs';
const out=resolve(process.argv[2]),previous=realpathSync('build/latest');
assert(!existsSync(out),'do not overwrite frozen delivery');verifyVoices(previous);
const fw=['a','b'].map(x=>resolve(`build/config-trace-${x}/multifw-release`));
const firmware=fw.map(p=>readFileSync(join(p,'picogus.uf2')));
assert.deepEqual(firmware[0],firmware[1],'independent firmware differs');
const header=readFileSync(join(fw[0],'ug_handshake_ior.pio.h'));
assert.deepEqual(header,readFileSync('build/cfg-r3-a/multifw-release/ug_handshake_ior.pio.h'),'diagnostic changed PIO');
for(const p of fw){assert(readFileSync(join(p,'CMakeFiles/pg-ultrags-multifw.dir/flags.make'),'utf8').includes('-DUG_CONFIG_TRACE=1'));}
const source='host/sprinter/diagnostics/ugtrace.asm',includes=['host/sprinter/ultrags/lib','host/sprinter/ultrags/include','build/voices-r2-a/ultrags/gen'];
const Z80=loadZ80(resolve('.')),kits=[],proof=[];
for(const kit of ['A','B']){
 const dir=join(out,'trace-evidence',kit);mkdirSync(dir,{recursive:true});const payload=new Map(),results=[];
 for(const slot of [0,1]){
  const name=`TRC${slot}.EXE`,path=join(dir,name);
  execFileSync('sjasmplus',[...includes.map(p=>'--inc='+p),`-DPROBE_SLOT=${slot}`,'--raw='+path,'--lst='+join(dir,name+'.lst'),source],{stdio:'pipe'});
  const bytes=readFileSync(path),h=parseExe(bytes);payload.set(name,bytes);
  for(const values of [[1,0,1,1,255,20],[1,0,1,1,42,30],[1,0,0,255,0,0],[255,255,255,255,255,255]])
   for(const iff of [0,1])for(const turbo of [false,true]){
    const ports=[0x2a1,0x2a6,0x2bc,0x2bd,0x2be,0x2bf],reads=[];
    const card={base:0x2a0,alias:65535,tickUs(){},readPort(p){reads.push(p);assert(ports.includes(p),'unexpected/consuming read');return values[ports.indexOf(p)];},writePort(){throw Error('card write');}};
    const m=new SprinterMachine({card,cardSlot:slot,seed:results.length+123,page3Init:0x19,turboInit:turbo,logLimit:300});m.mem.set(bytes,h.loadAddr);
    const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff});assert.equal(r.exitCode,0,m.text);assert.deepEqual(m.violations,[]);
    assert.equal(m.page3,0x19);assert.equal(m.system,1);assert.equal(m.turbo,true);assert.equal(!!r.end.iff1,!!iff);
    assert.deepEqual(reads,Array.from({length:16},()=>ports).flat());assert(m.isaLog.every(x=>x.dir==='r'&&x.slot===slot));
    const line=`STATUS=${hex(values[0])} ERROR=${hex(values[1])} SEL=${hex(values[2])} RAW=${hex(values[3])} COUNT=${hex(values[4])} FLAGS=${hex(values[5])}`;
    assert.equal(m.text.split(line).length-1,16,m.text);assert(!m.text.includes('RESULT PASS'));
    results.push({name,values,iff,turbo,sha256:sha256(bytes),steps:r.steps});
   }
 }
 kits.push(payload);proof.push(results);writeFileSync(join(dir,'actual-exe.json'),JSON.stringify(results,null,2)+'\n');
}
for(const [name,bytes] of kits[0])assert.deepEqual(kits[1].get(name),bytes);
const notes=Buffer.from(`CONFIG TRACE — diagnostic, not a fix/acceptance.\r\nR3 REAL FAIL: 2026-10-20 10:13. Native works, CONFIG reads FF.\r\nFlash CFGTRACE.UF2 via USB BOOTSEL. Use the existing UGCFG.EXE.\r\nCold start, same known slot0 and BASE02A0. Commands:\r\nUGCFG ULTRAGS\r\nTRC0\r\nPhotograph all output. If switch passes, still run TRC0. No SAVE.\r\nKnown slot1: use UGCFG ULTRAGS /SLOT 1 and TRC1.\r\nDo not run other UG commands between switch and TRC0/1.\r\nTRC reads native STATUS/ERROR and four diagnostic registers only.\r\nSEL=accepted selector; RAW=last captured write to1D0; COUNT=CONFIG\r\nread count (saturates FF); FLAGS=last CONFIG capture state.\r\nFLAGS bits:0=PIO ownership,1=IOR low after capture,2=address matches,\r\n3=eligible for service,4=config unlocked,5=fuse failed,6..7=port-1D0.\r\nTrace adds instructions and can affect timing. It does not measure ns.\r\nTRC never writes card ports, reads CONFIG or consumes DATA/RESPONSE.\r\nTemporary native+1C..1F overlay exists ONLY in CFGTRACE.UF2, not API1.0.\r\nUse only the known PicoGUS slot and BASE02A0. Restore PGMULTI.UF2\r\nfor normal testing; R3 production firmware remains a known REAL FAIL.\r\n`);
const host=new Map([...kits[0],['TRACE.TXT',notes],['UGTRACE.ASM',readFileSync(source)]]);
host.set('HASHES.TXT',hashes(host));const img=makeImg([...host]);
for(const [n,b] of host)assert.deepEqual(readFat12(img).get(n),b);
const full=new Map([...kits[0],['TRACE.TXT',notes],['CFGTRACE.UF2',firmware[0]],['TRACE.IMG',img]]);full.set('HASHES.TXT',hashes(full));
const zip=makeZip([...full]);for(const [n,b] of full)assert.deepEqual(readZip(zip).get(n),b);
// Keep historical production bytes and their evidence; add explicit current status.
for(const name of [...JSON.parse(readFileSync(join(previous,'DELIVERY.json'))).files.map(e=>e.name),'DELIVERY.json','evidence'])cpSync(join(previous,name),join(out,name),{recursive:true});
const files=new Map([...kits[0],['CFGTRACE.UF2',firmware[0]],['CFGTRACE.ZIP',zip],['CFGTRACE.IMG',img],['TRACE.TXT',notes]]);
for(const [n,b] of files)writeFileSync(join(out,n),b);
writeFileSync(join(out,'STATUS.TXT'),'R3 REAL FAIL (2026-10-20 10:13). PGMULTI.UF2 is the historical R3. CFGTRACE.UF2 is a separate diagnostic, not a fix. Read TRACE.TXT. S6/S7 IN_PROGRESS.\n');
for(let i=0;i<fw.length;i++)for(const n of ['CMakeCache.txt','pg-ultrags-multifw.elf','ug_handshake_ior.pio.h','generated/multifw/catalog.bin']){const dest=join(out,'trace-evidence',i?'B':'A',n);mkdirSync(resolve(dest,'..'),{recursive:true});cpSync(join(fw[i],n),dest);}
const paths=[source,'host/sprinter/ultrags/lib/isa.asm','host/sprinter/ultrags/include/ugmem.inc','sw/picogus.cpp','sw/CMakeLists.txt','sw/ultrags/ug_handshake.c','sw/ultrags/ug_handshake.h','sw/ultrags/ug_handshake_ior.pio','tools/ultrags/config-exchange.py','tools/diagnostics/build-ugtrace.mjs'];
writeFileSync(join(out,'TRACE.json'),JSON.stringify({status:'DIAGNOSTIC_ONLY / REAL_PENDING',productionHardware:'R3 REAL_FAIL',independentFirmware:true,proof,
 firmwareBuilds:fw.map(p=>({path:p,sha256:sha256(readFileSync(join(p,'picogus.uf2'))),elfSha256:sha256(readFileSync(join(p,'pg-ultrags-multifw.elf'))),cacheSha256:sha256(readFileSync(join(p,'CMakeCache.txt')))})),
 inputs:Object.fromEntries(paths.map(p=>[p,sha256(readFileSync(p))])),files:Object.fromEntries([...files].map(([n,b])=>[n,{bytes:b.length,sha256:sha256(b)}]))},null,2)+'\n');
cpSync('build/config-trace-check',join(out,'trace-evidence','production-C'),{recursive:true});
verifyVoices(out,{mutations:true});
if(process.argv.includes('--publish')){const temp=resolve('build/latest-trace.tmp');assert(!existsSync(temp));symlinkSync(out,temp,'dir');renameSync(temp,resolve('build/latest'));}
console.log('Diagnostic: independent firmware and EXEs identical; 64 actual-EXE cases; native-only reads, contexts, ZIP/IMG PASS:',out);
function hex(n){return n.toString(16).toUpperCase().padStart(2,'0');}
function hashes(map){return Buffer.from([...map].map(([n,b])=>`${sha256(b)}  ${n}`).join('\r\n')+'\r\n');}
