#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Linked ARM capture/verdict plus generated PIO, with a finite host cycle.

Instruction ticks and functional GPIO/PIO model, NOT a measured electrical
deadline or a bound on full polling, SRAM arbitration or IRQ latency. Core0
must reach capture before the CONFIG deadline; native early wait is separate.
The declared baseline reproduces the R2 unheld CONFIG read across prior work.
"""
import argparse,hashlib,importlib.util,json,struct
from pathlib import Path
from unicorn import UC_HOOK_CODE,UC_HOOK_MEM_READ,UC_HOOK_MEM_WRITE
from unicorn.arm_const import UC_ARM_REG_PC,UC_ARM_REG_R0

ROOT=Path(__file__).resolve().parents[2]
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
audio=module('audio_arm',ROOT/'tools/ultrags/audio-render-check.py')
pio=module('pio_model',ROOT/'tools/ultrags/pio-isa-check.py')
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()

class ConfigRead(audio.Machine):
    def __init__(self,elf,nm,header,port,deadline=128):
        super().__init__(elf,nm)
        self.uc.mem_map(0x50200000,0x4000)
        words,self.labels,wrap=pio.program(header,'ug_handshake_ior')
        linked=next(v for k,v in self.sym.items() if k.endswith('ug_handshake_ior_program_instructions'))
        assert bytes(self.uc.mem_read(linked,64))==struct.pack('<32H',*words),'PIO header does not match the linked ARM peer'
        self.sm=pio.native(words,self.labels,wrap,0x2a0,0xffff)
        self.sm.port=port;self.sm.ior=0
        for _ in range(64):
            self.sm.step()
            if self.sm.pc==self.labels['parked']:break
        assert len(self.sm.rx)==(1 if 'address_only' in self.labels else 2) and not self.sm.hold and not self.sm.ads
        self.sm.rx.clear() # production caller drained the address-only or legacy pair
        self.now=0;self.deadline=deadline;self.sample=None;self.first_hold=None
        self.counting=True
        self.uc.hook_add(UC_HOOK_CODE,self.step_arm)
        self.uc.hook_add(UC_HOOK_MEM_READ,self.mmio_read,begin=0xd0000000,end=0xd00001ff)
        self.uc.hook_add(UC_HOOK_MEM_WRITE,self.mmio_write,begin=0x50200000,end=0x50203fff)
    def tick(self):
        self.now+=1
        if 'arm_value' in self.labels or self.now%2==0:self.sm.step()
        if self.sm.hold and self.first_hold is None:self.first_hold=self.now
        if self.now>=self.deadline and self.sample is None and not self.sm.hold:
            self.sample=self.sm.value if self.sm.dirs==255 and self.sm.ads else 255
            self.sm.ior=1
    def step_arm(self,uc,address,size,_):self.tick()
    def advance(self,n):
        for _ in range(n):self.tick()
    def mmio_read(self,uc,access,address,size,value,_):
        if address==0xd0000004:
            pins=(self.sm.port<<6)|(self.sm.ior<<5)|(1<<4)
            uc.mem_write(address,struct.pack('<I',pins))
        if 0xd0000100<=address<0xd0000180:uc.mem_write(address,struct.pack('<I',1))
    def mmio_write(self,uc,access,address,size,value,_):
        if address in (0x50200000,0x50202000) and value&0x20:self.sm.osr=0;self.sm.outc=32
        if address==0x50200014:self.sm.tx.append(value)
        if address==0x502000f0:
            if value&0x1000:self.sm.hold=(value>>10)&1;self.sm.ads=(value>>11)&1
            if value>>13==3:
                if self.sm.outc>=32:self.sm.osr,self.sm.outc=self.sm.tx.pop(0),0
                byte=self.sm.osr&255;self.sm.osr>>=8;self.sm.outc+=8
                if (value>>5)&7==0:self.sm.value=byte
                else:assert (value>>5)&7==4;self.sm.dirs=byte
            if value>>13==0:self.sm.pc=value&31;self.sm.delay=0
    def run(self,port,work,*,fixed=True,expired=False):
        if expired:self.advance(self.deadline+4)
        service=self.call('ug_handshake_capture',[1,port,0])
        self.advance(work)
        consumed=0
        if not fixed or service:
            self.call('ug_handshake_put',[1,0xffffffff])
            consumed=1
            self.call('ug_handshake_put',[1,0xff24])
        else:self.call('ug_handshake_put',[1,0])
        self.advance(512)
        assert self.sample is not None and not self.sm.dirs and not self.sm.hold and not self.sm.ads
        return dict(port=hex(port),prior_write_work_ticks=work,expired=expired,
                    sampled=self.sample,consumed=consumed,first_wait_tick=self.first_hold,
                    arm_instructions=self.instructions)

def main():
    p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--baseline',type=Path)
    p.add_argument('--nm',default='arm-none-eabi-nm');a=p.parse_args();b=a.build.resolve()
    elf=b/'multifw-release/pg-ultrags-multifw.elf';header=b/'multifw-release/ug_handshake_ior.pio.h'
    baseline_header=a.baseline.with_name('ug_handshake_ior.pio.h') if a.baseline else header
    rows=[]
    for port in (0x1d0,0x1d1,0x1d2):
        for work in (128,512,4096):
            old=(ConfigRead(a.baseline,a.nm,baseline_header,port).run(port,work,fixed=False) if a.baseline else
                 ConfigRead(elf,a.nm,header,port).run(port,work,expired=True))
            new=ConfigRead(elf,a.nm,header,port).run(port,work)
            assert old['sampled']==255 and old['consumed']==(1 if a.baseline else 0),old
            assert new['sampled']==36 and new['consumed']==1,new
            rows.append(dict(baseline=old,fixed=new))
        old=(ConfigRead(a.baseline,a.nm,baseline_header,port).run(port,0,fixed=False,expired=True) if a.baseline else
             ConfigRead(elf,a.nm,header,port).run(port,0,expired=True))
        new=ConfigRead(elf,a.nm,header,port).run(port,0,expired=True)
        assert old['sampled']==new['sampled']==255 and old['consumed']==(1 if a.baseline else 0) and new['consumed']==0
        rows.append(dict(baseline=old,fixed=new))
    files=[elf,header,Path(__file__),ROOT/'tools/ultrags/pio-isa-check.py',ROOT/'tools/ultrags/audio-render-check.py',
           ROOT/'sw/picogus.cpp',ROOT/'sw/ultrags/ug_handshake.c',ROOT/'sw/ultrags/ug_handshake.h']
    if a.baseline:files.extend([a.baseline,baseline_header])
    e=dict(status='LINKED_CONFIG_READ_PASS / REAL_PENDING',cpu='Cortex-M0',cases=rows,
           baseline_kind='declared linked R2 ARM capture' if a.baseline else 'postponed capture control on current ARM',
           inputs={str(f.resolve()):digest(f) for f in files},
           limits=['Capture must still meet the finite CONFIG host deadline; this is not an ARM-independent CONFIG classifier',
                   'Instruction ticks are functional test scheduling, not measured RP2040 cycles or a full-loop timing bound'])
    (b/'host').mkdir(exist_ok=True);(b/'host/config-read-arm.json').write_text(json.dumps(e,indent=2)+'\n')
    print('Linked CONFIG capture/verdict + generated PIO: 9 delayed replies / 3 stale-read eligibility checks PASS / REAL_PENDING')
if __name__=='__main__':main()
