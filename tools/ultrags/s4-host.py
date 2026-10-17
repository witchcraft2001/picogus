#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import argparse,subprocess,shlex,json,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--cc',default='cc');a=p.parse_args();r=Path(__file__).resolve().parents[2];a.build.mkdir(parents=True,exist_ok=True)
subprocess.run(['node',str(r/'tools/ultrags/gen-wire.mjs'),str(r/'tools/ultrags/wire-schema.json'),str(a.build/'gen')],check=True)
src=['tests/ultrags/unit/test_s4.c','tests/ultrags/unit/sdk_mock/sdk_mock.c','sw/multifw/ug_catalog.c','sw/ultrags/ug_config.c','sw/ultrags/ug_minimal.c','sw/ultrags/ug_storage.c','sw/ultrags/ug_store.c','sw/ultrags/ug_memory.c','sw/ultrags/ug_psram.c','sw/ultrags/ug_hwmap.c','sw/ultrags/ug_pcm.c','sw/ultrags/ug_render.c']
inputs={r/s for s in src} | set((r/'sw/ultrags').glob('*.h')) | set((r/'common').glob('*.h')) | set((r/'tests/ultrags/unit/sdk_mock').rglob('*.h')) | {r/'tools/ultrags/s4-host.py',r/'tools/ultrags/wire-schema.json',r/'tools/ultrags/gen-wire.mjs',r/'sw/system/flash_settings.h',r/'sw/multifw/ug_catalog.h'}
inputs.add(a.build.resolve()/'gen/ug_wire.h')
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
captured={str(p):h(p) for p in sorted(inputs)}
exe=a.build/'s4';subprocess.run(shlex.split(a.cc)+['-std=c11','-O2','-g','-Wall','-Wextra','-pthread','-fsanitize=undefined','-fno-sanitize-recover=all','-DUG_S4_TEST=1','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1','-I'+str(r/'tests/ultrags/unit/sdk_mock'),'-I'+str(r/'sw'),'-I'+str(r/'common'),'-I'+str(a.build/'gen'),*map(lambda s:str(r/s),src),'-o',str(exe)],check=True)
subprocess.run([str(exe),str(a.build/'s4-host.json'),str(a.build/'s4-commands.json')],check=True,timeout=300)


assert captured=={str(p):h(p) for p in sorted(inputs)},'S4 HOST sources changed during build/run'
(a.build/'s4-host-evidence.json').write_text(json.dumps({'inputs':captured,'executable':h(exe),'outputs':{name:h(a.build/name) for name in ['s4-host.json','s4-commands.json']},'compiler':subprocess.check_output(shlex.split(a.cc)+['--version'],text=True).splitlines()[0],'sanitizer':'UBSan'},indent=2)+'\n')
