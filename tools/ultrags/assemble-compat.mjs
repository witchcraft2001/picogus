// SPDX-License-Identifier: GPL-2.0-or-later
// Reassemble the nine unchanged host tools for a firmware-only candidate.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {buildInputs,sha256} from './build-evidence.mjs';
const root=resolve('.'),build=resolve(process.argv[2]),prior=resolve(process.argv[3]);
const out=join(build,'ultrags/dss'),gen=join(build,'ultrags/gen');
mkdirSync(out,{recursive:true});mkdirSync(gen,{recursive:true});
execFileSync('node',['tools/ultrags/gen-wire.mjs','tools/ultrags/wire-schema.json',gen]);
execFileSync('python3',['tools/ultrags/gen-diag.py','tools/ultrags/diag-schema.json',gen]);
const version=spawnSync('sjasmplus',['--version'],{encoding:'utf8'});
assert.equal(version.status,0);
const assembler=(version.stdout+version.stderr).trim();
assert(assembler.includes('v1.22.0'));
const files={};
for(const src of readdirSync('host/sprinter/ultrags/apps').filter(n=>n.endsWith('.asm')).sort()){
 const name=src.replace('.asm',''),exe=name.toUpperCase()+'.EXE';
 execFileSync('sjasmplus',[
  '--inc=host/sprinter/ultrags/apps','--inc=host/sprinter/ultrags/include',
  '--inc=host/sprinter/ultrags/lib','--inc='+gen,
  '--raw='+join(out,exe),'--lst='+join(out,name+'.lst'),'host/sprinter/ultrags/apps/'+src],{stdio:'pipe'});
 const bytes=readFileSync(join(out,exe));
 assert.deepEqual(bytes,readFileSync(join(prior,exe)),exe+' unexpectedly changed');
 files[exe]=sha256(bytes);
}
assert.equal(Object.keys(files).length,9);
const inputs=buildInputs(root,out).sources;
for(const p of ['tools/ultrags/assemble-compat.mjs',join(gen,'ug_wire.inc'),join(gen,'ug_diag_wire.inc')])
 inputs[p]=sha256(readFileSync(p));
writeFileSync(join(build,'host/apps-reassembled.json'),JSON.stringify({
 status:'PASS',assembler,identicalTo:prior,files,inputs},null,2)+'\n');
console.log('Nine freshly assembled EXEs identical to previous delivery');
