#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Linked ARM S3M + FX + external OPL2; functional buses, REAL_PENDING."""
import json,struct,importlib.util
from pathlib import Path
from arm_interpolator import Interpolator
spec=importlib.util.spec_from_file_location('s8a',Path(__file__).with_name('s8a-arm.py'));base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
audio=base.audio;b=base.a.build;out=b/'host/s3m';results=[]
spec=importlib.util.spec_from_file_location('gen_s3m',Path(__file__).with_name('gen-s3m.py'));gen=importlib.util.module_from_spec(spec);spec.loader.exec_module(gen)
class Card(base.Card):
 def __init__(self):
  super().__init__();self.interp=Interpolator(self.uc)
 def code(self,uc,address,size,arg):
  if address==self.sym.get('ug_psram_write'):
   off,src,n=[self.reg(r) for r in (audio.UC_ARM_REG_R1,audio.UC_ARM_REG_R2,audio.UC_ARM_REG_R3)]
   assert 0<n<=256 and off+n<=8<<20;uc.mem_write(self.DATA+off,bytes(uc.mem_read(src,n)))
   uc.reg_write(audio.UC_ARM_REG_R0,0);self.ret();return
  super().code(uc,address,size,arg)
 def write(self,reg,val):
  assert self.call('ug_opl_write',[0x388,reg,0]);assert self.call('ug_opl_write',[0x389,val,0])
 def note(self,ch):
  op=[0,1,2,8,9,10,16,17,18][ch]
  for reg,value in [(0x20+op,0x21),(0x23+op,0x21),(0x40+op,24),(0x43+op,12),(0x60+op,0xf3),(0x63+op,0xf3),(0x80+op,0x35),(0x83+op,0x35),(0xa0+ch,0x80+ch*7),(0xb0+ch,0x31)]:self.write(reg,value)
for name in ('MOU8','STU16'):
 m=Card();data=(out/'fixtures'/(name+'.S3M')).read_bytes();h=m.asset(5,data);m.command(49,struct.pack('<HB',h,0));m.counting=True;pcm=bytearray()
 for _ in range(24):m.render();pcm.extend(m.uc.mem_read(m.OUT,512))
 assert pcm==(out/(name+'.s16le')).read_bytes(),name+' ARM/C PCM mismatch'
 assert bytes(m.uc.mem_read(m.DATA,len(data)))==data and m.STACK-m.min_sp<=2048
 results.append(dict(profile=name,frames=3072,stack=m.STACK-m.min_sp,sha256=audio.hashlib.sha256(pcm).hexdigest()))
 print('PASS ARM source/readback/index/render',results[-1],flush=True)
vectors=(b/'host/adlib/vectors.s32le').read_bytes();fm=struct.unpack('<12800i',vectors[18*51200:19*51200])
for channels,stereo in ((4,False),(4,True),(32,False),(16,True)):
 m=Card();data=bytearray(gen.module(patterns=[{0:[(c,0x40,1,16,0,0) for c in range(channels)]}],channels=channels,stereo=stereo,pan=8))
 ih=struct.unpack_from('<H',data,98)[0]*16;off=(data[ih+13]<<20)|(struct.unpack_from('<H',data,ih+14)[0]<<4);data[off:]=bytes([132])*len(data[off:])
 h=m.asset(5,bytes(data));m.command(49,struct.pack('<HB',h,1));fx=[]
 lanes=channels*(2 if stereo else 1);shift=3 if lanes>16 else 2 if lanes>8 else 1 if lanes>4 else 0
 gain=256>>shift;left=channels*(gain if stereo else (gain*127+127)//255);right=channels*(gain if stereo else gain-(gain*127+127)//255)
 if lanes<32:
  fh=m.asset(1,struct.pack('<hh',100,200)*2,2)
  fx.append(m.command(54,struct.pack('<HHBBBB',fh,65535,100,64,128,2)))
 else:
  fh=m.asset(1,struct.pack('<h',100)*2,1);q=struct.pack('<HHBBBB',fh,65535,100,64,128,0);m.uc.mem_write(m.Q,q)
  assert m.call('ug_storage_command',[54,m.Q,len(q),m.R,m.LEN,m.STATUS,0]) and m.uc.mem_read(m.STATUS,1)[0]==12
 for ch in range(9):m.note(ch)
 m.counting=True;pcm=bytearray()
 for tick in range(8):
  actual=m.render();want=[]
  for v in fm[tick*128:(tick+1)*128]:want.extend((left+(100 if fx else 0)+v,right+(200 if fx else 0)+v))
  assert actual==tuple(want),(channels,stereo,tick,actual[:8],want[:8]);pcm.extend(m.uc.mem_read(m.OUT,512))
 snap=m.command(80);assert struct.unpack_from('<H',snap,26)[0]==channels and struct.unpack_from('<H',snap,52)[0]==lanes+2*len(fx)
 m.command(50,b'\0\0\1');assert any(m.render());m.command(50,b'\0\0\2');m.render();m.command(50,b'\0\0\0');assert any(m.render())
 assert bytes(m.uc.mem_read(m.DATA,len(data)))==data and m.STACK-m.min_sp<=2048
 results.append(dict(profile='S3M/FX/OPL2',channels=channels,stereo=stereo,voices=lanes,fx_voices=2*len(fx),frames=1024,stack=m.STACK-m.min_sp,sha256=audio.hashlib.sha256(pcm).hexdigest()))
 print('PASS ARM simultaneous S3M/FX/OPL2',results[-1],flush=True)
from budget_report import sections,sram_budget
memory=sram_budget(sections('arm-none-eabi',base.elf));assert memory['free_main']>=16384
inputs=[base.elf,Path(__file__),Path(__file__).with_name('arm_interpolator.py'),Path(__file__).with_name('s8a-arm.py'),Path(__file__).with_name('audio-render-check.py'),Path(__file__).with_name('gen-s3m.py'),b/'host/adlib/vectors.s32le',*(audio.ROOT/'sw/ultrags').glob('*.[ch]'),*(audio.ROOT/'sw/ultrags').glob('*.inc')]
inputs+=list((out/'fixtures').glob('*.S3M'))+[out/'MOU8.s16le',out/'STU16.s16le']
(out/'arm-evidence.json').write_text(json.dumps(dict(status='LINKED_ARM_PASS / REAL_PENDING',inputs={str(p.resolve()):audio.digest(p) for p in inputs},results=results,sram=memory,limits=['Functional PSRAM, divider and interpolator; no physical deadline/underrun claim']),indent=2)+'\n')
