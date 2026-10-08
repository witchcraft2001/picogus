// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const i=process.argv.indexOf('--build'),build=resolve(i<0?'build':process.argv[i+1]);
const root=resolve(new URL('../..',import.meta.url).pathname),ug=join(build,'ultrags'),out=join(ug,'s2-package');
for(const script of ['package-s0b.mjs','verify-package.mjs'])execFileSync(process.execPath,[join(root,'tools/ultrags',script),'--stage','S2','--exe-dir',join(ug,'dss'),'--fixtures',join(ug,'fixtures'),script.startsWith('verify')?'--package':'--out',out],{stdio:'inherit'});
const fw=JSON.parse(readFileSync(join(ug,'logs/s2-firmware.json'))), files=[];
for(const [source,name] of [
 [join(build,'multifw-release/picogus.uf2'),'PGMULTI.UF2'],
 [join(build,'ultrags-release/pg-ultrags.uf2'),'PGULTRA.UF2'],
 [join(build,'multifw-release/generated/multifw/flash-map.json'),'flash-map.json'],
 [join(ug,'logs/s2-firmware.json'),'firmware-report.json'],
 [join(root,'host/sprinter/ultrags/docs/S2-README.md'),'S2-README.md'],
]){copyFileSync(source,join(out,name));const b=readFileSync(source);files.push({name,size:b.length,sha256:createHash('sha256').update(b).digest('hex')});}
mkdirSync(join(out,'provenance'),{recursive:true});
for(const entry of fw.provenance){const data=readFileSync(entry.path);copyFileSync(entry.path,join(out,'provenance',entry.path.split('/').at(-1)));if(createHash('sha256').update(data).digest('hex')!==entry.sha256)throw Error('stale provenance');const evidence=JSON.parse(data);for(const [path,sha] of Object.entries(evidence.inputs))if(createHash('sha256').update(readFileSync(path)).digest('hex')!==sha)throw Error('stale source: '+path);}
writeFileSync(join(out,'manifest.json'),JSON.stringify({status:fw.status,firmware:files,flash_map:fw.flash_map,versions:fw.versions},null,2)+'\n');
console.log('S2 stage ZIP/IMG: executed EXE identity PASS; PGMULTI and standalone PGULTRA separate; REAL_PENDING');
