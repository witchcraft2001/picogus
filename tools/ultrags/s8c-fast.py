#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Build an explicitly experimental Turbo-BULK writer; standard UGPLAY stays slow."""
import argparse,json,os,subprocess
from pathlib import Path
from s6_inputs import ROOT,digest
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();b=a.build.resolve();out=b/'ultrags/dss';out.mkdir(parents=True,exist_ok=True)
source=b/'ultrags/ugpf.asm';source.write_text('; SPDX-License-Identifier: GPL-2.0-or-later\n; Experimental: requires a separate REAL Turbo-write stability gate.\n DEFINE UG_EXPERIMENT_TURBO_WRITE\n INCLUDE "ugplay.asm"\n')
cmd=[os.environ.get('SJASMPLUS','sjasmplus'),*[f'--inc={ROOT/d}' for d in ('host/sprinter/ultrags/apps','host/sprinter/ultrags/include','host/sprinter/ultrags/lib')],f'--inc={b}/ultrags/gen',f'--raw={out}/UGPF.EXE',f'--lst={out}/ugpf.lst',str(source)]
inputs=[source,ROOT/'tools/ultrags/s8c-fast.py',b/'ultrags/gen/ug_wire.inc']
for folder in ('host/sprinter/ultrags/apps','host/sprinter/ultrags/lib','host/sprinter/ultrags/include'):
    inputs.extend((ROOT/folder).glob('*'))
before={str(f):digest(f) for f in sorted(inputs) if f.is_file()}
subprocess.run(cmd,check=True)
assert before=={str(f):digest(f) for f in sorted(inputs) if f.is_file()}
(out/'fast-asm.json').write_text(json.dumps(dict(status='EXPERIMENTAL / REAL_PENDING',inputs=before,command=cmd,sha256=digest(out/'UGPF.EXE')),indent=2)+'\n')
