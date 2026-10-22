#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Linked Cortex-M0 production storage/tracker/mixer: MOD8 with independent FX.
PSRAM and the timer are functional models; instruction counts are not REAL timing.
"""
import argparse,json,struct
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
spec=spec_from_file_location('audio_check',Path(__file__).with_name('audio-render-check.py'));audio=module_from_spec(spec);spec.loader.exec_module(audio)
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();a.build=a.build.resolve()
elf=a.build/'multifw-release/pg-ultrags-multifw.elf';results=[]
class Card(audio.Machine):
 Q=0x20150000;R=Q+256;LEN=Q+512;STATUS=Q+516;PTR=Q+520;PS=Q+1024;SETTINGS=Q+2048
 def __init__(self):
  super().__init__(elf,'arm-none-eabi-nm');self.uc.mem_map(0x40050000,0x10000);self.min_sp=self.STACK
  self.uc.hook_add(audio.UC_HOOK_MEM_READ,self.spin_read,begin=0xd0000100,end=0xd000017f)
  self.call('ug_config_init',[self.sym['ug_cfg'],self.SETTINGS,8,0,0,0,0])
  self.call('ug_storage_bind',[self.PS,0,123,0]);self.call('ug_storage_publish',[8<<20,0,0]);self.call('ug_storage_main_volume',[100])
 def spin_read(self,uc,access,address,size,value,arg):
  # Single core test: every uncontended RP2040 hardware spinlock read succeeds.
  uc.mem_write(address,struct.pack('<I',1))
 def code(self,uc,address,size,arg):
  self.min_sp=min(getattr(self,'min_sp',self.STACK),self.reg(audio.UC_ARM_REG_SP))
  if address==self.sym.get('ug_psram_read'):
   off,dst,n=[self.reg(r) for r in (audio.UC_ARM_REG_R1,audio.UC_ARM_REG_R2,audio.UC_ARM_REG_R3)]
   assert 0<n<=256 and off+n<=8<<20
   uc.mem_write(dst,bytes(uc.mem_read(self.DATA+off,n)));self.reads+=1;self.read_bytes+=n
   uc.reg_write(audio.UC_ARM_REG_R0,0);self.ret();return
  super().code(uc,address,size,arg)
 def command(self,op,q=b''):
  if q:self.uc.mem_write(self.Q,q)
  for _ in range(10000):
   if self.call('ug_storage_command',[op,self.Q,len(q),self.R,self.LEN,self.STATUS,0]):break
  else:raise AssertionError('command did not finish')
  status=self.uc.mem_read(self.STATUS,1)[0];assert not status,(op,status)
  return bytes(self.uc.mem_read(self.R,self.uc.mem_read(self.LEN,1)[0]))
 def asset(self,kind,data,channels=0):
  assert not self.call('ug_store_reserve',[self.sym['store'],kind,len(data),self.PTR])
  obj=struct.unpack('<I',self.uc.mem_read(self.PTR,4))[0];off=struct.unpack('<I',self.uc.mem_read(obj,4))[0];handle=struct.unpack('<H',self.uc.mem_read(obj+20,2))[0]
  self.uc.mem_write(self.DATA+off,data);self.uc.mem_write(obj+12,struct.pack('<I',len(data)))
  if channels:
   desc=struct.pack('<IBBBBIIII',48000,channels,16,2,0,0,len(data),0,0)
   self.command(20,struct.pack('<H',handle)+desc)
  self.command(19,struct.pack('<HB I',handle,0,0));return handle
 def render(self,n=128):
  before=self.instructions;self.call('ug_storage_render',[self.OUT,n]);self.worst=max(getattr(self,'worst',0),self.instructions-before)
  return struct.unpack('<'+'h'*(n*2),self.uc.mem_read(self.OUT,n*4))
for fx_channels in (1,2):
 for loop_bytes in (4,128):
  m=Card();data=bytearray(1084+2048+8*loop_bytes);data[950]=1;data[1080:1084]=b'8CHN'
  for c in range(8):
   struct.pack_into('>H',data,42+30*c,loop_bytes//2);data[45+30*c]=64;struct.pack_into('>H',data,48+30*c,loop_bytes//2)
   period=856-30*c;data[1084+c*4:1088+c*4]=bytes([period>>8,period&255,(c+1)<<4,0])
   data[3132+c*loop_bytes:3132+(c+1)*loop_bytes]=bytes([c+1])*loop_bytes
  h=m.asset(3,bytes(data));m.command(49,struct.pack('<HB',h,1))
  fx=[];left=right=0
  for i in range(4//fx_channels):
   value=100+i*fx_channels*100;pcm=struct.pack('<h',value) if fx_channels==1 else struct.pack('<hh',value,value+100)
   fh=m.asset(1,pcm*2,fx_channels);pan=(255 if i%2 else 0) if fx_channels==1 else 128
   response=m.command(54,struct.pack('<HHBBBB',fh,65535,100,64,pan,2));fx.append(struct.unpack_from('<H',response)[0])
   if fx_channels==2:left+=value;right+=value+100
   elif i%2:right+=value
   else:left+=value
  m.counting=True;output=bytearray()
  for _ in range(24):
   samples=m.render();assert samples==(9*256+left,9*256+right)*128
   output.extend(m.uc.mem_read(m.OUT,512))
  snap=m.command(80);assert struct.unpack_from('<H',snap,26)[0]==8 and struct.unpack_from('<H',snap,52)[0]==12
  m.command(50,b'\0\0\1');assert m.render()==(left,right)*128
  m.command(50,b'\0\0\2');assert m.render()==(9*256+left,9*256+right)*128
  for ident in fx:m.command(57,struct.pack('<HB',ident,1))
  assert m.render()==(9*256,9*256)*128
  for ident in fx:m.command(57,struct.pack('<HB',ident,2))
  m.command(50,b'\0\0\0');assert m.render()==(left,right)*128
  m.command(55,b'\0\0');assert m.render()==(0,0)*128
  assert m.STACK-m.min_sp<=2048
  results.append(dict(fx_channels=fx_channels,loop_bytes=loop_bytes,instructions=m.instructions,worst_render_instructions=m.worst,cache_reads=m.reads,observed_stack=m.STACK-m.min_sp,sha256=audio.hashlib.sha256(output).hexdigest()))
  print('PASS linked ARM MOD8 + FX',results[-1],flush=True)
inputs=[elf,Path(__file__),Path(__file__).with_name('audio-render-check.py'),*(audio.ROOT/'sw/ultrags').glob('*.c'),*(audio.ROOT/'sw/ultrags').glob('*.h'),*(audio.ROOT/'sw/ultrags').glob('*.inc')]
(a.build/'evidence').mkdir(exist_ok=True)
(a.build/'evidence/s8a-arm.json').write_text(json.dumps(dict(status='LINKED_ARM_MOD8_PASS / REAL_PENDING',inputs={str(f.resolve()):audio.digest(f) for f in inputs},results=results,limits=['Functional PSRAM/timer; physical render deadline and audio acceptance pending']),indent=2)+'\n')
