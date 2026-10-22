#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute FLT8 production C under UBSan; keep commands/logs/hashes."""
import argparse, json, os, shlex, subprocess
from pathlib import Path
from s6_inputs import ROOT, COMMON, digest
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--mod',type=Path);p.add_argument('--flt8-mod',type=Path);a=p.parse_args()
a.build=a.build.resolve();a.build.mkdir(parents=True,exist_ok=True)
(a.build/'host-evidence.json').unlink(missing_ok=True)
subprocess.run(['node',str(ROOT/'tools/ultrags/gen-s8b.mjs'),str(a.build/'fixtures')],check=True)
subprocess.run(['node',str(ROOT/'tools/ultrags/gen-wire.mjs'),str(ROOT/'tools/ultrags/wire-schema.json'),str(a.build/'gen')],check=True)
subprocess.run(['python3',str(ROOT/'tools/ultrags/gen-diag.py'),str(ROOT/'tools/ultrags/diag-schema.json'),str(a.build/'gen')],check=True)
programs={'flt8':['tests/ultrags/unit/test_s8b_mod.c','sw/ultrags/ug_mod.c'],
          'flt8-storage':['tests/ultrags/unit/test_s8b_storage.c',*COMMON],
          'flt8-tail-storage':['tests/ultrags/unit/test_flt8_tail_storage.c',*COMMON],
          'flt4':['tests/ultrags/unit/test_flt4_mod.c','sw/ultrags/ug_mod.c'],
          'flt4-storage':['tests/ultrags/unit/test_s8b_storage.c',*COMMON],
          'multimod':['tests/ultrags/unit/test_multimod.c','sw/ultrags/ug_mod.c'],
          'multimod-storage':['tests/ultrags/unit/test_multimod_storage.c',*COMMON]}
if a.mod:
    a.mod=a.mod.resolve();programs['dope']=['tests/ultrags/unit/test_multimod.c','sw/ultrags/ug_mod.c']
    programs['dope-storage']=['tests/ultrags/unit/test_multimod_storage.c',*COMMON]
    programs['dope-audio']=['tests/ultrags/unit/test_dope_audio.c',*COMMON]
if a.flt8_mod:
    a.flt8_mod=a.flt8_mod.resolve();programs['gidion-storage']=['tests/ultrags/unit/test_flt8_tail_storage.c',*COMMON]
inputs={ROOT/f for src in programs.values() for f in src if (ROOT/f).exists()}
inputs.update(ROOT/p for p in ['tests/ultrags/unit/test_s7_storage.c','tests/ultrags/unit/test_s8a_storage.c','tools/ultrags/gen-s8b.mjs'])
inputs.update((a.build/'fixtures').glob('*'))
if a.mod:inputs.add(a.mod)
if a.flt8_mod:inputs.add(a.flt8_mod)
for folder in ('sw/ultrags','tests/ultrags/unit/sdk_mock','common','sw/system','sw/multifw'):
    inputs.update((ROOT/folder).rglob('*.h'))
inputs.update((ROOT/'sw/ultrags').glob('*.inc'));inputs.update((a.build/'gen').glob('*'))
inputs.update(ROOT/('tools/ultrags/'+f) for f in ('s8b-host.py','s6_inputs.py','wire-schema.json','gen-wire.mjs','gen-diag.py'))
before={str(f):digest(f) for f in sorted(inputs)};commands={};artifacts={}
for name,src in programs.items():
    cmd=['cc','-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-pthread','-fsanitize=undefined','-fno-sanitize-recover=all','-DUG_S4_TEST=1','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1',
         *['-I'+str(ROOT/d) for d in ('tests/ultrags/unit/sdk_mock','sw','sw/ultrags','common')],'-I'+str(a.build/'gen'),*[str(ROOT/f) for f in src],'-o',str(a.build/name)]
    subprocess.run(cmd,check=True);commands[name]=cmd
    fmt='FLT4' if name.startswith('flt4') else 'MOD28' if name.startswith('multimod') else 'FLT8'
    paths=[str(a.mod)]*2 if name.startswith('dope') else [str(a.build/('fixtures/'+fmt+'.MOD')),str(a.build/('fixtures/'+fmt+('REF' if fmt.startswith('FLT') else '')+'.MOD'))]
    if name=='flt8-tail-storage':paths=[str(a.build/'fixtures/FLT8TAIL.MOD')]*2
    if name=='gidion-storage':paths=[str(a.flt8_mod)]*2
    prefix={'dope-audio':'dope-prefix.s16le','flt8-tail-storage':'flt8-tail-prefix.s16le','gidion-storage':'gidion-prefix.s16le'}.get(name)
    extra=[str(a.build/prefix)] if prefix else []
    r=subprocess.run([str(a.build/name),*paths,*extra],check=False,capture_output=True,text=True,timeout=120)
    (a.build/(name+'.log')).write_text(r.stdout+r.stderr);print(r.stdout,end='');r.check_returncode()
    for suffix in ('','.log'):artifacts[name+suffix]=digest(a.build/(name+suffix))
    if prefix:artifacts[prefix]=digest(a.build/prefix)
if a.mod:artifacts['dope-prefix.s16le']=digest(a.build/'dope-prefix.s16le')
assert before=={str(f):digest(f) for f in sorted(inputs)}
(a.build/'host-evidence.json').write_text(json.dumps(dict(status='HOST_PASS / REAL_PENDING',inputs=before,commands=commands,artifacts=artifacts),indent=2)+'\n')
