#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute linked cached OPL/FWSTRING replies; no physical timing claim."""
import argparse,importlib.util,json,struct
from pathlib import Path
from unicorn import UC_HOOK_CODE,UC_HOOK_MEM_READ,UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_PC,UC_ARM_REG_SP,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3,UC_ARM_REG_R5,UC_ARM_REG_R8
root=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('audio',Path(__file__).with_name('audio-render-check.py'))
audio=importlib.util.module_from_spec(spec);spec.loader.exec_module(audio)
p=argparse.ArgumentParser();p.add_argument('--build',action='append',type=Path,required=True);a=p.parse_args()
for build in a.build:
    build=build.resolve();elf=build/'multifw-release/pg-ultrags-multifw.elf'
    m=audio.Machine(elf,'arm-none-eabi-nm');m.uc.mem_map(0x50200000,0x1000)
    word=lambda address:struct.unpack('<I',m.uc.mem_read(address,4))[0]
    put=lambda address,v:m.uc.mem_write(address,struct.pack('<I',v))
    completion=m.sym['ug_compat_completions'];atomic=m.sym['__atomic_fetch_add_4']
    scalar=m.sym['_ZL15ug_scalar_reply'];current=m.sym['_ZL8cur_read'];text_pointer=m.sym['firmware_string'];text=word(text_pointer)
    state={}
    def code(uc,address,size,_):
        if address==state['end']:uc.emu_stop();return
        assert state['start']<=address<state['end'] or (state['sent'] and atomic<=address<atomic+40),hex(address)
        state['instructions']+=1
    def read(uc,access,address,size,value,_):
        if 0xd0000100<=address<0xd0000180:
            assert state['sent'],'spinlock before reply';uc.mem_write(address,struct.pack('<I',1))
        assert not 0x40054000<=address<0x40054044,'timer MMIO in reply span'
    def write(uc,access,address,size,value,_):
        if address==0x50200014:
            assert not state['sent'] and value==(state['value']|0xff00)
            if state['kind']=='fwstring':assert word(current)==state['index']
            state['sent']=state['instructions']
        elif address==completion:
            assert state['sent'] and value==1;state['accounted']=True
        elif address==0xd0000134:
            assert state['accounted'] and value==0
        else:
            assert state['kind']=='fwstring' and address==current and state['sent'] and state['accounted']
            assert value==(state['index']+1 if state['value'] else 0)
    m.uc.hook_add(UC_HOOK_CODE,code);m.uc.hook_add(UC_HOOK_MEM_READ,read);m.uc.hook_add(UC_HOOK_MEM_WRITE,write)
    def run(kind,value,index=0,port=0):
        state.clear();state.update(kind=kind,value=value,index=index,sent=0,accounted=False,instructions=0)
        if kind=='opl':
            start,end=(m.sym[n] for n in ['ug_opl_status_fast_begin','ug_opl_status_fast_done'])
            assert bytes(m.uc.mem_read(start,2))==b'\x12\x9b' # cache pointer at sp+72 (R3 layout)
            m.uc.mem_write(m.sym['ug_opl_status_value'],bytes([value]))
        elif kind=='scalar':
            start,end=(m.sym[n] for n in ['ug_scalar_fast_begin','ug_scalar_fast_done'])
            assert bytes(m.uc.mem_read(start,4))==b'\x01\x21\x19\x98' # pointer at sp+100 (R3 layout)
            lanes=[255-value,255-value];lanes[port&1]=value
            m.uc.mem_write(scalar,bytes(lanes))
        else:
            start,end=(m.sym[n] for n in ['ug_fwstring_fast_begin','ug_fwstring_fast_done'])
            assert bytes(m.uc.mem_read(start,2))==b'\x11\x9b' # stream pointer at sp+68 (R3 layout)
            put(current,index)
        state.update(start=start,end=end)
        # main()'s R3 frame: completion pointer sp+20, cur_read sp+68, status
        # byte sp+72, firmware string sp+80, scalar pair sp+100. The PIO base
        # arrives in r2 (scalar) or r1 (FWSTRING) from the preceding IO_WAIT store.
        put(completion,0);put(m.STACK+20,completion);put(m.STACK+68,current)
        put(m.STACK+72,m.sym['ug_opl_status_value']);put(m.STACK+80,text_pointer);put(m.STACK+100,scalar)
        m.uc.reg_write(UC_ARM_REG_SP,m.STACK);m.uc.reg_write(UC_ARM_REG_R2,0x50200000);m.uc.reg_write(UC_ARM_REG_R1,0x50200000)
        m.uc.reg_write(UC_ARM_REG_R3,port);m.uc.reg_write(UC_ARM_REG_R5,0) # DATA_PORT_HIGH dispatch leaves zero
        m.uc.reg_write(UC_ARM_REG_R8,0) # the FWSTRING tail reuses a register the dispatch left zero for cur_read=0
        m.uc.emu_start(start|1,end,count=200)
        assert m.reg(UC_ARM_REG_PC)==end and state['sent'] and state['accounted']
        return state['sent']
    opl={run('opl',v) for v in range(256)};assert opl=={9},opl
    scalar_counts={run('scalar',v,port=port) for port in [0x1d1,0x1d2] for v in range(256)};assert scalar_counts=={8},scalar_counts
    original=bytearray()
    while True:
        v=bytes(m.uc.mem_read(text+len(original),1))[0];original.append(v)
        if not v:break
        assert len(original)<128
    fw=set()
    for i,v in enumerate(original):fw.add(run('fwstring',v,i))
    for v in range(256):
        m.uc.mem_write(text+2,bytes([v]));fw.add(run('fwstring',v,2))
    m.uc.mem_write(text,bytes(original));assert fw=={14},fw
    paths=[elf,Path(__file__),Path(__file__).with_name('audio-render-check.py'),root/'sw/picogus.cpp',root/'sw/ultrags/ug_opl.c',root/'sw/ultrags/ug_opl.h']
    report=dict(status='LINKED_READ_REPLY_PASS / REAL_PENDING',build=str(build),oplCases=256,scalarCases=512,scalarInstructionsThroughFIFO=8,fwstringCases=len(original)+256,oplInstructionsThroughFIFO=9,fwstringInstructionsThroughFIFO=14,noTimerOrCallsBeforeFIFO=True,completionAfterFIFO=True,streamAdvanceAfterFIFO=True,inputs={str(f.resolve()):audio.digest(f) for f in paths},limits=['Spans begin after IO_WAIT; register/stack entry contracts are supplied.','No electrical/physical timing or SRAM contention claim.'])
    (build/'host/adlib/read-linked.json').write_text(json.dumps(report,indent=2)+'\n')
    print('Cached OPL and FWSTRING linked replies PASS:',build,report['oplCases'],report['fwstringCases'],flush=True)
