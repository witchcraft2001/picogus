#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Capture actual compiler inputs at link time; packaging only verifies them."""
import argparse,hashlib,json,shlex
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--elf',type=Path,required=True);p.add_argument('--target',required=True);a=p.parse_args()
root=Path(__file__).resolve().parents[2];inputs={root/'sw/CMakeLists.txt',Path(__file__).resolve(),a.build/'CMakeCache.txt'}
for d in a.build.rglob('*.o.d'):
    if any('uf2create' in part.lower() for part in d.parts): continue  # retired native packer is not linked
    # Skip dependencies of other firmware executables; retain static libraries.
    if any(x.endswith('.dir') and (x.startswith('pg-') or x=='bootloader.dir') and x!=a.target+'.dir' for x in d.parts):continue
    for f in shlex.split(d.read_text().replace('\\\n',' ').split(':',1)[1]):
        path=Path(f);inputs.add(path.resolve() if path.is_absolute() else (a.build/path).resolve())
for flags in a.build.rglob('flags.make'):
    if flags.parent.name==a.target+'.dir': inputs.add(flags.resolve())
hashfile=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
result={'target':a.target,'inputs':{str(f):hashfile(f) for f in sorted(inputs)},'artifacts':{ext:hashfile(a.elf.with_suffix('.'+ext)) for ext in ['elf','bin','uf2']}}
a.elf.with_suffix('.evidence.json').write_text(json.dumps(result,indent=2)+'\n')
