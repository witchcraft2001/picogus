// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
export const status='HOST_PARTIAL / DSS-EXE_PENDING / REAL_PENDING';
export const scope='host PCM storage/render and standalone handshake UF2; no S6 DSS executables';
export function expectedFiles(root,build) {
  const map=new Map([
    ['PGULTRA.UF2',join(build,'ultrags-release/pg-ultrags.uf2')],
    ['firmware-evidence.json',join(build,'ultrags-release/pg-ultrags.evidence.json')],
    ['s6-host-evidence.json',join(build,'host/s6/s6-host-evidence.json')],
    ['REPORT-S6.txt',join(build,'REPORT-S6.txt')],
    ['s6-firmware-memory.json',join(build,'s6-firmware-memory.json')],
    ['ultra-gs.md',join(root,'ultra-gs-docs/ultra-gs.md')],
    ['S6-README.md',join(root,'host/sprinter/ultrags/docs/S6-README.md')],
    ['S6-REVIEW.md',join(root,'host/sprinter/ultrags/docs/S6-REVIEW.md')],
  ]);
  for(const name of ['s6-storage','s6-pcm','s6-render','s6-device']) {
    map.set(name+'-host',join(build,'host/s6',name));
    map.set(name+'.log',join(build,'host/s6',name+'.log'));
  }
  // Compare against a fresh generator run, including the exact fixture set.
  const temp=mkdtempSync(join(tmpdir(),'ultrags-s6-fixtures-'));
  try {
    execFileSync(process.execPath,[join(root,'tools/ultrags/gen-fixtures.mjs'),'--out',temp],{stdio:'ignore'});
    const dir=join(build,'ultrags/fixtures');
    const fresh=readdirSync(temp).sort(),actual=readdirSync(dir).sort();
    if(JSON.stringify(fresh)!==JSON.stringify(actual)) throw Error('stale/incomplete build fixtures');
    for(const name of fresh) {
      if(!readFileSync(join(temp,name)).equals(readFileSync(join(dir,name)))) throw Error('stale fixture '+name);
      map.set('fixtures/'+name,join(dir,name));
    }
  } finally {rmSync(temp,{recursive:true,force:true});}
  return map;
}
