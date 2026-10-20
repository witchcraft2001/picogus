// SPDX-License-Identifier: GPL-2.0-or-later
// Differential IOW probe for the already flashed R4. No new UF2.
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
const source='host/sprinter/diagnostics/ugwrite.asm',includes=['host/sprinter/ultrags/lib','host/sprinter/ultrags/include','build/voices-r2-a/ultrags/gen'];
const Z80=loadZ80(resolve('.')),kits=[],proof=[];
for(const kit of ['A','B']){
 const dir=join(out,'write-evidence',kit);mkdirSync(dir,{recursive:true});const payload=new Map(),results=[];
 for(const slot of [0,1]){
  const name=`UGW${slot}.EXE`,path=join(dir,name);
  execFileSync('sjasmplus',[...includes.map(p=>'--inc='+p),`-DPROBE_SLOT=${slot}`,'--raw='+path,'--lst='+join(dir,name+'.lst'),source],{stdio:'pipe'});
  const bytes=readFileSync(path),h=parseExe(bytes);payload.set(name,bytes);
  for(const scenario of ['both','native-only','config-only','no-writes','busy','existing-error'])
   for(const iff of [0,1])for(const turbo of [false,true]){
    const writes=[],reads=[];let error=scenario==='existing-error'?2:0,unlocked=false,selector=0,raw=255;
    const native=['both','native-only'].includes(scenario),cfg=['both','config-only'].includes(scenario);
    const unsafe=['busy','existing-error'].includes(scenario);
    const card={base:0x2a0,alias:65535,tickUs(){},readPort(p){reads.push(p);switch(p){
     case 0x2a1:return (scenario==='busy'?129:1)|(error?32:0);
     case 0x2a6:return error;
     case 0x1d0:return cfg?selector:255;
     case 0x1d2:return cfg&&selector===1?4:255;
     case 0x2bc:return selector;
     case 0x2bd:return raw;
     case 0x2bf:return 0x8e|(unlocked?16:0);
     default:throw Error('unexpected/consuming read '+p.toString(16));
    }},writePort(p,v){writes.push([p,v]);assert(!unsafe,'wrote while busy/error');
     if(p===0x2a2){assert(v===255||v===162);if(native)error=v===255?2:0;}
     else{assert.equal(p,0x1d0);assert(v===204||v===1);if(cfg){raw=v;if(v===204)unlocked=true;else if(unlocked)selector=v;}}
    }};
    const m=new SprinterMachine({card,cardSlot:slot,seed:results.length+321,page3Init:0x19,turboInit:turbo,logLimit:300});m.mem.set(bytes,h.loadAddr);
    const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff});assert.equal(r.exitCode,unsafe?2:0,m.text);assert.deepEqual(m.violations,[]);
    assert.equal(m.page3,0x19);assert.equal(m.system,1);assert.equal(m.turbo,true);assert.equal(!!r.end.iff1,!!iff);
    assert(m.isaLog.every(x=>x.slot===slot));assert(!m.text.includes('RESULT PASS'));
    if(unsafe){assert.deepEqual(writes,[]);assert.deepEqual(reads,[0x2a1,0x2a6]);assert(m.text.includes('ABORT:'));}
    else{
     assert.deepEqual(writes,[[0x2a2,255],[0x2a2,162],[0x1d0,204],[0x1d0,1]]);
     assert.deepEqual(reads,[0x2a1,0x2a6,0x2a1,0x2a6,0x2a1,0x2a6,0x1d0,0x1d2,0x2bc,0x2bd,0x2bf]);
     assert(m.text.includes(`NATIVE FF: STATUS=${native?'21':'01'} ERROR=${native?'02':'00'}`),m.text);
     assert(m.text.includes('NATIVE A2: STATUS=01 ERROR=00'),m.text);
     assert(m.text.includes(`CONFIG: SEL=${cfg?'01':'FF'} PROTO=${cfg?'04':'FF'}`),m.text);
     assert.equal(error,0);assert(m.text.includes('DIAGNOSTIC COMPLETE'));
    }
    results.push({name,scenario,iff,turbo,exit:r.exitCode,sha256:sha256(bytes),steps:r.steps,text:m.text});
   }
 }
 kits.push(payload);proof.push(results);writeFileSync(join(dir,'actual-exe.json'),JSON.stringify(results,null,2)+'\n');
}
for(const [name,bytes] of kits[0])assert.deepEqual(kits[1].get(name),bytes);
// Check the exact expected invalid-command/clear behavior in production C,
// not merely the independently implemented Z80 harness card.
const fixture=resolve('build/config-fast-a/fixture');
const deps=JSON.parse(readFileSync(join(fixture,'config-exchange-inputs.json')));
for(const [name,hash]of Object.entries(deps))assert.equal(sha256(readFileSync(resolve(name))),hash,'stale fixture '+name);
const c=join(out,'write-evidence/native-expected.c'),obj=join(out,'write-evidence/native-expected.o'),exe=join(out,'write-evidence/native-expected');
writeFileSync(c,`#define main config_exchange_reference_main
#include "${join(fixture,'config-exchange.c')}"
#undef main
int main(int argc,char **argv){
 assert(argc==2);config_exchange_reference_main(argc,argv);
 ug_minimal_init();ug_minimal_ready(0,123);control_active=false;sel_reg=0;
 assert(bus_read(0x2a1)==1 && bus_read(0x2a6)==0);
 bus_write(0x2a2,255);assert(bus_read(0x2a1)==33 && bus_read(0x2a6)==2);
 bus_write(0x2a2,162);assert(bus_read(0x2a1)==1 && bus_read(0x2a6)==0);
 bus_write(0x1d0,204);bus_write(0x1d0,1);
 assert(control_active && bus_read(0x1d0)==1 && bus_read(0x1d2)==PICOGUS_PROTOCOL_VER);
 return 0;
}
`);
execFileSync('cc',['-std=c11','-DSOUND_ULTRAGS=1','-DUG_ISA_EARLY_READ=1','-DUG_BUNDLE=1','-fsanitize=undefined','-fno-sanitize-recover=all',...['common','sw','tests/ultrags/unit/s2_mock',join(fixture,'gen')].map(p=>'-I'+resolve(p)),'-c',c,'-o',obj],{stdio:'pipe'});
execFileSync('c++',['-fsanitize=undefined',obj,...[1,2,3,4,5].map(i=>join(fixture,`config-exchange-${i}.o`)),'-o',exe],{stdio:'pipe'});
const cOutput=execFileSync(exe,[resolve('build/config-fast-a/multifw-release/generated/multifw/catalog.bin')]);
writeFileSync(join(out,'write-evidence/production-C-output.txt'),cOutput);
const notes=Buffer.from(`IOW DIFFERENTIAL PROBE — NO FLASHING REQUIRED.\r\nUse the already installed R4 CFGCAP.UF2. Copy UGW0.EXE to Sprinter.\r\nImmediately after failed UGCFG ULTRAGS run: UGW0\r\nKnown slot1: UGW1. Known native BASE02A0 only. Photograph full output.\r\nRequires initial native STATUS01 ERROR00, otherwise aborts without writes.\r\nFF to native CONTROL intentionally sets ERROR02; A2 clears it.\r\nThen CC/01 to CONFIG performs only unlock/selector (no mode or SAVE).\r\nEach access has its own ISA window; PAGE3/IFF and Turbo2->ISA->3 retained.\r\nExpected: NATIVE FF ERROR02, NATIVE A2 ERROR00; CONFIG SEL01 PROTO04.\r\nThis separates a dead IOW path from CONFIG-only writes failing.\r\nNo object, DATA/RESPONSE, Flash, mode switch or reset operations.\r\nDIAGNOSTIC COMPLETE is not hardware acceptance.\r\n`);
const host=new Map([...kits[0],['WPROBE.TXT',notes],['UGWRITE.ASM',readFileSync(source)]]);host.set('HASHES.TXT',hashes(host));
const zip=makeZip([...host]),img=makeImg([...host]);for(const entries of [readZip(zip),readFat12(img)])for(const[n,b]of host)assert.deepEqual(entries.get(n),b);
// Keep the frozen R4 candidate intact. Its new REAL FAIL is explicit below.
for(const name of ['DELIVERY.json','evidence',...JSON.parse(readFileSync(join(previous,'DELIVERY.json'))).files.map(e=>e.name),'TRACE.json','trace-evidence','CFGCAP.UF2','CFGCAP.ZIP','CFGCAP.IMG','TRC0.EXE','TRC1.EXE','TRACE.TXT'])cpSync(join(previous,name),join(out,name),{recursive:true});
const files=new Map([...kits[0],['WRPROBE.ZIP',zip],['WRPROBE.IMG',img],['WPROBE.TXT',notes]]);
for(const[n,b]of files)writeFileSync(join(out,n),b);
writeFileSync(join(out,'STATUS.TXT'),'R4 REAL FAIL (2026-10-20 11:21). No new UF2. Use UGW0 on the installed R4; see WPROBE.TXT. PGMULTI.UF2 and CFGCAP.UF2 are historical failed candidates. S6/S7 IN_PROGRESS.\n');
const paths=[source,'tools/diagnostics/build-ugwrite.mjs','host/sprinter/ultrags/lib/isa.asm','host/sprinter/ultrags/include/ugmem.inc','tests/ultrags/dss/ug-harness.mjs','tests/ultrags/dss/Z80core.js'];
writeFileSync(join(out,'WRITE-PROBE.json'),JSON.stringify({status:'DIAGNOSTIC_ONLY / REAL_PENDING',hardware:'R4 REAL_FAIL',proof,productionC:{status:'PASS',inputs:deps,outputSha256:sha256(cOutput)},inputs:Object.fromEntries(paths.map(p=>[p,sha256(readFileSync(p))])),files:Object.fromEntries([...files].map(([n,b])=>[n,{bytes:b.length,sha256:sha256(b)}]))},null,2)+'\n');
verifyVoices(out,{mutations:true});
if(process.argv.includes('--publish')){const temp=resolve('build/latest-write.tmp');assert(!existsSync(temp));symlinkSync(out,temp,'dir');renameSync(temp,resolve('build/latest'));}
console.log('No-flash write probe:96 actual-EXE scenarios, two independent assemblies, exact four writes/context/ZIP/IMG and production C expectations PASS:',out);
function hashes(map){return Buffer.from([...map].map(([n,b])=>`${sha256(b)}  ${n}`).join('\r\n')+'\r\n');}
