#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import argparse, json, shlex, subprocess, sys, os
from pathlib import Path
from s6_inputs import ROOT, PROGRAMS, digest, inputs, validate

p=argparse.ArgumentParser(); p.add_argument('--build',type=Path,required=True); p.add_argument('--cc',default='cc'); a=p.parse_args()
a.build=a.build.resolve(); a.build.mkdir(parents=True,exist_ok=True)
evp=a.build/'s6-host-evidence.json'
evp.unlink(missing_ok=True)  # A failed run must not leave an earlier PASS.
gen=a.build/'gen'; gen.mkdir(parents=True,exist_ok=True)
before={f:h for f,h in inputs(a.build).items() if not Path(f).is_relative_to(gen)}
subprocess.run(['node',str(ROOT/'tools/ultrags/gen-wire.mjs'),str(ROOT/'tools/ultrags/wire-schema.json'),str(gen)],check=True)
subprocess.run([sys.executable,str(ROOT/'tools/ultrags/gen-diag.py'),str(ROOT/'tools/ultrags/diag-schema.json'),str(gen)],check=True)
assert all(inputs(a.build).get(f)==h for f,h in before.items()), 'S6 inputs changed during generation'
before=inputs(a.build)
commands={}
for name,sources in PROGRAMS.items():
    cmd=shlex.split(a.cc)+['-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-pthread',
        '-fsanitize=undefined','-fno-sanitize-recover=all','-DUG_S4_TEST=1','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1',
        *['-I'+str(ROOT / directory) for directory in ('tests/ultrags/unit/sdk_mock','sw','sw/ultrags','common')],
        '-I'+str(gen), *[str(ROOT/source) for source in sources], '-o',str(a.build/name)]
    commands[name]=cmd
    subprocess.run(cmd,check=True)
    env=dict(os.environ,UG_S6_VECTORS=str(a.build/"s6-commands.jsonl"),UG_S6_AUDIO=str(a.build/"s6-audio.s16le"),UG_S6_AUDIO_INDEX=str(a.build/"s6-audio-index.jsonl"))
    result=subprocess.run([str(a.build/name)],env=env,check=True,timeout=60,capture_output=True,text=True)
    log=result.stdout+result.stderr; print(log,end='',flush=True)
    (a.build/(name+'.log')).write_text(log)
assert before==inputs(a.build), 'S6 inputs changed during execution; rerun'
evidence={'status':'PASS','inputs':before,'commands':commands,
          'executables':{name:digest(a.build/name) for name in PROGRAMS},
          'logs':{name:digest(a.build/(name+'.log')) for name in PROGRAMS},
          'fixtures':{name:digest(a.build/name) for name in ('s6-commands.jsonl','s6-audio.s16le','s6-audio-index.jsonl')},
          'compiler':subprocess.check_output(shlex.split(a.cc)+['--version'],text=True).splitlines()[0],
          'sanitizer':'UBSan','scope':'S6 firmware C/UBSan, indexed audio goldens and shared command vectors; REAL pending'}
validate(evidence,a.build)
evp.write_text(json.dumps(evidence,indent=2)+'\n')
