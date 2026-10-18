// SPDX-License-Identifier: GPL-2.0-or-later
// Complete software delivery; physical acceptance remains pending.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {status,scope,expectedFiles} from './s6-bundle.mjs';
const i=process.argv.indexOf('--build'),build=resolve(i<0?'build':process.argv[i+1]);
const root=resolve(new URL('../..',import.meta.url).pathname),out=join(build,'ultrags/s6-package');
execFileSync(process.env.UG_PYTHON||'python3',[join(root,'tools/ultrags/s6-report.py'),'--build',build],{stdio:'inherit'});
execFileSync(process.execPath,[join(root,'tools/ultrags/package-s0b.mjs'),'--stage','S6','--exe-dir',join(build,'ultrags/dss'),'--fixtures',join(build,'ultrags/fixtures'),'--out',join(build,'ultrags/s6-containers')],{stdio:'inherit'});
mkdirSync(out,{recursive:true});
const files=[];
for(const [name,src] of expectedFiles(root,build)) {
  mkdirSync(dirname(join(out,name)),{recursive:true}); copyFileSync(src,join(out,name));
  const data=readFileSync(src);
  files.push({name,size:data.length,sha256:createHash('sha256').update(data).digest('hex')});
}
writeFileSync(join(out,'manifest.json'),JSON.stringify({stage:'S6',status,scope,files},null,2)+'\n');
execFileSync(process.execPath,[join(root,'tools/ultrags/verify-s6-package.mjs'),'--build',build,'--package',out],{stdio:'inherit'});
console.log(`S6 software bundle: ${files.length} artifacts; ${status}`);
