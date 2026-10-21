#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Mutation checks: incomplete/stale proofs must never publish a PASS report."""
import argparse,json,subprocess,tempfile,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args()
root=Path(__file__).resolve().parents[3];build=a.build.resolve()
with tempfile.TemporaryDirectory(prefix='gs105-evidence-') as td:
 b=Path(td)
 for name in ['ultrags','host','s8a-test-audio']:(b/name).symlink_to(build/name,target_is_directory=True)
 (b/'evidence').mkdir();(b/'native').mkdir()
 for name in ['gs-exe','f00-exe','s8a-exe','lowram-exe']:shutil.copyfile(build/'evidence'/(name+'.json'),b/'evidence'/(name+'.json'))
 shutil.copyfile(build/'s7-dss-evidence.json',b/'s7-dss-evidence.json')
 shutil.copyfile(build/'native/native-card-build.json',b/'native/native-card-build.json')
 (b/'native/native-card.node').symlink_to(build/'native/native-card.node')
 def report():return subprocess.run(['python3',str(root/'tools/ultrags/gs105-report.py'),'--build',str(b)],cwd=root,capture_output=True,text=True)
 result=report();assert result.returncode==0,result.stdout+result.stderr
 def reject(name,path,mutation):
  original=path.read_bytes()
  try:
   data=json.loads(original);mutation(data);path.write_text(json.dumps(data));r=report()
   assert r.returncode!=0,name+' incorrectly accepted'
   # Remove an old success report before each failure: the runner must not leave
   # an earlier PASS looking like the result of this invocation.
   assert not (b/'GS105-CONFORMANCE.json').exists(),name+' left stale PASS output'
  finally:path.write_bytes(original)
  print('PASS reject',name)
 reject('stale native adapter source',b/'native/native-card-build.json',lambda d:d['inputs'].__setitem__(next(iter(d['inputs'])),'0'*64))
 reject('stale S8a EXE inputs',b/'evidence/s8a-exe.json',lambda d:d['inputs'].__setitem__(next(iter(d['inputs'])),'0'*64))
 reject('substituted native EXE',b/'evidence/s8a-exe.json',lambda d:d['images'].__setitem__('UGTEST',{'sha256':'0'*64}))
 reject('missing GS race regressions',b/'evidence/gs-exe.json',lambda d:[r.__setitem__('changeModule',None) for r in d['results']])
 reject('resident DSS corruption',b/'evidence/lowram-exe.json',lambda d:next(r for r in d['results'] if not r['legacy']).__setitem__('residentWrites',1))
 reject('failed S7 regression',b/'s7-dss-evidence.json',lambda d:d['results'][0].__setitem__('pass',False))
 (b/'s7-dss-evidence.json').unlink();assert report().returncode!=0
 print('PASS reject missing S7 evidence')
 # Arbitrary prior archives must have no effect on reconstruction.
 (b/'GS105-CONFORMANCE.md').write_bytes((build/'GS105-CONFORMANCE.md').read_bytes())
 isolated=b/'repo';isolated.mkdir();(isolated/'build').mkdir()
 for name in ['host','tools']:(isolated/name).symlink_to(root/name,target_is_directory=True)
 for name in ['s8c-test-audio','gs-clock-d4-delivery']:(isolated/'build'/name).symlink_to(root/'build'/name,target_is_directory=True)
 js="""import assert from 'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';import{buildKit}from'./tools/ultrags/gs105-kit.mjs';const[root,b,source]=process.argv.slice(1),asm=JSON.parse(readFileSync(join(source,'ultrags/dss/asm-manifest.json'))),first=buildKit(root,b,asm);writeFileSync(join(b,'CURRENT.ZIP'),'obsolete arbitrary payload');writeFileSync(join(root,'build/CURRENT.ZIP'),'foreign obsolete archive');const second=buildKit(root,b,asm);assert.deepEqual(first,second);console.log('PASS kit independent of previous CURRENT.ZIP');"""
 subprocess.run(['node','--input-type=module','-e',js,str(isolated),str(b),str(build)],cwd=root,check=True)
