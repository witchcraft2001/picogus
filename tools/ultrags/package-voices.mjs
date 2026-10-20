// SPDX-License-Identifier: GPL-2.0-or-later
// Two independently built and executed initial API 1.0 VLS1 kits.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync,lstatSync,symlinkSync,renameSync,existsSync} from 'node:fs';
import {resolve,join,relative,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {repoRoot,verifyBuild,verifyExecution,sha256} from './build-evidence.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
import {readZip,readFat12} from './verify-package.mjs';
import {verifyVoices} from './verify-voices.mjs';

const builds=[resolve(process.argv[2]??'build/voices-a'),resolve(process.argv[3]??'build/voices-b')];
const out=resolve(process.argv[4]??'build/voices-review'),publish=process.argv.includes('--publish');
assert.notEqual(builds[0],builds[1],'independent build directories required');
assert(!existsSync(out),'a frozen delivery must not be overwritten');
const notes=readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/API1-VOICES.md'));
const proof=[],kits=[];
const reports=['voices-host.json','ultrags/dss/asm-manifest.json','ultrags/logs/ugdiag-run.json',
 'ultrags/logs/config-regression.json','ultrags/logs/turbo-contract.json','ultrags/logs/s2-run.json',
 'ultrags/logs/s3-run.json','ultrags/logs/s4-run.json','ultrags/logs/s5-run.json','ultrags/logs/s6-run.json',
 'ultrags/throughput/throughput.json','host/s6/s6-host-evidence.json','host/s7/s7-host-evidence.json',
 's7-dss-evidence.json','native/native-card-build.json','host/native/actual-exe.json','host/review/held-pages.json',
 'protocol/logs/protocol-tests.json','host/firmware-paths/paths.json','host/pio-isa.json',
 'host/guard/guard.json','host/psram-id.json','host/save-clock.json','host/audio-render.json',
 'host/budgets/budgets.json','s7-stack.json','multifw-release/generated/multifw/flash-map.json','host/config-read-arm.json','host/write-window/write-window.json','host/config-read-deadline.json'];
for(const build of builds){
 const dir=join(build,'ultrags/dss'),assembly=verifyBuild(repoRoot,dir),execution=verifyExecution(repoRoot,dir);
 for(const tool of ['voices-host.py','voices-firmware.py'])
  execFileSync(process.env.UG_PYTHON??'python3',[join(repoRoot,'tools/ultrags',tool),'--build',build,...(tool==='voices-host.py'?['--verify-only']:[])],{stdio:'inherit'});
 const native=JSON.parse(readFileSync(join(build,'host/native/actual-exe.json')));
 assert.deepEqual(native.assembly,assembly);
 for(const [app,image] of Object.entries(native.images))assert.deepEqual(image,(({sha256,size})=>({sha256,size}))(assembly.files.find(e=>e.name===app+'.EXE')));
 const firmware=readFileSync(join(build,'multifw-release/picogus.uf2'));
 const payload=new Map(assembly.files.filter(e=>!e.name.startsWith('ST-')).map(e=>[e.name,readFileSync(join(dir,e.name))]));
 assert.equal(payload.size,9);
 payload.set('FX66_WAV.WAV',readFileSync(join(build,'ultrags/fixtures/wav-s16le-stereo-44100.wav')));
 payload.set('TESTER.TXT',notes);
 payload.set('REPORT.TXT',Buffer.from('ULTRAGS initial API 1.0 VLS1; common protocol 4; 32 shared voices.\r\nHOST actual EXE / linked ARM / generated PIO PASS.\r\nREAL_PENDING; S7 IN_PROGRESS.\r\nInstall PGMULTI.UF2 and all UG EXEs from this kit together.\r\nPIO instruction simulation and ARM instruction counts do not prove physical bus/audio deadlines.\r\n'));
 payload.set('HASHES.TXT',Buffer.from([...payload].sort(([a],[b])=>a.localeCompare(b)).map(([n,d])=>`${sha256(d)}  ${n}`).join('\r\n')+'\r\n'));
 const entries=[...payload].sort(([a],[b])=>a.localeCompare(b));
 for(const [name] of entries)assert.match(name,/^[A-Z0-9_-]{1,8}\.[A-Z0-9]{1,3}$/);
 const hostZip=makeZip(entries),hostImg=makeImg(entries);
 assert.deepEqual([...readZip(hostZip)],entries);assert.deepEqual([...readFat12(hostImg)],entries);
 const fullPayload=new Map([...entries,['PGMULTI.UF2',firmware],['UGHOST.IMG',hostImg]]);
 const fullHashes=Buffer.from([...fullPayload].filter(([n])=>n!=='HASHES.TXT').sort(([a],[b])=>a.localeCompare(b)).map(([n,d])=>`${sha256(d)}  ${n}`).join('\r\n')+'\r\n');
 fullPayload.set('HASHES.TXT',fullHashes);
 const fullEntries=[...fullPayload].sort(([a],[b])=>a.localeCompare(b));
 const fullZip=makeZip(fullEntries);assert.deepEqual([...readZip(fullZip)],fullEntries);
 // Prove extracted payloads are the actual executed EXEs, not just names.
 for(const container of [readZip(hostZip),readFat12(hostImg),readZip(fullZip)])for(const e of assembly.files.filter(e=>!e.name.startsWith('ST-')))
  assert.equal(sha256(container.get(e.name)),e.sha256,e.name+' executed/package identity');
 // The disk has its DSS 8.3 name inside the full archive, and the stable
 // historical filename in the flat download directory. Hash each namespace.
 const flatPayload=new Map([...entries,['PGMULTI.UF2',firmware],['ug-host.img',hostImg]]);
 const flatHashes=Buffer.from([...flatPayload].filter(([n])=>n!=='HASHES.TXT').sort(([a],[b])=>a.localeCompare(b)).map(([n,d])=>`${sha256(d)}  ${n}`).join('\r\n')+'\r\n');
 const kit=new Map([...entries,['HASHES.TXT',flatHashes],['PGMULTI.UF2',firmware],['ug-host.zip',hostZip],['ug-host.img',hostImg],['ug-full.zip',fullZip]]);
 const staged=join(build,'ultrags/voices-package');mkdirSync(staged,{recursive:true});
 for(const [name,data] of kit)writeFileSync(join(staged,name),data);
 kits.push(kit);
 proof.push({build,execution,executedExes:assembly.files,firmwareSha256:sha256(firmware),
  reports:Object.fromEntries(reports.map(path=>[path,sha256(readFileSync(join(build,path)))]))});
}
assert.deepEqual(proof[0].executedExes,proof[1].executedExes);
assert.deepEqual([...kits[0]],[...kits[1]],'independent firmware/EXE/ZIP/IMG bytes differ');
mkdirSync(out);
for(const [name,data] of kits[0])writeFileSync(join(out,name),data);
for(const [name,data] of kits[0])assert.deepEqual(readFileSync(join(out,name)),data,'written delivery differs: '+name);
for(let i=0;i<builds.length;i++)for(const path of reports){const dest=join(out,'evidence',i?'B':'A',path);mkdirSync(dirname(dest),{recursive:true});cpSync(join(builds[i],path),dest);}
const files=[...kits[0]].map(([name,data])=>({name,size:data.length,sha256:sha256(data)}));
const delivery={status:'SOFTWARE_PASS / REAL_PENDING',S7:'IN_PROGRESS',api:'1.0 VLS1',commonProtocol:4,voices:32,
 independentMatch:true,proof,files,toolSha256:sha256(readFileSync(new URL(import.meta.url))),
 limits:['Physical ISA coexistence and audio wall-clock/SRAM contention gates remain pending',
 'Unchanged PROPLAY is executed in the functional DSS/SDK model, not on the physical Sprinter',
 'No measured physical upload/download speed is claimed for this firmware',
 'Current formats RAW/WAV/MOD4; S3M/XM/IT/MOD8/playlist remain separate work']};
writeFileSync(join(out,'DELIVERY.json'),JSON.stringify(delivery,null,2)+'\n');
console.log('Independent frozen-delivery verification:',verifyVoices(out,{mutations:true}));
if(publish){
 const latest=join(repoRoot,'build/latest'),temp=join(repoRoot,'build/latest-voices.tmp');
 if(existsSync(latest))assert(lstatSync(latest).isSymbolicLink(),'latest must be a symlink; preserve existing directory');
 assert(!existsSync(temp),'temporary publication path already exists');
 symlinkSync(relative(dirname(latest),out),temp);renameSync(temp,latest);
}
console.log('Two independent firmware/EXE/ZIP/IMG kits and extracted executed-byte identity PASS:',out,publish?'-> build/latest':'');
