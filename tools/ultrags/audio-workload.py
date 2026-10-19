#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Private MOD/WAV production-C regression; no files are added to a release."""
import argparse,json,subprocess,hashlib
from pathlib import Path
from s6_inputs import ROOT,COMMON
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--mod',type=Path,required=True);p.add_argument('--wav',type=Path,required=True);p.add_argument('--baseline-render',type=Path);a=p.parse_args()
a.build.mkdir(parents=True,exist_ok=True);gen=a.build/'gen';gen.mkdir(exist_ok=True)
subprocess.run(['node',str(ROOT/'tools/ultrags/gen-wire.mjs'),str(ROOT/'tools/ultrags/wire-schema.json'),str(gen)],check=True)
subprocess.run(['python3',str(ROOT/'tools/ultrags/gen-diag.py'),str(ROOT/'tools/ultrags/diag-schema.json'),str(gen)],check=True)
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
sources=[ROOT/'tests/ultrags/unit/render_workload.c',*[ROOT/s for s in COMMON]]
inputs={str(f.resolve()):digest(f) for f in [*sources,Path(__file__),a.mod,a.wav]}
results={}
for name,render in [('current',None),*([('baseline',a.baseline_render)] if a.baseline_render else [])]:
    actual=[render if render and s.name=='ug_render.c' else s for s in sources]
    exe=a.build/name
    cmd=['cc','-std=c11','-O2','-g','-Wall','-Wextra','-Werror','-pthread','-fsanitize=undefined','-fno-sanitize-recover=all','-DUG_S4_TEST=1','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1',
         *['-I'+str(ROOT/d) for d in ['tests/ultrags/unit/sdk_mock','sw','sw/ultrags','common']],'-I'+str(gen),*map(str,actual),'-o',str(exe)]
    subprocess.run(cmd,check=True)
    run=subprocess.run([str(exe.resolve()),str(a.mod.resolve()),str(a.wav.resolve())],check=True,capture_output=True,text=True,timeout=60)
    (a.build/(name+'.log')).write_text(run.stdout+run.stderr);results[name]=[json.loads(line) for line in run.stdout.splitlines()]
    print(name,run.stdout,flush=True)
if a.baseline_render:
    inputs[str(a.baseline_render.resolve())]=digest(a.baseline_render)
    assert results['current']==results['baseline'],'changed private MOD/FX output, clipping or cleanup'
report={'status':'PRIVATE_AUDIO_WORKLOAD_HOST_PASS / REAL_PENDING','inputs':inputs,'results':results,'limits':['Functional peripheral mocks; no real render timing/underrun claim','Source music remains private and is not included in releases']}
(a.build/'RESULTS.json').write_text(json.dumps(report,indent=2)+'\n')
