// SPDX-License-Identifier: GPL-2.0-or-later
// Freeze two executed host-only updates. Never mutate a published delivery.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {repoRoot,verifyExecution,verifyBuild,sha256} from './build-evidence.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
import {readZip,readFat12} from './verify-package.mjs';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {SlowCard} from '../../tests/ultrags/dss/slow-card.mjs';
import {crc32} from '../../tests/ultrags/dss/config-card.mjs';
const builds=[resolve(process.argv[2]||'build/cfg-native-a'),resolve(process.argv[3]||'build/cfg-native-b')];
const prior=resolve(process.argv[4]||'build/audio-load-review'),out=resolve(process.argv[5]||'build/file-io-review');
const changed=['UGDUMP.EXE','UGLOAD.EXE','UGPLAY.EXE'];
const previous=readZip(readFileSync(join(prior,'ug-cfg.zip'))),firmware=readFileSync(join(prior,'PGMULTI.UF2'));
assert.equal(sha256(firmware),'f5b24f9cd92d38e7ee0b75294fae0c0dc3fd52271adcdf4d825811573bf13cea');
const proofs=[];
for(const build of builds){
 const dir=join(build,'ultrags/dss'),execution=verifyExecution(repoRoot,dir),assembly=verifyBuild(repoRoot,dir);
 execFileSync(process.execPath,[join(repoRoot,'tools/ultrags/verify-package.mjs'),'--stage','CFG','--package',join(build,'ultrags/cfg-package'),'--exe-dir',dir,'--fixtures',join(build,'ultrags/fixtures')],{stdio:'pipe'});
 execFileSync(process.execPath,[join(repoRoot,'tools/ultrags/s7-report.mjs'),'--build',build,'--verify-only'],{stdio:'pipe'});
 assert.deepEqual(assembly.files.filter(x=>sha256(previous.get(x.name))!==x.sha256).map(x=>x.name),changed);
 assert.equal(assembly.files.length,[...previous.keys()].filter(n=>n.endsWith('.EXE')).length);
 assert.deepEqual(readFileSync(join(build,'ultrags/cfg-package/PGMULTI.UF2')),firmware);
 const s4=JSON.parse(readFileSync(join(build,'ultrags/logs/s4-run.json')));
 assert(s4.results.every(x=>x.ok));
 for(const prefix of ['DSS FAT flush DE=','short write with clobbered DE','invalid write position delta ','write position query error ','cap256 file upload ESC','cap256 file dump ESC','file cap256 load tail ','file cap256 dump tail '])
  assert(s4.results.some(x=>x.name.startsWith(prefix)),prefix);
 const speed=JSON.parse(readFileSync(join(build,'ultrags/throughput/throughput.json')));
 const comparisons=speed.results.filter(x=>x.name.includes('cap8 versus cap256'));
 assert.equal(comparisons.length,4);assert(comparisons.every(x=>x.ok&&x.simulatedRatio>1.33));
 proofs.push({build,execution,assembly:assembly.files,comparisons,s4Checks:s4.results.length});
}
assert.deepEqual(proofs[0].assembly,proofs[1].assembly);
for(const name of ['ug-cfg.zip','ug-cfg.img'])assert.deepEqual(readFileSync(join(builds[0],'ultrags/cfg-package',name)),readFileSync(join(builds[1],'ultrags/cfg-package',name)));
// Reproduce the released 1024-byte failure using the identical DSS/card
// model for old and new machine code, including short writes and 64KiB carry.
const Z80=loadZ80(repoRoot),catalog=readFileSync(join(builds[0],'host/s2-catalog.bin'));
const oldExe=previous.get('UGDUMP.EXE'),newExe=readFileSync(join(builds[0],'ultrags/dss/UGDUMP.EXE'));
assert.equal(sha256(oldExe),'692e7ce1f7c39dfa57c45f3c20544467153b408a55e26f23ba496d18e82aa37b');
const reproduction=[];
for(const slot of [0,1])for(const iff of [0,1])for(const [version,exe] of [['old',oldExe],['new',newExe]]){
 const data=Buffer.from(Array.from({length:65537},(_,i)=>(i*73+(i>>>8))&255)),card=new SlowCard(catalog),q=Buffer.alloc(5);
 q.writeUInt32LE(data.length,1);const [status,r]=card.command(16,q);assert.equal(status,0);const handle=r.readUInt16LE();
 Object.assign(card.objects.get(handle),{data:Buffer.from(data),uploaded:data.length,state:1});
 const h=parseExe(exe),m=new SprinterMachine({card,cardSlot:slot,commandLine:`${handle} BACK.MOD /VERIFY /SLOT:${slot}`,movingClock:true,logLimit:0,disk:{writeReturnDE:0}});
 m.mem.set(exe,h.loadAddr);const run=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff,budget:200000000});
 assert.equal(run.exitCode,version==='old'?5:0,m.text);assert.deepEqual(m.violations,[]);assert.equal(m.fileHandles.size,0);
 assert.equal(m.page3,m.page3Init);assert.equal(m.system,m.systemInit);assert.equal(!!run.end.iff1,!!iff);assert.equal(run.end.sp,h.stack-2);
 assert.deepEqual(card.objects.get(handle).data,data);
 const file=m.files.get('BACK.MOD');assert.deepEqual(file,version==='old'?data.subarray(0,1024):data);
 if(version==='new')assert(m.text.includes('host_crc=0x'+crc32(data).toString(16).padStart(8,'0').toUpperCase()));
 reproduction.push({version,slot,iff,exeSha256:sha256(exe),exit:run.exitCode,fileBytes:file.length,fileSha256:sha256(file),text:m.text,maxWindowUs:m.maxWindowUs,maxDiUs:m.maxDiUs});
}
const payload=new Map(changed.map(name=>[name,readFileSync(join(builds[0],'ultrags/dss',name))]));
payload.set('TESTER.TXT',readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/FILE-IO-TEST.md')));
payload.set('FILEIO.TXT',payload.get('TESTER.TXT'));
payload.set('AUDIO.TXT',readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/AUDIO-LOAD-TEST.md')));
payload.set('HASHES.TXT',Buffer.from([...payload].map(([n,d])=>`${sha256(d)}  ${n}`).join('\r\n')+'\r\n'));
const entries=[...payload].sort(([a],[b])=>a.localeCompare(b));
const containers={'ug-host.zip':makeZip(entries),'ug-host.img':makeImg(entries)};
for(const [name,data] of Object.entries(containers))assert.deepEqual([...(name.endsWith('.zip')?readZip(data):readFat12(data))],entries);
mkdirSync(out);
for(let i=0;i<2;i++){
 const ev=join(out,'evidence',i?'B':'A');mkdirSync(ev,{recursive:true});cpSync(join(builds[i],'ultrags/cfg-package'),join(ev,'kit'),{recursive:true});
 for(const [name,path] of [['EXE-RUN.json','ultrags/logs/ugdiag-run.json'],['ASSEMBLY.json','ultrags/dss/asm-manifest.json'],['S4-RUN.json','ultrags/logs/s4-run.json'],['S7-RUN.json','s7-dss-evidence.json'],['THROUGHPUT.json','ultrags/throughput/throughput.json']])writeFileSync(join(ev,name),readFileSync(join(builds[i],path)));
}
for(const e of proofs[0].assembly.filter(x=>!x.name.startsWith('ST-')))writeFileSync(join(out,e.name),readFileSync(join(builds[0],'ultrags/dss',e.name)));
for(const name of ['ug-cfg.zip','ug-cfg.img'])writeFileSync(join(out,name),readFileSync(join(builds[0],'ultrags/cfg-package',name)));
writeFileSync(join(out,'PGMULTI.UF2'),firmware);
for(const [name,data] of [...payload,...Object.entries(containers)])writeFileSync(join(out,name),data);
const files=['PGMULTI.UF2',...changed,...Object.keys(containers),'ug-cfg.zip','ug-cfg.img'].map(name=>{const d=readFileSync(join(out,name));return {name,size:d.length,sha256:sha256(d)};});
writeFileSync(join(out,'DELIVERY.json'),JSON.stringify({status:'HOST/DSS_PASS / file IO and speed REAL_PENDING; S6/S7 IN_PROGRESS',firmwareUnchanged:true,changedExes:changed,independentMatch:true,proofs,reproduction,files,toolSha256:sha256(readFileSync(new URL(import.meta.url))),limits:['Zero-wait timing model is not physical throughput','DSS WRITE DE clobber is reproduced by file-service model, not a complete filesystem emulation','Hardware dump/file comparison and concurrent audio confirmation remain pending']},null,2)+'\n');
console.log('Independent file IO / EXE / ZIP / IMG identity and old 1024-byte failure PASS:',out);
