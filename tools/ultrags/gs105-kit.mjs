// SPDX-License-Identifier: GPL-2.0-or-later
// The delivery payload is built from an explicit source list. CURRENT archives
// are outputs only; neither their existence nor their contents affect a kit.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {sha256} from './build-evidence.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
import {readZip,readFat12} from './verify-package.mjs';
export function buildKit(root,b,assembly,{turbo=false,s8b=false}={}){
 const json=p=>JSON.parse(readFileSync(p)),payload=new Map();
 function add(name,path,expected){
  assert(/^[A-Z0-9_-]{1,8}\.[A-Z0-9]{1,3}$/.test(name),'invalid kit name '+name);assert(!payload.has(name),'duplicate kit entry '+name);
  const bytes=readFileSync(path);if(expected)assert.equal(sha256(bytes),expected,'substituted kit input '+path);payload.set(name,bytes);
 }
 for(const f of assembly.files.filter(f=>!f.name.startsWith('ST-')))add(f.name,join(b,'ultrags/dss',f.name),f.sha256);
 const fast=json(join(b,'ultrags/dss/fast-asm.json'));add('UGPF.EXE',join(b,'ultrags/dss/UGPF.EXE'),fast.sha256);
 for(const [name,source]of [['TESTER',s8b?'S8B':turbo?'GS-TURBO':'GS105'],['GS105','GS105'],['S8A','S8A'],['S8C','S8C'],['F00','F00']])add(name+'.TXT',join(root,'host/sprinter/ultrags/docs',source+'-README.md'));
 if(s8b){
  add('S8B.TXT',join(root,'host/sprinter/ultrags/docs/S8B-README.md'));
  const f=json(join(b,'host/s8b/fixtures/fixtures.json'));assert.equal(f.generatorSha256,sha256(readFileSync(join(root,'tools/ultrags/gen-s8b.mjs'))));
  for(const name of ['FLT8.MOD','FLT8TAIL.MOD','FLT4.MOD','MOD28.MOD','MOD31.MOD','MOD32.MOD']){const mod=f.files.find(f=>f.name===name);add(name,join(b,'host/s8b/fixtures',name),mod.sha256);}
 }
 if(turbo)add('GSTURBO.TXT',join(b,'GS-TURBO.txt'));
 add('GSCONF.TXT',join(b,'GS105-CONFORMANCE.md'));
 const fixtures=json(join(b,'s8a-test-audio/fixtures.json'));
 assert.equal(fixtures.generatorSha256,sha256(readFileSync(join(root,'tools/ultrags/gen-s8a.mjs'))));
 for(const f of fixtures.files)add(f.name,join(b,'s8a-test-audio',f.name),f.sha256);
 add('FIXTURES.TXT',join(b,'s8a-test-audio/fixtures.json'));
 const f00=json(join(b,'host/f00/host-evidence.json'));
 for(const name of ['F00MOD4.MOD','F00MOD8.MOD']){const h=f00.artifacts['fixtures/'+name];assert(h);add(name,join(b,'host/f00/fixtures',name),h);}
 // Immutable, hashed captures and frozen prior diagnostics are shared inputs.
 const clipsDir=join(root,'build/s8c-test-audio'),clips=json(join(clipsDir,'original-clips.json'));
 for(const f of clips.clips)add(f.name,join(clipsDir,f.name),f.sha256);
 add('CLIPS.TXT',join(clipsDir,'original-clips.json'));
 const d4=join(root,'build/gs-clock-d4-delivery'),old=json(join(d4,'D4.json'));
 for(const name of ['UGGS0.EXE','UGGS1.EXE','UGGSC0.EXE','UGGSC1.EXE'])add(name,join(d4,name),old.files[name].sha256);
 const sorted=()=>[...payload].sort(([a],[b])=>a.localeCompare(b));
 payload.set('HASHES.TXT',Buffer.from(sorted().map(([n,v])=>sha256(v)+'  '+n).join('\r\n')+'\r\n'));
 const entries=sorted(),zipOnly=new Set(clips.clips.map(c=>c.name)),imgEntries=entries.filter(([n])=>!zipOnly.has(n));
 const zip=makeZip(entries),img=makeImg(imgEntries);assert.deepEqual([...readZip(zip)],entries);assert.deepEqual([...readFat12(img)],imgEntries);
 return {entries,zip,img};
}
