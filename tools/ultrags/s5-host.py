#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import argparse,subprocess,shlex,json,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--cc',default='cc');a=p.parse_args();r=Path(__file__).resolve().parents[2];a.build.mkdir(parents=True,exist_ok=True)
subprocess.run(['node',str(r/'tools/ultrags/gen-wire.mjs'),str(r/'tools/ultrags/wire-schema.json'),str(a.build/'gen')],check=True)
subprocess.run(['python3',str(r/'tools/ultrags/gen-diag.py'),str(r/'tools/ultrags/diag-schema.json'),str(a.build/'gen')],check=True)
src=['tests/ultrags/unit/test_s5.c','tests/ultrags/unit/sdk_mock/sdk_mock.c','sw/multifw/ug_catalog.c','sw/ultrags/ug_config.c','sw/ultrags/ug_minimal.c','sw/ultrags/ug_storage.c','sw/ultrags/ug_store.c','sw/ultrags/ug_memory.c','sw/ultrags/ug_psram.c','sw/ultrags/ug_hwmap.c','sw/ultrags/ug_pcm.c','sw/ultrags/ug_render.c','sw/ultrags/ug_mod.c']
inputs={r/s for s in src} | set((r/'sw/ultrags').glob('*.h')) | set((r/'common').glob('*.h')) | set((r/'tests/ultrags/unit/sdk_mock').rglob('*.h')) | {r/'tools/ultrags/s5-host.py',r/'tools/ultrags/wire-schema.json',r/'tools/ultrags/gen-wire.mjs',r/'sw/system/flash_settings.h',r/'tools/ultrags/diag-schema.json',r/'tools/ultrags/gen-diag.py',r/'tests/ultrags/unit/test_s5_diag.c',r/'sw/ultrags/ug_diag_isa.c',r/'sw/multifw/ug_catalog.h'}
inputs.update((r/'sw/ultrags').glob('*.inc'))
inputs.add(a.build.resolve()/'gen/ug_wire.h');inputs.add(a.build.resolve()/'gen/ug_diag_wire.h')
inputs |= {r/'tests/ultrags/unit/test_s5_front.c',r/'sw/ultrags/ug_posted.c'} | set((r/'tests/ultrags/unit/s5_mock').rglob('*.h'))
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
captured={str(p):h(p) for p in sorted(inputs)}
exe=a.build/'s5';subprocess.run(shlex.split(a.cc)+['-std=c11','-O2','-g','-Wall','-Wextra','-pthread','-fsanitize=undefined','-fno-sanitize-recover=all','-DUG_S4_TEST=1','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1','-I'+str(r/'tests/ultrags/unit/sdk_mock'),'-I'+str(r/'sw'),'-I'+str(r/'common'),'-I'+str(a.build/'gen'),*map(lambda s:str(r/s),src),'-o',str(exe)],check=True)
subprocess.run([str(exe),str(a.build/'s5-host.json'),str(a.build/'s5-commands.json')],check=True,timeout=300)


front=a.build/'s5-front'
subprocess.run(shlex.split(a.cc)+['-std=c11','-O2','-g','-Wall','-Wextra','-fsanitize=undefined','-fno-sanitize-recover=all','-I'+str(r/'tests/ultrags/unit/s5_mock'),'-I'+str(r/'sw'),str(r/'tests/ultrags/unit/test_s5_front.c'),str(r/'sw/ultrags/ug_posted.c'),'-o',str(front)],check=True)
(a.build/'s5-front.txt').write_text(subprocess.check_output([str(front)],text=True))
diag_executables={}
for no_dack in [False,True]:
    name='s5-diag'+('-no-dack' if no_dack else '')
    diagnostic=a.build/name
    subprocess.run(shlex.split(a.cc)+['-std=c11','-O2','-g','-Wall','-Wextra','-Werror','-DUG_ISA_POSTED=1',*(['-DUG_DIAG_NO_DACK=1'] if no_dack else []),'-fsanitize=undefined','-fno-sanitize-recover=all','-I'+str(r/'tests/ultrags/unit/s5_mock'),'-I'+str(r/'sw'),'-I'+str(r/'common'),'-I'+str(a.build/'gen'),str(r/'tests/ultrags/unit/test_s5_diag.c'),str(r/'sw/ultrags/ug_diag_isa.c'),str(r/'sw/ultrags/ug_posted.c'),'-o',str(diagnostic)],check=True)
    (a.build/(name+'.txt')).write_text(subprocess.check_output([str(diagnostic)],text=True))
    diag_executables[name]=h(diagnostic)
assert captured=={str(p):h(p) for p in sorted(inputs)},'S5 HOST sources changed during build/run'
(a.build/'s5-host-evidence.json').write_text(json.dumps({'inputs':captured,'front_executable':h(front),'diagnostic_executables':diag_executables,'executable':h(exe),'outputs':{name:h(a.build/name) for name in ['s5-host.json','s5-commands.json','s5-front.txt','s5-diag.txt','s5-diag-no-dack.txt']},'compiler':subprocess.check_output(shlex.split(a.cc)+['--version'],text=True).splitlines()[0],'sanitizer':'UBSan'},indent=2)+'\n')
