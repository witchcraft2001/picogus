#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import argparse,subprocess,shlex,json,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--cc',default='cc');a=p.parse_args();r=Path(__file__).resolve().parents[2];a.build.mkdir(parents=True,exist_ok=True)
subprocess.run(['node',str(r/'tools/ultrags/gen-wire.mjs'),str(r/'tools/ultrags/wire-schema.json'),str(a.build/'gen')],check=True)
src=['tests/ultrags/unit/test_s4.c','tests/ultrags/unit/sdk_mock/sdk_mock.c','sw/multifw/ug_catalog.c','sw/ultrags/ug_config.c','sw/ultrags/ug_minimal.c','sw/ultrags/ug_storage.c','sw/ultrags/ug_store.c','sw/ultrags/ug_memory.c','sw/ultrags/ug_psram.c','sw/ultrags/ug_hwmap.c','sw/ultrags/ug_pcm.c','sw/ultrags/ug_render.c','sw/ultrags/ug_mod.c']
inputs={r/s for s in src} | set((r/'sw/ultrags').glob('*.h')) | set((r/'common').glob('*.h')) | set((r/'tests/ultrags/unit/sdk_mock').rglob('*.h')) | {r/'tools/ultrags/s4-host.py',r/'tools/ultrags/wire-schema.json',r/'tools/ultrags/gen-wire.mjs',r/'sw/system/flash_settings.h',r/'sw/multifw/ug_catalog.h'}
inputs.add(a.build.resolve()/'gen/ug_wire.h')
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
captured={str(p):h(p) for p in sorted(inputs)}
exe=a.build/'s4'
compile_cmd=shlex.split(a.cc)+['-std=c11','-O2','-g','-Wall','-Wextra','-pthread','-fsanitize=undefined','-fno-sanitize-recover=all','-DUG_S4_TEST=1','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1','-I'+str(r/'tests/ultrags/unit/sdk_mock'),'-I'+str(r/'sw'),'-I'+str(r/'sw/ultrags'),'-I'+str(r/'common'),'-I'+str(a.build/'gen'),*map(lambda s:str(r/s),src),'-o',str(exe)]
subprocess.run(compile_cmd,check=True)
subprocess.run([str(exe),str(a.build/'s4-host.json'),str(a.build/'s4-commands.json')],check=True,timeout=300)

# Run the same real C framing/latches with the old timeout arithmetic. It
# must fail on a newer core0 ACK, before the long memory regression starts.
storage=r/'sw/ultrags/ug_storage.c'
old='idle>=5000000 && idle<UINT32_C(0x80000000)'
production=storage.read_text();assert production.count(old)==1
mutant=a.build/'s4-timeout-old.c';mutant.write_text(production.replace(old,'idle>=5000000'))
mutant_exe=a.build/'s4-timeout-old'
subprocess.run([str(mutant) if arg==str(storage) else str(mutant_exe) if arg==str(exe) else arg
                for arg in compile_cmd],check=True,capture_output=True)
rejected=subprocess.run([str(mutant_exe)],capture_output=True,text=True,timeout=30)
assert rejected.returncode!=0 and 'timeout_race' in rejected.stderr and 'ug_storage_grant()' in rejected.stderr, 'old transfer timeout survived'
(a.build/'s4-timeout-mutation.json').write_text(json.dumps({'returncode':rejected.returncode,
    'source_sha256':h(mutant),'executable_sha256':h(mutant_exe),'failure':rejected.stderr.strip()},indent=2)+'\n')
print('S4 newer-core0-timestamp regression rejects old unsigned timeout')

assert captured=={str(p):h(p) for p in sorted(inputs)},'S4 HOST sources changed during build/run'
(a.build/'s4-host-evidence.json').write_text(json.dumps({'inputs':captured,'executable':h(exe),'outputs':{name:h(a.build/name) for name in ['s4-host.json','s4-commands.json','s4-timeout-mutation.json']},'compiler':subprocess.check_output(shlex.split(a.cc)+['--version'],text=True).splitlines()[0],'sanitizer':'UBSan'},indent=2)+'\n')
