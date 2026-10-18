#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import argparse,subprocess,shlex,json,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--cc',default='cc');a=p.parse_args();r=Path(__file__).resolve().parents[2];a.build.mkdir(parents=True,exist_ok=True)
subprocess.run(['node',str(r/'tools/ultrags/gen-wire.mjs'),str(r/'tools/ultrags/wire-schema.json'),str(a.build/'gen')],check=True)
src=['tests/ultrags/unit/test_s3.c','tests/ultrags/unit/sdk_mock/sdk_mock.c','sw/multifw/ug_catalog.c','sw/ultrags/ug_config.c','sw/ultrags/ug_minimal.c','sw/ultrags/ug_storage.c','sw/ultrags/ug_store.c','sw/ultrags/ug_memory.c','sw/ultrags/ug_psram.c','sw/ultrags/ug_hwmap.c','sw/ultrags/ug_pcm.c','sw/ultrags/ug_render.c','sw/ultrags/ug_mod.c']
exe=a.build/'s3';subprocess.run(shlex.split(a.cc)+['-std=c11','-O2','-g','-Wall','-Wextra','-pthread','-fsanitize=undefined','-fno-sanitize-recover=all','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1','-I'+str(r/'tests/ultrags/unit/sdk_mock'),'-I'+str(r/'sw'),'-I'+str(r/'common'),'-I'+str(a.build/'gen'),*map(lambda s:str(r/s),src),'-o',str(exe)],check=True)
subprocess.run([str(exe),str(a.build/'s3-fixtures.json'),str(a.build/'s3-commands.json')],check=True,timeout=120)

# A separate peripheral model executes the pinned backend itself. In
# particular, init's DMA waits must resolve to the same bounded wrapper as
# reads/writes; a declaration-only unbounded wait makes linking fail.
backend_src=['tests/ultrags/unit/test_s3_backend.c','sw/rp2040-psram/psram_spi.c','sw/ultrags/ug_psram.c','sw/ultrags/ug_hwmap.c']
backend_exe=a.build/'s3-backend'
subprocess.run(shlex.split(a.cc)+['-std=c11','-O2','-g','-Wall','-Wextra','-fsanitize=undefined','-fno-sanitize-recover=all',
    '-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1','-DPSRAM_PIN_SCK=2','-DPSRAM_PIN_MOSI=3','-DPSRAM_PIN_MISO=0',
    '-I'+str(r/'tests/ultrags/unit/backend_mock'),'-I'+str(r/'sw/rp2040-psram'),'-I'+str(r/'tests/ultrags/unit/sdk_mock'),'-I'+str(r/'sw'),
    '-include',str(r/'sw/ultrags/ug_psram_wait.h'),*map(lambda s:str(r/s),backend_src),'-o',str(backend_exe)],check=True)
subprocess.run([str(backend_exe),str(a.build/'s3-backend.json')],check=True,timeout=30)

inputs={r/s for s in src+backend_src} | set((r/'sw/ultrags').glob('*.h')) | set((r/'tests/ultrags/unit/sdk_mock').rglob('*.h')) | set((r/'tests/ultrags/unit/backend_mock').rglob('*.h')) | {r/'sw/rp2040-psram/psram_spi.h',r/'sw/rp2040-psram/psram_spi.pio',r/'tools/ultrags/s3-host.py',r/'tools/ultrags/wire-schema.json',r/'tools/ultrags/gen-wire.mjs',r/'sw/system/flash_settings.h',r/'sw/multifw/ug_catalog.h'}
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
(a.build/'s3-host-evidence.json').write_text(json.dumps({'inputs':{str(p):h(p) for p in sorted(inputs)},'executable':h(exe),'backend_executable':h(backend_exe),
    'outputs':{name:h(a.build/name) for name in ['s3-fixtures.json','s3-commands.json','s3-backend.json']},
    'compiler':subprocess.check_output(shlex.split(a.cc)+['--version'],text=True).splitlines()[0],'sanitizer':'UBSan'},indent=2)+'\n')
