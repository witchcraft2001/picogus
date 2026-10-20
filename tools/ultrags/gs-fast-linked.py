#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute actual linked GS reply spans; instruction counts are NOT ISA ns."""
import argparse,importlib.util,json,struct
from pathlib import Path
from unicorn import UC_HOOK_CODE,UC_HOOK_MEM_READ,UC_HOOK_MEM_WRITE
from unicorn.arm_const import *

root=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('audio',root/'tools/ultrags/audio-render-check.py')
audio=importlib.util.module_from_spec(spec);spec.loader.exec_module(audio)
p=argparse.ArgumentParser()
p.add_argument('build_a',type=Path);p.add_argument('build_b',type=Path)
p.add_argument('--nm',default='/Users/dmitry/dev/zx/sprinter/toolchain/armgcc/bin/arm-none-eabi-nm')
a=p.parse_args();rows=[];inputs={str(Path(__file__).resolve()):audio.digest(__file__)}
oldelf=root/'build/config-fast12-a/multifw-release/pg-ultrags-multifw.elf'
inputs[str(oldelf)]=audio.digest(oldelf)
old=[]
for flags in (0,1,128,129):
    for delayed in (0,16):
        m=audio.Machine(oldelf,a.nm);m.uc.mem_write(m.sym['gs_flags'],bytes([flags]))
        locks=[0];reads=[]
        def spin(uc,access,address,size,value,_):
            locks[0]+=1;uc.mem_write(address,struct.pack('<I',0 if locks[0]<=delayed else 1))
            reads.append(address)
        m.uc.hook_add(UC_HOOK_MEM_READ,spin,begin=0xd0000100,end=0xd000017f)
        m.counting=True
        value=m.call('ug_minimal_read_decoded',[0x1b])
        assert value==0x7e|flags and locks[0]>delayed
        old.append(dict(flags=flags,blockedSpinReads=delayed,spinReads=locks[0],
                        instructions=m.instructions,value=value))
for build in (a.build_a,a.build_b):
    elf=build/'multifw-release/pg-ultrags-multifw.elf'
    m=audio.Machine(elf,a.nm);m.uc.mem_map(0x50200000,0x1000)
    start,end=(m.sym[n] for n in ('ug_gs_fast_begin','ug_gs_fast_submitted'))
    # Verify this compiler's entry contract instead of guessing saved registers:
    # final instruction is STR r3,[r5,#20], where r5=PIO0 from prior IO_WAIT.
    assert bytes(m.uc.mem_read(end-2,2))==b'\x6b\x61'
    state={}
    def step(uc,address,size,_):
        if address==end:uc.emu_stop();return
        state['instructions']+=1
        assert address!=m.sym['ug_stat_add'],'statistics before reply'
    def read(uc,access,address,size,value,_):
        assert not 0xd0000100<=address<0xd0000180,'spinlock before reply'
    def write(uc,access,address,size,value,_):
        assert address==0x50200014 and size==4,'unexpected write before reply'
        state['writes'].append(value)
    m.uc.hook_add(UC_HOOK_CODE,step)
    m.uc.hook_add(UC_HOOK_MEM_READ,read)
    m.uc.hook_add(UC_HOOK_MEM_WRITE,write)
    for flags in (0,1,128,129):
        state={'instructions':0,'writes':[]}
        m.uc.mem_write(m.sym['gs_flags'],bytes([flags]))
        m.uc.reg_write(UC_ARM_REG_R5,0x50200000)
        m.uc.reg_write(UC_ARM_REG_SP,m.STACK)
        m.uc.emu_start(start|1,end,count=200)
        assert m.reg(UC_ARM_REG_PC)==end and state['writes']==[0xff00|0x7e|flags]
        assert state['instructions']<=16
        rows.append(dict(build=str(build),flags=flags,**state))
    inputs[str(elf.resolve())]=audio.digest(elf)
assert max(r['instructions'] for r in rows)<min(r['instructions'] for r in old)
report={'status':'LINKED_GS_FAST_PASS / REAL_PENDING','baseline':old,'results':rows,'inputs':inputs,
 'limits':['New span begins AFTER IO_WAIT; old count is only the general register getter.',
           'No full polling/decode/PIO/ISA latency bound or electrical timing measurement.',
           'Spinlock hold uses declared read counts, not measured core1 contention.',
           'The entry PIO pointer in r5 is supplied; full main initialization is not emulated.']}
(a.build_a/'host/gs-fast-linked.json').write_text(json.dumps(report,indent=2)+'\n')
print('Linked GS fast PASS; new instructions',sorted({r['instructions'] for r in rows}),
      'old getter instructions',sorted({r['instructions'] for r in old}))
