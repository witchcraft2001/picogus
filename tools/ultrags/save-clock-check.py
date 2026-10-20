#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Require a fixed ISA clock through ULTRAGS SAVE and audit actual Flash setup."""
import argparse
import hashlib
import json
import re
import shlex
import struct
import subprocess
from pathlib import Path
from cfg_evidence import verify_multifw
from firmware_evidence import compare_image_except_sdk_date

p=argparse.ArgumentParser()
p.add_argument('--build',type=Path,required=True)
p.add_argument('--cc',default='cc')
p.add_argument('--host-only',action='store_true')
a=p.parse_args()
r=Path(__file__).resolve().parents[2];b=a.build.resolve()
out=b/'host/save-clock';out.mkdir(parents=True,exist_ok=True)
inputs=[Path(__file__).resolve(),r/'sw/system/flash_settings.c',r/'sw/system/flash_settings.h',
 r/'tests/ultrags/unit/test_save_clock.c',r/'tests/ultrags/unit/s2_mock/mock.h',
 r/'tests/ultrags/reference/rp2040-rom/program_flash_generic.c',
 r/'tests/ultrags/reference/rp2040-rom/LICENSE.TXT',r/'tests/ultrags/reference/sources.json']
artifacts=[];cases=[]
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def run_case(name,defines,source=None,compile_ok=True,execute_ok=True):
 exe=out/name
 command=shlex.split(a.cc)+['-std=c11','-O1','-g','-Wall','-Wextra','-fsanitize=undefined',
  '-fno-sanitize-recover=all','-I'+str(r/'tests/ultrags/unit/s2_mock'),'-I'+str(r/'sw'),
  '-I'+str(r/'sw/system'),'-DRP2_CLOCK_SPEED=370000','-DPICO_FLASH_SPI_CLKDIV=4']+defines+[
  str(r/'tests/ultrags/unit/test_save_clock.c'),str(source or r/'sw/system/flash_settings.c'),'-o',str(exe)]
 result=subprocess.run(command,capture_output=True,text=True)
 log=out/(name+'.log');log.write_text(result.stdout+result.stderr);artifacts.append(log)
 assert (result.returncode==0)==compile_ok,name+' compile: '+result.stderr
 if compile_ok:
  result=subprocess.run([str(exe)],capture_output=True,text=True,timeout=15)
  log.write_text(log.read_text()+result.stdout+result.stderr)
  assert (result.returncode==0)==execute_ok,name+' execution'
  artifacts.append(exe)
 cases.append(dict(name=name,ok=True));print('PASS SAVE clock '+name)
run_case('ultrags-rp2040',['-DSOUND_ULTRAGS=1','-DPICO_RP2040=1'])
run_case('legacy-gus',['-DSOUND_GUS=1','-DPICO_RP2040=1','-DSAVE_EXPECT_LEGACY=1'])
run_case('legacy-other-mcu',['-DSOUND_ULTRAGS=1','-DPICO_RP2040=0','-DSAVE_EXPECT_LEGACY=1'])
mutant=out/'old-clock.c'
s=(r/'sw/system/flash_settings.c').read_text()
s=s.replace('#if defined(SOUND_ULTRAGS) && PICO_RP2040','#if 0').replace('#if !(defined(SOUND_ULTRAGS) && PICO_RP2040)','#if 1')
mutant.write_text(s);artifacts.append(mutant)
run_case('old-clock-rejected',['-DSOUND_ULTRAGS=1','-DPICO_RP2040=1'],mutant,execute_ok=False)
run_case('unsafe-divider-rejected',['-DSOUND_ULTRAGS=1','-DPICO_RP2040=1','-UPICO_FLASH_SPI_CLKDIV','-DPICO_FLASH_SPI_CLKDIV=2'],compile_ok=False)
run_case('unsafe-rate-rejected',['-DSOUND_ULTRAGS=1','-DPICO_RP2040=1','-URP2_CLOCK_SPEED','-DRP2_CLOCK_SPEED=900000'],compile_ok=False)
if a.host_only:raise SystemExit(0)

fw=b/'multifw-release';verify_multifw(fw)
cache=(fw/'CMakeCache.txt').read_text()
def cached(key):return re.search(r'^'+key+r':[^=]+=(.*)$',cache,re.M)[1]
sdk=Path(cached('PICO_SDK_PATH'));objdump=cached('CMAKE_C_COMPILER').removesuffix('gcc')+'objdump'
inputs += [fw/'CMakeCache.txt',sdk/'src/rp2_common/hardware_flash/flash.c',
 sdk/'src/rp2040/boot_stage2/boot2_w25q080.S',r/'sw/boards/picogus2.h',r/'sw/boards/picow_fast.h']
