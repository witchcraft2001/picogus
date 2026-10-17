#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {status,scope,expectedFiles} from './s6-bundle.mjs';
const arg=(name,def)=>{const i=process.argv.indexOf(name);return resolve(i<0?def:process.argv[i+1]);};
const build=arg('--build','build'),pkg=arg('--package',join(build,'ultrags/s6-package'));
const root=resolve(new URL('../..',import.meta.url).pathname);
execFileSync(process.env.UG_PYTHON||'python3',[join(root,'tools/ultrags/s6-report.py'),'--build',build],{stdio:'ignore'});
const manifest=JSON.parse(readFileSync(join(pkg,'manifest.json'),'utf8'));
if(manifest.stage!=='S6 increment' || manifest.status!==status || manifest.scope!==scope) throw Error('incorrect S6 increment scope/status');
const expected=expectedFiles(root,build),names=new Set();
for(const f of manifest.files) {
  if(typeof f.name!=='string' || !expected.has(f.name) || names.has(f.name)) throw Error('invalid/duplicate/unexpected path '+f.name);
  names.add(f.name);
  const data=readFileSync(join(pkg,f.name));
  if(data.length!==f.size || createHash('sha256').update(data).digest('hex')!==f.sha256) throw Error('manifest mismatch '+f.name);
  if(!data.equals(readFileSync(expected.get(f.name)))) throw Error('stale/replaced package artifact '+f.name);
}
if(names.size!==expected.size) throw Error('incomplete S6 increment');
const actual=[];
const walk=(dir)=>{for(const entry of readdirSync(join(pkg,dir),{withFileTypes:true})) {
  const name=dir?dir+'/'+entry.name:entry.name;
  if(lstatSync(join(pkg,name)).isSymbolicLink()) throw Error('package symlink '+name);
  if(entry.isDirectory())walk(name); else if(entry.isFile())actual.push(name); else throw Error('non-file package entry');
}};
if(lstatSync(pkg).isSymbolicLink()) throw Error('package root symlink');
walk(''); actual.sort();
if(JSON.stringify(actual)!==JSON.stringify([...names,'manifest.json'].sort())) throw Error('unmanifested or missing package file');
console.log(`verify-s6-package PASS: ${names.size} current artifacts; full S6 acceptance pending`);
