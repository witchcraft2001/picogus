// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const i=process.argv.indexOf('--build'),build=resolve(i<0?'build':process.argv[i+1]);
const root=resolve(new URL('../..',import.meta.url).pathname),ug=join(build,'ultrags'),out=join(ug,'s5-package');
execFileSync(process.env.UG_PYTHON || 'python3',[join(root,'tools/ultrags/s5-report.py'),'--build',build],{stdio:'inherit'});
for(const script of ['package-s0b.mjs'])execFileSync(process.execPath,[join(root,'tools/ultrags',script),'--stage','S5','--exe-dir',join(ug,'dss'),'--fixtures',join(ug,'fixtures'),script.startsWith('verify')?'--package':'--out',out],{stdio:'inherit'});
const report=JSON.parse(readFileSync(join(ug,'logs/s5-firmware.json'))),files=[];
for(const [source,name] of [
 [join(build,'multifw-release/picogus.uf2'),'PGMULTI.UF2'],[join(build,'ultrags-release/pg-ultrags.uf2'),'PGULTRA.UF2'],
 [join(build,'ultrags-slow/pg-ultrags.uf2'),'PGSLOW.UF2'],[join(build,'ultrags-debug/pg-ultrags.uf2'),'PGDEBUG.UF2'],
 [join(build,'ultrags-diag-release/pg-ultrags-diag.uf2'),'PGDIAG.UF2'],
 [join(build,'ultrags-diag-debug/pg-ultrags-diag.uf2'),'PGDDBG.UF2'],
 [join(build,'ultrags-diag-no-dack/pg-ultrags-diag.uf2'),'PGNODACK.UF2'],
 [join(build,'multifw-release/generated/multifw/flash-map.json'),'flash-map.json'],
 [join(build,'ultrags-posted/pg-ultrags.uf2'),'PGPOST.UF2'],
 [join(build,'multifw-posted/picogus.uf2'),'PGPMULT.UF2'],
 [join(build,'diag-posted/pg-ultrags-diag.uf2'),'PGPDIAG.UF2'],
 [join(build,'diag-posted-no-dack/pg-ultrags-diag.uf2'),'PGPNOD.UF2'],
 [join(build,'multifw-posted/generated/multifw/flash-map.json'),'posted-flash-map.json'],
 [join(root,'ultra-gs-docs/ultra-gs.md'),'ultra-gs.md'],
 [join(build,'host/s5-front.txt'),'posted-front-test.txt'],
 [join(build,'host/s5-diag.txt'),'posted-diagnostic-test.txt'],
 [join(build,'host/s5-diag-no-dack.txt'),'posted-no-dack-test.txt'],
 [join(build,'host/s5-pio.json'),'posted-pio-test.json'],
 [join(ug,'logs/s5-firmware.json'),'firmware-report.json'],[join(ug,'logs/s5-run.json'),'dss-report.json'],
 [join(build,'host/s3-commands.json'),'c-model-fixtures.json'],
 [join(build,'host/s5-host.json'),'s5-host.json'],
 [join(build,'host/s5-commands.json'),'s5-c-model-fixtures.json'],
 [join(build,'host/s5-host-evidence.json'),'s5-host-evidence.json'],
 [join(ug,'logs/s5-full.json'),'s5-full.json'],
 [join(ug,'logs/s5-variants.json'),'s5-variants.json'],
 [join(root,'tools/ultrags/s5-variants.mjs'),'s5-variants.mjs'],
 [join(build,'REPORT-S5.txt'),'REPORT.txt'],
 [join(build,'host/s3-backend.json'),'backend-test.json'],
 [join(root,'host/sprinter/ultrags/docs/S5-README.md'),'S5-README.md'],
]){copyFileSync(source,join(out,name));const data=readFileSync(source);files.push({name,size:data.length,sha256:createHash('sha256').update(data).digest('hex')});}
mkdirSync(join(out,'provenance'),{recursive:true});
const s2=JSON.parse(readFileSync(join(ug,'logs/s2-firmware.json')));
const provenance=new Set([...s2.provenance.map(e=>e.path),...report.images.map(e=>e.provenance),join(build,'ultrags-posted/pg-ultrags.evidence.json'),join(build,'diag-posted/standalone-evidence.json'),join(build,'diag-posted-no-dack/standalone-evidence.json'),...readdirSync(join(build,'multifw-posted')).filter(e=>e.endsWith('.evidence.json')).map(e=>join(build,'multifw-posted',e))]);
for(const variant of ['release','debug','no-dack'])provenance.add(join(build,'ultrags-diag-'+variant,'standalone-evidence.json'));
for(const path of provenance){
 const data=readFileSync(path),ev=JSON.parse(data);
 for(const [file,sha] of Object.entries(ev.inputs))if(createHash('sha256').update(readFileSync(file)).digest('hex')!==sha)throw Error('stale source '+file);
 const name=path.split('/').slice(-2).join('-');copyFileSync(path,join(out,'provenance',name));
 files.push({name:'provenance/'+name,size:data.length,sha256:createHash('sha256').update(data).digest('hex')});
}
const packageManifest=JSON.parse(readFileSync(join(out,'package-manifest.json')));
writeFileSync(join(out,'manifest.json'),JSON.stringify({status:report.status,files,containers:packageManifest.containers,profiles:report.profiles,backend:report.backend},null,2)+'\n');
execFileSync(process.execPath,[join(root,'tools/ultrags/verify-package.mjs'),'--stage','S5','--package',out,'--exe-dir',join(ug,'dss'),'--fixtures',join(ug,'fixtures')],{stdio:'inherit'});
console.log('S5 package: ZIP/IMG with executed EXEs; separate bundle, standalone, slow/debug/diagnostic UF2; REAL_PENDING');
