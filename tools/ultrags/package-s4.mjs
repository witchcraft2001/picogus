// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const i=process.argv.indexOf('--build'),build=resolve(i<0?'build':process.argv[i+1]);
const root=resolve(new URL('../..',import.meta.url).pathname),ug=join(build,'ultrags'),out=join(ug,'s4-package');
for(const script of ['package-s0b.mjs','verify-package.mjs'])execFileSync(process.execPath,[join(root,'tools/ultrags',script),'--stage','S4','--exe-dir',join(ug,'dss'),'--fixtures',join(ug,'fixtures'),script.startsWith('verify')?'--package':'--out',out],{stdio:'inherit'});
const report=JSON.parse(readFileSync(join(ug,'logs/s4-firmware.json'))),files=[];
for(const [source,name] of [
 [join(build,'multifw-release/picogus.uf2'),'PGMULTI.UF2'],[join(build,'ultrags-release/pg-ultrags.uf2'),'PGULTRA.UF2'],
 [join(build,'ultrags-slow/pg-ultrags.uf2'),'PGSLOW.UF2'],[join(build,'ultrags-debug/pg-ultrags.uf2'),'PGDEBUG.UF2'],
 [join(build,'ultrags-diag-release/pg-ultrags-diag.uf2'),'PGDIAG.UF2'],
 [join(build,'ultrags-diag-debug/pg-ultrags-diag.uf2'),'PGDDBG.UF2'],
 [join(build,'ultrags-diag-no-dack/pg-ultrags-diag.uf2'),'PGNODACK.UF2'],
 [join(build,'multifw-release/generated/multifw/flash-map.json'),'flash-map.json'],
 [join(ug,'logs/s4-firmware.json'),'firmware-report.json'],[join(ug,'logs/s4-run.json'),'dss-report.json'],
 [join(build,'host/s3-commands.json'),'c-model-fixtures.json'],
 [join(build,'host/s4-host.json'),'s4-host.json'],
 [join(build,'host/s4-commands.json'),'s4-c-model-fixtures.json'],
 [join(build,'host/s4-host-evidence.json'),'s4-host-evidence.json'],
 [join(ug,'logs/s4-full.json'),'s4-full.json'],
 [join(build,'REPORT-S4.txt'),'REPORT.txt'],
 [join(build,'host/s3-backend.json'),'backend-test.json'],
 [join(root,'host/sprinter/ultrags/docs/S4-README.md'),'S4-README.md'],
]){copyFileSync(source,join(out,name));const data=readFileSync(source);files.push({name,size:data.length,sha256:createHash('sha256').update(data).digest('hex')});}
mkdirSync(join(out,'provenance'),{recursive:true});
const s2=JSON.parse(readFileSync(join(ug,'logs/s2-firmware.json')));
for(const path of [...s2.provenance.map(e=>e.path),...report.images.map(e=>e.provenance)]){
 const data=readFileSync(path),ev=JSON.parse(data);
 for(const [file,sha] of Object.entries(ev.inputs))if(createHash('sha256').update(readFileSync(file)).digest('hex')!==sha)throw Error('stale source '+file);
 const name=path.split('/').slice(-2).join('-');copyFileSync(path,join(out,'provenance',name));
}
const packageManifest=JSON.parse(readFileSync(join(out,'package-manifest.json')));
writeFileSync(join(out,'manifest.json'),JSON.stringify({status:report.status,files,containers:packageManifest.containers,profiles:report.profiles,backend:report.backend},null,2)+'\n');
console.log('S4 package: ZIP/IMG with executed EXEs; separate bundle, standalone, slow/debug/diagnostic UF2; REAL_PENDING');
