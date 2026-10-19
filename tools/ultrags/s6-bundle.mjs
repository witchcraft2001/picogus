// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
export const status='HOST_PASS / DSS-EXE_PASS / REAL_PENDING';
export const scope='complete S6 software gate; physical S6 acceptance pending';
export const firmware=[
 ['multifw-release/picogus.uf2','PGMULTI.UF2'],['ultrags-release/pg-ultrags.uf2','PGULTRA.UF2'],
 ['ultrags-slow/pg-ultrags.uf2','PGSLOW.UF2'],['ultrags-debug/pg-ultrags.uf2','PGDEBUG.UF2'],
 ['ultrags-diag-release/pg-ultrags-diag.uf2','PGDIAG.UF2'],['ultrags-diag-debug/pg-ultrags-diag.uf2','PGDDBG.UF2'],
 ['ultrags-diag-no-dack/pg-ultrags-diag.uf2','PGNODACK.UF2'],['ultrags-posted/pg-ultrags.uf2','PGPOST.UF2'],
 ['multifw-posted/picogus.uf2','PGPMULT.UF2'],['diag-posted/pg-ultrags-diag.uf2','PGPDIAG.UF2'],
 ['diag-posted-no-dack/pg-ultrags-diag.uf2','PGPNOD.UF2']];
export function expectedFiles(root,build) {
 const map=new Map(firmware.map(([path,name])=>[name,join(build,path)]));
 for(const [path,name] of [
  ['ultrags-release/pg-ultrags.evidence.json','firmware-evidence.json'],
  ['host/s6/s6-host-evidence.json','s6-host-evidence.json'],['REPORT-S6.txt','REPORT-S6.txt'],
  ['s6-firmware-memory.json','s6-firmware-memory.json'],
  ['host/s6/s6-commands.jsonl','s6-commands.jsonl'],['host/s6/s6-audio.s16le','s6-audio.s16le'],
  ['host/s6/s6-audio-index.jsonl','s6-audio-index.jsonl'],
  ['multifw-release/generated/multifw/flash-map.json','flash-map.json'],
  ['ultrags/dss/asm-manifest.json','asm-manifest.json'],
  ...['s6-run.json','s5-firmware.json','s5-run.json','s5-full.json','s5-variants.json','s4-full.json','ugdiag-run.json'].map(n=>['ultrags/logs/'+n,n]),
  ...['ug-s6.zip','ug-s6.img','package-manifest.json'].map(n=>['ultrags/s6-containers/'+n,n]),
 ])map.set(name,join(build,path));
 for(const name of ['ultra-gs-docs/ultra-gs.md','host/sprinter/ultrags/docs/S6-README.md','host/sprinter/ultrags/docs/S6-REVIEW.md'])map.set(name.split('/').at(-1),join(root,name));
 for(const name of ['s6-storage','s6-pcm','s6-render','s6-math','s6-device']){map.set(name+'-host',join(build,'host/s6',name));map.set(name+'.log',join(build,'host/s6',name+'.log'));}
 for(const name of readdirSync(join(build,'ultrags/dss')).filter(n=>n.endsWith('.EXE')))map.set(name,join(build,'ultrags/dss',name));
 const regression=JSON.parse(readFileSync(join(build,'ultrags/logs/s2-firmware.json')));
 const provenance=new Set(regression.provenance.map(x=>x.path));
 for(const dir of ['ultrags-release','ultrags-slow','ultrags-debug','ultrags-posted','multifw-posted'])for(const n of readdirSync(join(build,dir)).filter(n=>n.endsWith('.evidence.json')))provenance.add(join(build,dir,n));
 for(const dir of ['ultrags-diag-release','ultrags-diag-debug','ultrags-diag-no-dack','diag-posted','diag-posted-no-dack'])provenance.add(join(build,dir,'standalone-evidence.json'));
 for(const path of provenance)map.set('provenance/'+path.split('/').slice(-2).join('-'),path);
 const temp=mkdtempSync(join(tmpdir(),'ultrags-s6-fixtures-'));
 try {
  execFileSync(process.execPath,[join(root,'tools/ultrags/gen-fixtures.mjs'),'--out',temp],{stdio:'ignore'});
  const dir=join(build,'ultrags/fixtures'),fresh=readdirSync(temp).sort();
  if(JSON.stringify(fresh)!==JSON.stringify(readdirSync(dir).sort()))throw Error('stale/incomplete build fixtures');
  for(const name of fresh){if(!readFileSync(join(temp,name)).equals(readFileSync(join(dir,name))))throw Error('stale fixture '+name);map.set('fixtures/'+name,join(dir,name));}
 } finally {rmSync(temp,{recursive:true,force:true});}
 return map;
}
