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
backend_cmd=shlex.split(a.cc)+['-std=c11','-O2','-g','-Wall','-Wextra','-fsanitize=undefined','-fno-sanitize-recover=all',
    '-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1','-DPSRAM_PIN_SCK=2','-DPSRAM_PIN_MOSI=3','-DPSRAM_PIN_MISO=0',
    '-I'+str(r/'tests/ultrags/unit/backend_mock'),'-I'+str(r/'sw/rp2040-psram'),'-I'+str(r/'tests/ultrags/unit/sdk_mock'),'-I'+str(r/'sw'),
    '-I'+str(r/'sw/ultrags'),'-include',str(r/'sw/ultrags/ug_psram_wait.h'),*map(lambda s:str(r/s),backend_src),'-o',str(backend_exe)]
subprocess.run(backend_cmd,check=True)
subprocess.run([str(backend_exe),str(a.build/'s3-backend.json')],check=True,timeout=30)

# Prove that this new regression actually rejects the previous READ ID
# behavior and, separately, a missing normal-phase switch on fudge boards.
adapter=r/'sw/ultrags/ug_psram.c'
production=adapter.read_text()
mutations={
    'old-id-profile':('    id_profile(ps,true,true);','    /* missing safe ID profile */'),
    'id-uses-fast-read':('const struct pio_program *next=enter?&ug_psram_id_program:data;',
                         'const struct pio_program *next=enter?&spi_psram_program:data;'),
}
rejected={}
for name,(old,new) in mutations.items():
    assert production.count(old)==1, 'ambiguous mutation '+name
    mutant=a.build/(name+'.c'); mutant.write_text(production.replace(old,new))
    mutant_exe=a.build/name
    cmd=[str(mutant) if word==str(adapter) else str(mutant_exe) if word==str(backend_exe) else word for word in backend_cmd]
    subprocess.run(cmd,check=True,capture_output=True)
    result=subprocess.run([str(mutant_exe)],capture_output=True,text=True,timeout=30)
    assert result.returncode!=0 and 'assert' in result.stderr.lower(), 'READ ID mutation survived: '+name
    rejected[name]={'returncode':result.returncode,'source_sha256':hashlib.sha256(mutant.read_bytes()).hexdigest(),
                    'executable_sha256':hashlib.sha256(mutant_exe.read_bytes()).hexdigest(),'failure':result.stderr.strip()}
print('S3 READ ID: missing ID profile and FAST READ engine mutations rejected')
(a.build/'s3-id-mutations.json').write_text(json.dumps(rejected,indent=2)+'\n')

inputs={r/s for s in src+backend_src} | set((r/'sw/ultrags').glob('*.h')) | set((r/'tests/ultrags/unit/sdk_mock').rglob('*.h')) | set((r/'tests/ultrags/unit/backend_mock').rglob('*.h')) | {r/'sw/ultrags/ug_psram_id.pio',r/'sw/rp2040-psram/psram_spi.h',r/'sw/rp2040-psram/psram_spi.pio',r/'tools/ultrags/s3-host.py',r/'tools/ultrags/wire-schema.json',r/'tools/ultrags/gen-wire.mjs',r/'sw/system/flash_settings.h',r/'sw/multifw/ug_catalog.h'}
inputs.update((r/'sw/ultrags').glob('*.inc'))
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
(a.build/'s3-host-evidence.json').write_text(json.dumps({'inputs':{str(p):h(p) for p in sorted(inputs)},'executable':h(exe),'backend_executable':h(backend_exe),
    'outputs':{name:h(a.build/name) for name in ['s3-fixtures.json','s3-commands.json','s3-backend.json','s3-id-mutations.json']},
    'compiler':subprocess.check_output(shlex.split(a.cc)+['--version'],text=True).splitlines()[0],'sanitizer':'UBSan'},indent=2)+'\n')
