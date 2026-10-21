#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute streaming PCM production C under UBSan; keep commands/logs/hashes."""
import argparse, json, os, shlex, subprocess
from pathlib import Path
from s6_inputs import ROOT, COMMON, digest
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args()
a.build=a.build.resolve();a.build.mkdir(parents=True,exist_ok=True)
subprocess.run(['node',str(ROOT/'tools/ultrags/gen-wire.mjs'),str(ROOT/'tools/ultrags/wire-schema.json'),str(a.build/'gen')],check=True)
subprocess.run(['python3',str(ROOT/'tools/ultrags/gen-diag.py'),str(ROOT/'tools/ultrags/diag-schema.json'),str(a.build/'gen')],check=True)
programs={'stream':['tests/ultrags/unit/test_stream.c','sw/ultrags/ug_stream.c'],
          'stream-storage':['tests/ultrags/unit/test_stream_storage.c',*COMMON]}
inputs={ROOT/f for src in programs.values() for f in src if (ROOT/f).exists()}
for folder in ('sw/ultrags','tests/ultrags/unit/sdk_mock','common','sw/system','sw/multifw'):
    inputs.update((ROOT/folder).rglob('*.h'))
inputs.update((ROOT/'sw/ultrags').glob('*.inc'));inputs.update((a.build/'gen').glob('*'))
inputs.update(ROOT/('tools/ultrags/'+f) for f in ('s8c-host.py','s6_inputs.py','wire-schema.json','gen-wire.mjs','gen-diag.py'))
before={str(f):digest(f) for f in sorted(inputs)};commands={};artifacts={}
for name,src in programs.items():
    cmd=['cc','-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-pthread','-fsanitize=undefined','-fno-sanitize-recover=all','-DUG_S4_TEST=1','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1',
         *['-I'+str(ROOT/d) for d in ('tests/ultrags/unit/sdk_mock','sw','sw/ultrags','common')],'-I'+str(a.build/'gen'),*[str(ROOT/f) for f in src],'-o',str(a.build/name)]
    subprocess.run(cmd,check=True);commands[name]=cmd
    r=subprocess.run([str(a.build/name)],check=True,capture_output=True,text=True,timeout=120)
    (a.build/(name+'.log')).write_text(r.stdout+r.stderr);print(r.stdout,end='')
    for suffix in ('','.log'):artifacts[name+suffix]=digest(a.build/(name+suffix))
assert before=={str(f):digest(f) for f in sorted(inputs)}
(a.build/'host-evidence.json').write_text(json.dumps(dict(status='HOST_PASS / REAL_PENDING',inputs=before,commands=commands,artifacts=artifacts),indent=2)+'\n')
