#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import argparse,subprocess,shlex
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--cc',default='cc');a=p.parse_args();r=Path(__file__).resolve().parents[2];a.build.mkdir(parents=True,exist_ok=True)
subprocess.run(['node',str(r/'tools/ultrags/gen-wire.mjs'),str(r/'tools/ultrags/wire-schema.json'),str(a.build/'gen')],check=True)
flags=['-I'+str(r/'common'),'-I'+str(a.build/'gen'),'-O1','-g','-Wall','-Wextra','-pthread','-fsanitize=undefined','-fno-sanitize-recover=all','-DSOUND_ULTRAGS=1','-I'+str(r/'tests/ultrags/unit/s2_mock'),'-I'+str(r/'sw')]
sources=['tests/ultrags/unit/test_s2.c','sw/multifw/ug_catalog.c','sw/ultrags/ug_config.c','sw/ultrags/ug_minimal.c','sw/system/flash_settings.c','sw/ultrags/ug_maintenance.cpp','tests/ultrags/unit/s2_mock/maintenance_hooks.cpp'];objects=[]
for n,src in enumerate(sources):
 out=a.build/f's2-{n}.o';objects.append(out)
 subprocess.run((['c++','-std=c++17'] if src.endswith('cpp') else shlex.split(a.cc)+['-std=c11'])+flags+['-c',str(r/src),'-o',str(out)],check=True)
exe=a.build/'s2';subprocess.run(['c++','-pthread','-fsanitize=undefined',*map(str,objects),'-o',str(exe)],check=True)
subprocess.run([str(exe),str(a.build/'s2-catalog.bin'),str(a.build/'s2-config-fixtures.json')],check=True,timeout=60)
