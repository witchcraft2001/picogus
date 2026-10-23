#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Build production-C adapter for the actual Z80 regression harness (N-API)."""
import argparse, hashlib, json, os, platform, shlex, subprocess
from pathlib import Path
from s6_inputs import COMMON, ROOT, digest
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--adlib',action='store_true',default=True);p.add_argument('--cc',default='cc');p.add_argument('--node-include',type=Path);a=p.parse_args()
a.build=a.build.resolve();a.build.mkdir(parents=True,exist_ok=True)
version=subprocess.check_output(['node','--version'],text=True).strip().removeprefix('v')
headers=a.node_include or Path.home()/'Library/Caches/node-gyp'/version/'include/node'
if not (headers/'node_api.h').is_file(): raise SystemExit('Set --node-include to the installed Node N-API headers')
gen=a.build/'gen';subprocess.run(['node',str(ROOT/'tools/ultrags/gen-wire.mjs'),str(ROOT/'tools/ultrags/wire-schema.json'),str(gen)],check=True)
subprocess.run(['python3',str(ROOT/'tools/ultrags/gen-diag.py'),str(ROOT/'tools/ultrags/diag-schema.json'),str(gen)],check=True)
cmd=shlex.split(a.cc)+['-std=c11','-O2','-g','-Wall','-Wextra','-Werror','-pthread','-DUG_S4_TEST=1','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1',
    *['-I'+str(ROOT/d) for d in ('tests/ultrags/unit/sdk_mock','sw','sw/ultrags','common')],'-I'+str(gen),'-I'+str(headers),
    *(['-bundle','-undefined','dynamic_lookup'] if platform.system()=='Darwin' else ['-shared','-fPIC']),
    str(ROOT/'tests/ultrags/unit/native_card.c'),*[str(ROOT/f) for f in COMMON],'-o',str(a.build/'native-card.node')]
files={ROOT/f for f in COMMON}|{ROOT/'tests/ultrags/unit/native_card.c',Path(__file__).resolve()}
for folder in ('sw/ultrags','tests/ultrags/unit/sdk_mock','common','sw/system','sw/multifw'):
    files.update((ROOT/folder).rglob('*.h'))
files.update((ROOT/'sw/ultrags').glob('*.inc'));
if a.adlib:
 files.update((ROOT/'sw/opl').glob('*.*'));files.add(ROOT/'sw/ultrags/ug_opl.c');files.add(ROOT/'tools/ultrags/adlib_inputs.py')
files.update(gen.glob('*'))
if a.adlib:
 cmd[1:1]=['-DUG_ADLIB=1']
 cmd += [str(a.build/('adlib'+str(i)+'.o')) for i in range(3)]
before={str(f):digest(f) for f in sorted(files)}
# Mach-O debug links include temporary object paths. Rebuilding an unchanged
# adapter would invalidate earlier executed proofs in the same make invocation.
# Reuse only an exact command/source/artifact match, independently per tree.
manifest=a.build/'native-card-build.json';binary=a.build/'native-card.node'
if manifest.is_file() and binary.is_file():
    old=json.loads(manifest.read_text())
    if old.get('adlib',False)==a.adlib and old.get('inputs')==before and old.get('command')==cmd and old.get('artifact')==digest(binary):
        print('Current production-C adapter reused (all inputs/command/artifact verified)')
        raise SystemExit(0)
if a.adlib:
    from adlib_inputs import DEFINES
    objs=[]
    for i,src in enumerate(('sw/ultrags/ug_opl.c','sw/opl/emu8950.c','sw/opl/slot_render.cpp')):
        obj=str(a.build/('adlib'+str(i)+'.o'));objs.append(obj)
        subprocess.run(['c++' if src.endswith('.cpp') else a.cc,'-O2','-fPIC','-fms-extensions','-DUG_S4_TEST=1',*['-D'+v for v in DEFINES],'-c',str(ROOT/src),'-o',obj],check=True)
subprocess.run(cmd,check=True)
assert before=={str(f):digest(f) for f in sorted(files)},'sources changed during adapter build'
(a.build/'native-card-build.json').write_text(json.dumps(dict(adlib=a.adlib,command=cmd,inputs=before,artifact=digest(a.build/'native-card.node'),scope='Production C and functional SDK model; no peripheral timing proof'),indent=2)+'\n')
