#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute linked OPL ASM with functional RP2040 interpolator and divider."""
import argparse,json,struct,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('audio',Path(__file__).with_name('audio-render-check.py'));audio=importlib.util.module_from_spec(spec);spec.loader.exec_module(audio)
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();a.build=a.build.resolve()
elf=a.build/'multifw-release/pg-ultrags-multifw.elf'
from arm_interpolator import Interpolator
class Machine(audio.Machine):
 def __init__(self):
  super().__init__(elf,'arm-none-eabi-nm');self.interp=Interpolator(self.uc);self.min_sp=self.STACK
  self.uc.hook_add(audio.UC_HOOK_MEM_READ,self.spin,begin=0xd0000100,end=0xd000017f)
 def spin(self,uc,access,address,size,value,arg):uc.mem_write(address,struct.pack('<I',1))
 def code(self,uc,address,size,arg):
  self.min_sp=min(getattr(self,'min_sp',self.STACK),self.reg(audio.UC_ARM_REG_SP));super().code(uc,address,size,arg)
 def write(self,reg,value):
  assert self.call('ug_opl_write',[0x388,reg,0]);assert self.call('ug_opl_write',[0x389,value,0])
 def note(self,ch):
  op=[0,1,2,8,9,10,16,17,18][ch]
  for reg,value in [(0x20+op,0x21),(0x23+op,0x21),(0x40+op,24),(0x43+op,12),(0x60+op,0xf3),(0x63+op,0xf3),(0x80+op,0x35),(0x83+op,0x35),(0xa0+ch,0x80+ch*7),(0xb0+ch,0x31)]:self.write(reg,value)
