#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import argparse,subprocess,json,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();a.build=a.build.resolve();a.build.mkdir(parents=True,exist_ok=True)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def run(cmd):
 r=subprocess.run(cmd,capture_output=True,text=True);log.append(dict(command=cmd,stdout=r.stdout,stderr=r.stderr));print(r.stdout,end='');
 if r.returncode:print(r.stderr);r.check_returncode()
log=[]
(a.build/'host-evidence.json').unlink(missing_ok=True)
from adlib_inputs import DEFINES as defs
flags=['-pthread','-O2','-g','-fms-extensions','-fsanitize=undefined','-fno-sanitize-recover=all',*['-D'+v for v in defs]]
files=['tests/ultrags/unit/test_adlib.c','sw/opl/slot_render.cpp','sw/opl/tll_table_flash.c','sw/ultrags/ug_render.c']
objects=[]
try:
 for i,f in enumerate(files):
  obj=str(a.build/(str(i)+'.o'));objects.append(obj)
  run(['c++' if f.endswith('.cpp') else 'cc',*flags,*(['-D__attribute__(x)='] if f.endswith('tll_table_flash.c') else []),'-c',str(ROOT/f),'-o',obj])
 run(['c++','-pthread','-fsanitize=undefined',*objects,'-o',str(a.build/'adlib-test')])
 run([str(a.build/'adlib-test'),str(a.build/'vectors.s32le'),str(a.build/'release.s32le')])
 inputs=[ROOT/f for f in files]+list((ROOT/'sw/opl').glob('*.h'))+list((ROOT/'sw/ultrags').glob('ug_opl.*'))+[ROOT/'sw/ultrags/ug_render.h',ROOT/'sw/opl/emu8950.c',Path(__file__),Path(__file__).with_name('adlib_inputs.py')]
 (a.build/'host-evidence.json').write_text(json.dumps(dict(status='HOST_PASS / REAL_PENDING',inputs={str(f.resolve()):sha(f) for f in inputs},artifacts={f.name:sha(f) for f in (a.build/'adlib-test',a.build/'vectors.s32le',a.build/'release.s32le')},commands=log),indent=2)+'\n')
finally:(a.build/'commands.json').write_text(json.dumps(log,indent=2)+'\n')
