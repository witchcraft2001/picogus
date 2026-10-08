// SPDX-License-Identifier: GPL-2.0-or-later
// S1 DSS containers are independently re-extracted; standalone firmware stays separate.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const i=process.argv.indexOf('--build'), build=resolve(i>=0?process.argv[i+1]:'build');
const root=resolve(new URL('../..',import.meta.url).pathname), ug=join(build,'ultrags'),out=join(ug,'s1-package');
execFileSync(process.execPath,[join(root,'tools/ultrags/package-s0b.mjs'),'--stage','S1','--exe-dir',join(ug,'dss'),'--fixtures',join(ug,'fixtures'),'--out',out],{stdio:'inherit'});
execFileSync(process.execPath,[join(root,'tools/ultrags/verify-package.mjs'),'--stage','S1','--package',out,'--exe-dir',join(ug,'dss'),'--fixtures',join(ug,'fixtures')],{stdio:'inherit'});
const fw=JSON.parse(readFileSync(join(ug,'logs/s1-firmware.json'))), files=[];
mkdirSync(join(out,'standalone'),{recursive:true});
for(const image of fw.images){
  const directory=join(build,'ultrags-diag-'+image.variant), path=join(directory,'standalone-evidence.json');
  if(createHash('sha256').update(readFileSync(path)).digest('hex')!==image.evidence_sha256)throw new Error('firmware evidence changed after report');
  const evidence=JSON.parse(readFileSync(path));
  for(const [path,expected] of Object.entries(evidence.inputs))if(createHash('sha256').update(readFileSync(path)).digest('hex')!==expected)throw new Error('stale firmware input: '+path);
  const name='pg-diag-'+image.variant+'-evidence.json',bytes=readFileSync(path);
  copyFileSync(path,join(out,'standalone',name));
  files.push({name,size:bytes.length,sha256:image.evidence_sha256,role:'link-time provenance',standalone:true});
}
for(const image of fw.images)for(const ext of ['uf2','elf','bin']) {
  const src=join(build,'ultrags-diag-'+image.variant,'pg-ultrags-diag.'+ext),dest='pg-diag-'+image.variant+'.'+ext;
  const b=readFileSync(src),sha256=createHash('sha256').update(b).digest('hex');
  if(sha256!==image.files['pg-ultrags-diag.'+ext].sha256)throw new Error('firmware changed after report');
  copyFileSync(src,join(out,'standalone',dest));files.push({name:dest,size:b.length,sha256,origin:image.origin,standalone:true});
}
writeFileSync(join(out,'standalone/manifest.json'),JSON.stringify({status:fw.status,install:'BOOTSEL only after full-flash backup or explicit loss agreement',files},null,2)+'\n');
console.log('S1 DSS ZIP/IMG byte identity PASS; standalone firmware separately hashed; REAL_PENDING');