rom=(r/'tests/ultrags/reference/rp2040-rom/program_flash_generic.c').read_text()
assert re.search(r'ssi->baudr\s*=\s*6\s*;',rom)
assert re.search(r'void\s+__noinline\s+flash_exit_xip\([^)]*\)\s*\{.*?flash_init_spi\(\)',rom,re.S)
flash=(sdk/'src/rp2_common/hardware_flash/flash.c').read_text()
for name in ('flash_range_erase','flash_range_program'):
 start=flash.index('void __no_inline_not_in_flash_func('+name+')')
 block=flash[start:flash.index('\n}',start)]
 assert 'flash_exit_xip_func();' in block and 'flash_enable_xip_via_boot2();' in block

# Interpret the straight-line boot2 setup up to its actual SSI BAUDR store.
# SDK flash_range_* copies boot2 from XIP_BASE (the bundled bootloader).
assert 'copy_from = (uint32_t *)XIP_BASE' in flash
boot=fw/'bootloader.bin';inputs.append(boot);boot2=boot.read_bytes()[:256]
regs=[0]*8;divider=None;setup=[]
for pc in range(0,64,2):
 w=struct.unpack_from('<H',boot2,pc)[0];setup.append(w)
 if w&0xf800==0x4800:regs[(w>>8)&7]=struct.unpack_from('<I',boot2,((pc+4)&~3)+(w&255)*4)[0]
 elif w&0xf800==0x2000:regs[(w>>8)&7]=w&255
 elif w&0xf800==0x6000:
  address=regs[(w>>3)&7]+((w>>6)&31)*4
  if address==0x18000014:divider=regs[w&7];break
 assert w&0xf000 not in (0xd000,0xe000),'unexpected boot2 branch before SSI setup'
assert divider==4,'compiled bootloader Flash divider'
assert 370000000/divider<=133000000 and 370000000/6<=133000000

clock_names=re.compile(r'^(?:set_sys_clock|clock_configure|pll_init|vreg_set_voltage)')
closures={}
flags=fw/'CMakeFiles/pg-ultrags-multifw.dir/flags.make';inputs.append(flags)
assert all(x in flags.read_text() for x in ('-DRP2_CLOCK_SPEED=370000','-DPICO_RP2040=1','-DSOUND_ULTRAGS=1'))
for mode in ('gus','ultrags'):
 elf=fw/f'pg-{mode}-multifw.elf';inputs.append(elf)
 text=subprocess.check_output([objdump,'-d','-C',str(elf)],text=True)
 blocks=list(re.finditer(r'^([0-9a-f]+) <(.+)>:\n',text,re.M))
 funcs={m[2]:text[m.start():blocks[i+1].start() if i+1<len(blocks) else len(text)] for i,m in enumerate(blocks)}
 assert 'saveSettings' in funcs and 'ug_maintenance_poll' in funcs
 def calls(name):return set(re.findall(r'\b(?:blx?|b\.w|b\.n)\s+[0-9a-f]+\s+<([^>]+)>',funcs[name]))&funcs.keys()
 visited=set();pending=['ug_maintenance_poll','saveSettings']
 while pending:
  name=pending.pop()
  if name in visited:continue
  visited.add(name);pending.extend(calls(name)-visited)
 clocks=sorted(n for n in visited if clock_names.match(n))
 assert bool(clocks)==(mode=='gus'),(mode,clocks)
 assert {'flash_range_erase','flash_range_program'}<=visited
 if mode=='ultrags':
  assert all(token not in ''.join(funcs[n] for n in visited) for token in ('40008000','40028000','4002c000')),'clock/PLL MMIO in SAVE closure'
 path=out/(mode+'-save.dis');path.write_text('\n'.join(funcs[n] for n in sorted(visited)));artifacts.append(path)
 closures[mode]=dict(functions=sorted(visited),clock_calls=clocks)
 image=fw/f'pg-{mode}-multifw.bin';inputs.append(image)
 assert image.read_bytes()[:256]==boot2
baseline=r/'build/save-clock-baseline/GUS.bin'
baseline_comparison=None
if baseline.exists():
 inputs.append(baseline)
 baseline_comparison=compare_image_except_sdk_date(baseline.read_bytes(),(fw/'pg-gus-multifw.bin').read_bytes(),fw/'pg-gus-multifw.elf',objdump.removesuffix('objdump')+'nm')
report=dict(status='LINKED_SAVE_CLOCK_PASS / REAL_PENDING',host_cases=cases,baseline_comparison=baseline_comparison,
 core_clock_hz=370000000,boot2_divider=divider,rom_command_divider=6,
 xip_hz=92500000,program_hz=370000000/6,boot2_setup_words=setup,closures=closures,
 rom_revision='ef22cd8ede5bc007f81d7f2416b48db90f313434',
 inputs={str(x):sha(x) for x in inputs},artifacts={str(x):sha(x) for x in artifacts},
 limitations=['No physical ISA setup/hold, bus waveform or core0 arbitration measurement',
 'PIO early filtering still covers native BASE/ALIAS only; configuration stays software handshake',
 'RP2040 ROM source reference; the physical chip ROM is not dumped by this gate'])
(b/'host/save-clock.json').write_text(json.dumps(report,indent=2)+'\n')
print('PASS linked ULTRAGS SAVE has no clock changes; GUS retains original clock path; compiled boot2 /4 and ROM /6')