(a.build/'host/adlib/arm-evidence.json').unlink(missing_ok=True)
vectors=(a.build/'host/adlib/vectors.s32le').read_bytes();results=[]
for profile in range(19):
 m=Machine()
 for ch in range(9 if profile>=9 else 1):m.note(ch if profile>=9 else profile)
 if profile==9:m.write(0xbd,0x3f)
 if 10<=profile<18:
  m.write(1,0x20)
  if profile>=14:m.write(0xbd,0xc0)
  for ch in range(9):
   op=[0,1,2,8,9,10,16,17,18][ch]
   for reg,value in [(0x20+op,0xe1),(0x23+op,0xe1),(0xe0+op,(profile-10)%4),(0xe3+op,(profile-9)%4),(0xc0+ch,0x0f if profile&1 else 0x0e)]:m.write(reg,value)
 output=bytearray();m.counting=True
 for block in range(8):
  ptr=m.call('ug_opl_render',[128]);output.extend(m.uc.mem_read(ptr,512))
 expected=vectors[profile*51200:profile*51200+len(output)]
 if output!=expected:
  actual=struct.unpack('<'+'i'*(len(output)//4),output);want=struct.unpack('<'+'i'*(len(output)//4),expected)
  mismatch=next((i,x,y) for i,(x,y) in enumerate(zip(actual,want)) if x!=y)
  raise AssertionError((profile,mismatch))
 assert m.interp.reads and m.STACK-m.min_sp<2048
 row=dict(profile=profile,frames=1024,instructions=m.instructions,interp_reads=m.interp.reads,stack=m.STACK-m.min_sp,sha256=audio.hashlib.sha256(output).hexdigest());results.append(row);print('PASS ARM OPL',row,flush=True)
m=Machine()
for ch in range(9):m.note(ch)
for _ in range(8):m.call('ug_opl_render',[128])
for op in range(32):m.write(0x80+op,0xff)
for ch in range(9):m.write(0xb0+ch,0)
assert m.call('ug_opl_busy',[])
tail=bytearray()
for _ in range(8):tail.extend(m.uc.mem_read(m.call('ug_opl_render',[128]),512))
assert tail==(a.build/'host/adlib/release.s32le').read_bytes()
assert not m.call('ug_opl_busy',[])
release=dict(frames=1024,idle=True,sha256=audio.hashlib.sha256(tail).hexdigest())
print('PASS linked ARM exact release to idle',release,flush=True)
# Full production tracker/storage/audio path, compared to the independent C
# FM vector plus literal constant PCM sums. These are instruction counts only.
spec=importlib.util.spec_from_file_location('s8a',Path(__file__).with_name('s8a-arm.py'));base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
class Card(base.Card):
 def __init__(self):
  super().__init__();self.interp=Interpolator(self.uc)
 write=Machine.write
 note=Machine.note
mixed=[]
for channels in (8,32):
 for fx_channels in ((1,2) if channels==8 else (1,)):
  for rhythm in (False,True):
   m=Card();size=128;start=1084+256*channels;data=bytearray(start+size);data[950]=1;data[1080:1084]=b'8CHN' if channels==8 else b'32CH'
   struct.pack_into('>H',data,42,size//2);data[45]=16;struct.pack_into('>H',data,48,size//2);data[start:]=bytes([4])*size
   for ch in range(channels):data[1084+ch*4:1088+ch*4]=bytes([3,88,16,0])
   h=m.asset(3,bytes(data));m.command(49,struct.pack('<HB',h,1));fx=[];left=right=0
   if channels==8:
    for i in range(4//fx_channels):
     value=100+i*100;pcm=struct.pack('<h',value) if fx_channels==1 else struct.pack('<hh',value,value+100)
     fh=m.asset(1,pcm*2,fx_channels);pan=(255 if i%2 else 0) if fx_channels==1 else 128
     fx.append(struct.unpack_from('<H',m.command(54,struct.pack('<HHBBBB',fh,65535,100,64,pan,2)))[0])
     if fx_channels==2:left+=value;right+=value+100
     elif i%2:right+=value
     else:left+=value
   for ch in range(9):m.note(ch)
   if rhythm:m.write(0xbd,0x3f)
   expected=struct.unpack('<12800i',vectors[(9 if rhythm else 18)*51200:(10 if rhythm else 19)*51200]);offset=0;m.counting=True
   def check(pcm_left,pcm_right):
    global offset
    actual=m.render();want=[]
    for v in expected[offset:offset+128]:want.extend((max(-32768,min(32767,pcm_left+v)),max(-32768,min(32767,pcm_right+v))))
    assert actual==tuple(want),(channels,fx_channels,rhythm,offset)
    offset+=128
    assert m.call('ug_storage_audio_active',[]) and m.call('ug_storage_playback_busy',[])
   music=(channels//2)*4*(64>>(1 if channels==8 else 3))
   for _ in range(24):check(music+left,music+right)
   snap=m.command(80);assert struct.unpack_from('<H',snap,52)[0]==min(32,channels+4)
   m.command(50,b'\0\0\1');check(left,right)  # MOD PAUSE does not pause FM
   m.command(50,b'\0\0\2');check(music+left,music+right)
   m.command(55,b'\0\0');check(music,music)  # FX STOP does not stop FM
   m.command(50,b'\0\0\0');check(0,0)
   m.call('ug_storage_gs_reset',[1,0]);check(0,0)
   for ch in range(9):m.write(0xb0+ch,0)
   m.write(0xbd,0x20);assert m.call('ug_storage_playback_busy',[])
   m.render();assert m.call('ug_storage_audio_active',[])  # release tail
   assert m.STACK-m.min_sp<=2048
   row=dict(mod_channels=channels,fx_channels=fx_channels,fx_instances=len(fx),rhythm=rhythm,exact_frames=offset,worst_quantum_instructions=m.worst,observed_stack=m.STACK-m.min_sp)
   mixed.append(row);print('PASS linked ARM full MOD/FX/OPL mix',row,flush=True)
inputs=[Path(__file__).with_name('arm_interpolator.py'),elf,Path(__file__),Path(__file__).with_name('audio-render-check.py'),a.build/'host/adlib/vectors.s32le',a.build/'host/adlib/release.s32le',Path(__file__).with_name('s8a-arm.py'),*(audio.ROOT/'sw/ultrags').glob('*.c'),*(audio.ROOT/'sw/ultrags').glob('*.h'),*(audio.ROOT/'sw/ultrags').glob('*.inc'),*(audio.ROOT/'sw/opl').glob('*.*'),audio.ROOT/'sw/ultrags/ug_opl.c']
(a.build/'host/adlib/arm-evidence.json').write_text(json.dumps(dict(status='LINKED_ARM_PASS / REAL_PENDING',inputs={str(f.resolve()):audio.digest(f) for f in inputs if f.is_file()},results=results,mixed=mixed,release=release,limits=['Functional interpolator/divider; no physical timing or listening claim']),indent=2)+'\n')
