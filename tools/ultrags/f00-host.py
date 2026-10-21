#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Production-C F00 policy and immutable source checks under UBSan."""
import argparse,json,subprocess
from pathlib import Path
from s6_inputs import ROOT,COMMON,digest
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();b=a.build.resolve();b.mkdir(parents=True,exist_ok=True)
subprocess.run(['node',str(ROOT/'tools/ultrags/gen-f00.mjs'),str(b/'fixtures')],check=True)
subprocess.run(['node',str(ROOT/'tools/ultrags/gen-wire.mjs'),str(ROOT/'tools/ultrags/wire-schema.json'),str(b/'gen')],check=True)
subprocess.run(['python3',str(ROOT/'tools/ultrags/gen-diag.py'),str(ROOT/'tools/ultrags/diag-schema.json'),str(b/'gen')],check=True)
sources=['tests/ultrags/unit/test_mod_f00.c',*COMMON]
inputs={ROOT/f for f in sources}|{ROOT/'tests/ultrags/unit/test_s7_storage.c',Path(__file__).resolve(),ROOT/'tools/ultrags/gen-f00.mjs',ROOT/'tools/ultrags/wire-schema.json'}
for folder in ('sw/ultrags','tests/ultrags/unit/sdk_mock','common','sw/system','sw/multifw'):
 inputs.update((ROOT/folder).rglob('*.h'))
inputs.update((ROOT/'sw/ultrags').glob('*.inc'));inputs.update((b/'gen').glob('*'))
before={str(f):digest(f) for f in sorted(inputs)}
cmd=['cc','-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-pthread','-fsanitize=undefined','-fno-sanitize-recover=all','-DUG_S4_TEST=1','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1',*['-I'+str(ROOT/d) for d in ('tests/ultrags/unit/sdk_mock','sw','sw/ultrags','common')],'-I'+str(b/'gen'),*[str(ROOT/f) for f in sources],'-o',str(b/'f00')]
subprocess.run(cmd,check=True)
r=subprocess.run([str(b/'f00'),*[str(b/'fixtures'/f'F00MOD{ch}.MOD') for ch in (4,8)]],capture_output=True,text=True)
(b/'f00.log').write_text(r.stdout+r.stderr);print(r.stdout+r.stderr,end='');r.check_returncode()
assert before=={str(f):digest(f) for f in sorted(inputs)}
(b/'host-evidence.json').write_text(json.dumps(dict(status='HOST_PASS / REAL_PENDING',inputs=before,command=cmd,artifacts={n:digest(b/n) for n in ('f00','f00.log','fixtures/F00MOD4.MOD','fixtures/F00MOD8.MOD','fixtures/fixtures.json')}),indent=2)+'\n')
