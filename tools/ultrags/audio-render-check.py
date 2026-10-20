#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute the linked Cortex-M0+ mixer, not a host-compiled C timing mock.

Count ARM instructions/calls and compare exact samples against an optional
previous ELF. PSRAM/cache-fill and ROM memcpy/memset are functional models;
these counts are NOT an electrical or wall-clock render-deadline proof.
"""
import argparse, hashlib, json, re, struct, subprocess
from pathlib import Path
import unicorn
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS, UC_HOOK_CODE, UC_HOOK_MEM_WRITE, UC_HOOK_MEM_READ
from unicorn.arm_const import *

ROOT=Path(__file__).resolve().parents[2]
def digest(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def symbols(path,nm):
    out={}
    for line in subprocess.check_output([nm,'--defined-only',str(path)],text=True).splitlines():
        m=re.match(r'^([0-9a-fA-F]+)\s+\w\s+(\S+)$',line)
        if m:out[m[2]]=int(m[1],16)
    return out
def segments(path):
    b=Path(path).read_bytes();assert b[:6]==b'\x7fELF\x01\x01'
    phoff=struct.unpack_from('<I',b,28)[0];size,count=struct.unpack_from('<HH',b,42)
    for i in range(count):
        kind,off,vaddr,_,filesz,memsz,_,_=struct.unpack_from('<8I',b,phoff+i*size)
        if kind==1 and memsz:yield vaddr,b[off:off+filesz]

class Machine:
    MIX=0x20100000;OUT=0x20140000;STOP=0x201fd000;READ=0x201fe000;STACK=0x201ff000;DATA=0x20200000
    def __init__(self,elf,nm):
        self.sym=symbols(elf,nm);self.uc=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS)
        self.uc.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M0)
        for base,size in [(0x10000000,0x200000),(0x20000000,0x1000000),(0xd0000000,0x1000)]:self.uc.mem_map(base,size)
        for address,data in segments(elf):self.uc.mem_write(address,data)
        self.uc.mem_write(self.DATA,bytes(range(256))*32768)
        self.uc.mem_write(self.READ,b'\x00\x20\x70\x47') # movs r0,0; bx lr
        self.instructions=self.div64=self.reads=self.read_bytes=0
        self.counting=False;self.sio=[0,1,0,1,0,0,1]
        self.mem_functions={}
        for name,address in self.sym.items():
            if name in ('__wrap_memset','memset'):self.mem_functions[address]='set'
            if name in ('__wrap_memcpy','__wrap___aeabi_memcpy','memcpy','__aeabi_memcpy'):self.mem_functions[address]='copy'
        self.div_functions={v for k,v in self.sym.items() if k in ('__wrap___aeabi_ldivmod','__wrap___aeabi_uldivmod')}
        self.uc.hook_add(UC_HOOK_CODE,self.code)
        self.uc.hook_add(UC_HOOK_MEM_WRITE,self.sio_write,begin=0xd0000060,end=0xd000007b)
        self.uc.hook_add(UC_HOOK_MEM_READ,self.sio_read,begin=0xd0000060,end=0xd000007b)
    def reg(self,r):return self.uc.reg_read(r)
    def ret(self):self.uc.reg_write(UC_ARM_REG_PC,self.reg(UC_ARM_REG_LR))
    def code(self,uc,address,size,_):
        if address==self.STOP:uc.emu_stop();return
        if self.counting:
            self.instructions+=1
            if address in self.div_functions:self.div64+=1
        if address==self.READ:
            src=self.reg(UC_ARM_REG_R0)+self.reg(UC_ARM_REG_R1);dst=self.reg(UC_ARM_REG_R2);n=self.reg(UC_ARM_REG_R3)
            assert 0<n<=256 and self.DATA<=src and src+n<=self.DATA+(8<<20)
            uc.mem_write(dst,bytes(uc.mem_read(src,n)))
            if self.counting:self.reads+=1;self.read_bytes+=n
            uc.reg_write(UC_ARM_REG_R0,0);self.ret()
        elif address in self.mem_functions:
            dst,n=self.reg(UC_ARM_REG_R0),self.reg(UC_ARM_REG_R2)
            if self.mem_functions[address]=='set':data=bytes([self.reg(UC_ARM_REG_R1)&255])*n
            else:data=bytes(uc.mem_read(self.reg(UC_ARM_REG_R1),n))
            if data:uc.mem_write(dst,data)
            self.ret()
    def sio_write(self,uc,access,address,size,value,_):
        i=(address-0xd0000060)//4;self.sio[i]=value&0xffffffff
        if i in (1,3):
            a,b=self.sio[i-1],self.sio[i]
            signed=i==3
            if signed:a=a if a<0x80000000 else a-0x100000000;b=b if b<0x80000000 else b-0x100000000
            assert b
            q=abs(a)//abs(b)
            if (a<0)!=(b<0):q=-q
            self.sio[4]=q&0xffffffff;self.sio[5]=(a-q*b)&0xffffffff;self.sio[6]=3
            uc.mem_write(0xd0000070,struct.pack('<III',*self.sio[4:7]))
    def sio_read(self,uc,access,address,size,value,_):
        if address==0xd0000070:
            self.sio[6]&=~2;uc.mem_write(0xd0000078,struct.pack('<I',self.sio[6]))
    def call(self,name,args):
        for r,value in zip((UC_ARM_REG_R0,UC_ARM_REG_R1,UC_ARM_REG_R2,UC_ARM_REG_R3),args):self.uc.reg_write(r,value&0xffffffff)
        stack=args[4:]
        if stack:self.uc.mem_write(self.STACK,struct.pack('<'+'I'*len(stack),*[x&0xffffffff for x in stack]))
        self.uc.reg_write(UC_ARM_REG_SP,self.STACK);self.uc.reg_write(UC_ARM_REG_LR,self.STOP|1)
        self.uc.emu_start(self.sym[name]|1,self.STOP,count=5000000)
        assert self.reg(UC_ARM_REG_PC)==self.STOP,(name,hex(self.reg(UC_ARM_REG_PC)))
        return self.reg(UC_ARM_REG_R0)
    def run(self,profile):
        self.call('ug_mixer_init',[self.MIX,self.READ|1,0,self.DATA,8<<20])
        lanes=[]
        if profile!='paused-mod-two-stereo':
            for i in range(4 if profile!='twelve-lane' else 8):
                step=((3546895<<32)//(214+i*73))//48000
                pan=[0,40,85,128,170,215,255,128][i] if profile=='twelve-lane' else [0,255,255,0][i%4]
                lanes.append((i,0x1001+i*4096,1024,step,48-i*3,pan,0,0,0))
        fx=0 if profile=='mod4' else 2 if profile=='mod4-one-stereo' else 4
        for i in range(fx):
            pan=(64 if i<2 else 192) if profile=='stereo-balance' else 128
            lanes.append((8+i,0x100001+(i//2)*4096,882,(44100<<32)//48000,16,pan,1,1+(i&1),i&1))
        if profile in ('32-mono-48000','32-mono-44100','16-stereo-48000','mod4-28-fx'):
            if profile=='mod4-28-fx': lanes=lanes[:4];start=4;rate=44100
            else:lanes=[];start=0;rate=44100 if profile=='32-mono-44100' else 48000
            for i in range(start,32):
                stereo=profile=='16-stereo-48000'
                lanes.append((i,0x200001+(i//2 if stereo else i)*4096,882,(rate<<32)//48000,
                              16+i%32,128 if stereo else i*13%256,1,(1+(i&1)) if stereo else 0,(i&1) if stereo else 0))
        for lane,offset,length,step,gain,pan,fmt,mode,side in lanes:
            assert self.call('ug_lane_set',[self.MIX,lane,offset,length,0,length,step&0xffffffff,step>>32,gain,pan,fmt,mode,1,side])==0
            # AAPCS rounds ug_lane's 580 data bytes to its u64 alignment.
            lane_address=self.MIX+16+lane*584
            assert struct.unpack('<II',self.uc.mem_read(lane_address,8))==(offset,length),'target lane ABI changed'
            pcm=lane>=4 if profile=='mod4-28-fx' else profile in ('32-mono-48000','32-mono-44100','16-stereo-48000') or lane>=8
            if pcm:self.call('ug_lane_pcm_rate',[lane_address,rate if profile in ('32-mono-48000','32-mono-44100','16-stereo-48000','mod4-28-fx') else 44100,48000,0])
        if 'ug_lane_share_cache' in self.sym:
            for lane,offset,length,step,gain,pan,fmt,mode,side in lanes:
                if mode==2:
                    partner=next((x[0] for x in lanes if x[1]==offset and x[7]==1),None)
                    if partner is not None:assert self.call('ug_lane_share_cache',[self.MIX,lane,partner])==0
        # The lane layout is a target ABI contract checked against init data:
        # ug_mem_if=16 bytes, ug_lane=584 bytes in the linked RP2040 build.
        assert struct.unpack('<I',self.uc.mem_read(self.MIX,4))[0]==self.READ|1
        self.counting=True;output=bytearray()
        for _ in range(8):
            assert self.call('ug_mixer_render',[self.MIX,self.OUT,128])==0
            output.extend(self.uc.mem_read(self.OUT,512))
        self.counting=False
        # Independent integer oracle: absolute frame time, no production cache,
        # phase-advance or optimized rounding/division helper is reused.
        def nearest(n,d):return (-1 if n<0 else 1)*((abs(n)+d//2)//d)
        expected=bytearray()
        for frame in range(1024):
            left=right=0
            for lane,offset,length,step,gain,pan,fmt,mode,side in lanes:
                pcm=lane>=4 if profile=='mod4-28-fx' else profile in ('32-mono-48000','32-mono-44100','16-stereo-48000') or lane>=8
                pcmrate=rate if profile in ('32-mono-48000','32-mono-44100','16-stereo-48000','mod4-28-fx') else 44100
                phase=(frame*pcmrate*(1<<32))//48000 if pcm else frame*step
                pos=(phase>>32)%length;fraction=phase&0xffffffff;nextpos=(pos+1)%length
                def sample(idx):
                    base=offset+(idx*(2 if mode else 1)+side)*(2 if fmt==1 else 1)
                    value=base&255
                    if fmt==1:
                        value|=((base+1)&255)<<8
                        return value if value<32768 else value-65536
                    return (value if value<128 else value-256)*256
                value=nearest(sample(pos)*((1<<32)-fraction)+sample(nextpos)*fraction,1<<32)
                value=nearest(value*gain,64)
                if not mode:
                    left+=nearest(value*(255-pan),255);right+=nearest(value*pan,255)
                elif mode==1:left+=value if pan<=128 else nearest(value*(255-pan),127)
                else:right+=value if pan>=128 else nearest(value*pan,128)
            expected.extend(struct.pack('<hh',max(-32768,min(32767,left)),max(-32768,min(32767,right))))
        assert output==expected,'linked ARM samples differ from independent oracle: '+profile
        return {'profile':profile,'frames':1024,'instructions':self.instructions,'division64Calls':self.div64,'cacheReads':self.reads,'cacheReadBytes':self.read_bytes,'outputSha256':hashlib.sha256(output).hexdigest(),'independentOracle':'PASS'}

def main():
    p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--baseline',type=Path);p.add_argument('--elf',type=Path);p.add_argument('--nm',default='arm-none-eabi-nm');a=p.parse_args()
    assert unicorn.__version__=='2.1.4','use the pinned audio-check environment'
    elf=a.elf or a.build/'multifw-release/pg-ultrags-multifw.elf'
    files=[elf,Path(__file__),ROOT/'sw/ultrags/ug_render.c',ROOT/'sw/ultrags/ug_render.h',ROOT/'tools/ultrags/requirements-audio-check.txt']
    if a.baseline:files.append(a.baseline)
    inputs={str(f.resolve()):digest(f) for f in files}
    cases=[]
    for profile in ['mod4','mod4-one-stereo','mod4-two-stereo','paused-mod-two-stereo','stereo-balance','twelve-lane','32-mono-48000','32-mono-44100','16-stereo-48000','mod4-28-fx']:
        row=Machine(elf,a.nm).run(profile)
        assert row['division64Calls']==0,'64-bit division in bounded audio kernel'
        if a.baseline and profile not in ('32-mono-48000','32-mono-44100','16-stereo-48000','mod4-28-fx'):
            old=Machine(a.baseline,a.nm).run(profile)
            assert old['outputSha256']==row['outputSha256'],'changed samples '+profile
            assert row['instructions']<old['instructions'],'no instruction improvement '+profile
            row['baseline']=old;row['instructionRatio']=old['instructions']/row['instructions']
        cases.append(row);print('PASS linked ARM audio',profile,row['instructions'],'instructions',flush=True)
    report={'status':'LINKED_AUDIO_INSTRUCTION_PASS / REAL_PENDING','unicorn':unicorn.__version__,'cpu':'Cortex-M0','inputs':inputs,'artifacts':{str(elf.resolve()):digest(elf)},'cases':cases,
            'limits':['No wall-clock/SRAM arbitration/IRQ deadline claim','PSRAM callback and ROM memory operations are functional models','SIO divider results modeled; actual linked arithmetic instructions executed','Full-song native comparison and REAL audio acceptance are separate']}
    out=a.build/'host/audio-render.json';out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,indent=2)+'\n')
if __name__=='__main__':main()
