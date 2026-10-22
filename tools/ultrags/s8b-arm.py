#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Linked FLT8 parser/tracker/mixer and independent FX; exact sample oracle.
The imported S8a harness also repeats the four MOD8 regression profiles.
"""
import argparse,json,struct,os
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
spec=spec_from_file_location('s8a',Path(__file__).with_name('s8a-arm.py'));base=module_from_spec(spec);spec.loader.exec_module(base)
audio=base.audio;b=base.a.build;results=[]
for fx_channels in (1,2):
 for loop_bytes in (4,128):
  m=base.Card();data=bytearray(1084+6144+8*loop_bytes);data[950]=6;data[952:958]=bytes(range(6));data[1080:1084]=b'FLT8'
  for c in range(8):
   struct.pack_into('>H',data,42+30*c,loop_bytes//2);data[45+30*c]=64;struct.pack_into('>H',data,48+30*c,loop_bytes//2)
   data[7228+c*loop_bytes:7228+(c+1)*loop_bytes]=bytes([c+1])*loop_bytes
  for pair in range(3):
   for row in (0,63):
    for c in range(8):
     # Physical four-channel blocks, not interleaved 8CHN.
     off=1084+(pair*2+c//4)*1024+row*16+(c%4)*4
     period=856-30*c;sample=(c+pair)%8+1
     data[off:off+4]=bytes([period>>8,period&255,sample<<4,0])
  original=bytes(data);h=m.asset(3,original);m.command(49,struct.pack('<HB',h,1))
  fx=[];left=right=0
  for n in range(4//fx_channels):
   value=100+n*fx_channels*100;pcm=struct.pack('<h',value) if fx_channels==1 else struct.pack('<hh',value,value+100)
   fh=m.asset(1,pcm*2,fx_channels);pan=(255 if n%2 else 0) if fx_channels==1 else 128
   response=m.command(54,struct.pack('<HHBBBB',fh,65535,100,64,pan,2));fx.append(struct.unpack_from('<H',response)[0])
   if fx_channels==2:left+=value;right+=value+100
   elif n%2:right+=value
   else:left+=value
  m.counting=True;output=bytearray()
  # Literal sums follow fixed pans 0,255,255,0,0,255,255,0.
  sums=[(18,18),(14,22),(18,18)]
  for order in range(6):
   for row in (0,63):
    m.command(51,struct.pack('<HHB',0,order,row));ml,mr=sums[order//2]
    for _ in range(3):
     samples=m.render();assert samples==(ml*128+left,mr*128+right)*128
     output.extend(m.uc.mem_read(m.OUT,512))
  m.command(50,b'\0\0\1');assert m.render()==(left,right)*128
  m.command(50,b'\0\0\2');assert m.render()==(9*256+left,9*256+right)*128
  for ident in fx:m.command(57,struct.pack('<HB',ident,1))
  assert m.render()==(9*256,9*256)*128
  for ident in fx:m.command(57,struct.pack('<HB',ident,2))
  m.command(50,b'\0\0\0');assert m.render()==(left,right)*128
  m.command(55,b'\0\0');assert m.render()==(0,0)*128
  # First store reservation is at byte zero; no normalization writes are allowed.
  assert bytes(m.uc.mem_read(m.DATA,len(original)))==original
  assert m.STACK-m.min_sp<=2048
  results.append(dict(fx_channels=fx_channels,loop_bytes=loop_bytes,orders=6,rows=[0,63],exact_frames=4608,instructions=m.instructions,observed_stack=m.STACK-m.min_sp,sha256=audio.hashlib.sha256(output).hexdigest()))
  print('PASS linked ARM FLT8 + independent FX',results[-1],flush=True)
# Additional interleaved layouts, including full shared-pool occupancy.
extended=[]
for tag,channels in [('FLT4',4),('28CH',28),('31CH',31),('32CH',32)]:
 for fx_channels in (1,2):
  for loop_bytes in (4,128):
   m=base.Card();sample_offset=1084+512*channels;data=bytearray(sample_offset+31*loop_bytes)
   data[950]=2;data[953]=1;data[1080:1084]=tag.encode()
   for c in range(31):
    struct.pack_into('>H',data,42+c*30,loop_bytes//2);data[45+c*30]=16;struct.pack_into('>H',data,48+c*30,loop_bytes//2)
    data[sample_offset+c*loop_bytes:sample_offset+(c+1)*loop_bytes]=bytes([c%7+1])*loop_bytes
   for pattern in range(2):
    for row in (0,63):
     for c in range(channels):
      sample=(c+pattern)%31+1;period=856-12*c-4*pattern-(row==63)
      off=1084+4*((pattern*64+row)*channels+c)
      data[off:off+4]=bytes([(sample&240)|(period>>8),period&255,(sample&15)<<4,0])
   original=bytes(data);h=m.asset(3,original);m.command(49,struct.pack('<HB',h,1));fx=[];left=right=0
   for n in range(min(4,32-channels)//fx_channels):
    pcm=struct.pack('<h',100) if fx_channels==1 else struct.pack('<hh',100,200)
    fh=m.asset(1,pcm*2,fx_channels);pan=0 if fx_channels==1 else 128
    fx.append(m.command(54,struct.pack('<HHBBBB',fh,65535,100,64,pan,2)))
    left+=100
    if fx_channels==2:right+=200
   m.counting=True;output=bytearray();expected=[]
   for pattern in range(2):
    # Independent sum from natural panning and per-instrument constant PCM.
    shift=3 if channels>16 else 2 if channels>8 else 1 if channels>4 else 0
    ml=sum(((c+pattern)%31%7+1)*(64>>shift) for c in range(channels) if c%4 in (0,3))
    mr=sum(((c+pattern)%31%7+1)*(64>>shift) for c in range(channels) if c%4 in (1,2))
    expected.append((ml,mr))
    for row in (0,63):
     m.command(51,struct.pack('<HHB',0,pattern,row))
     for _ in range(3):
      assert m.render()==(ml+left,mr+right)*128;output.extend(m.uc.mem_read(m.OUT,512))
   snap=m.command(80);assert struct.unpack_from('<H',snap,26)[0]==channels and struct.unpack_from('<H',snap,52)[0]==channels+len(fx)*fx_channels
   m.command(50,b'\0\0\1');assert m.render()==(left,right)*128
   m.command(50,b'\0\0\2');assert m.render()==(expected[-1][0]+left,expected[-1][1]+right)*128
   m.command(50,b'\0\0\0');assert m.render()==(left,right)*128
   m.command(55,b'\0\0');assert m.render()==(0,0)*128
   assert bytes(m.uc.mem_read(m.DATA,len(original)))==original and m.STACK-m.min_sp<=2048
   extended.append(dict(signature=tag,channels=channels,fx_channels=fx_channels,fx_voices=len(fx)*fx_channels,loop_bytes=loop_bytes,exact_frames=1536,observed_stack=m.STACK-m.min_sp,sha256=audio.hashlib.sha256(output).hexdigest()))
   print('PASS linked ARM interleaved MOD + independent FX',extended[-1],flush=True)
real=None
if os.environ.get('UG_MULTIMOD'):
 path=Path(os.environ['UG_MULTIMOD']).resolve();data=path.read_bytes();assert data[1080:1084]==b'28CH'
 m=base.Card();h=m.asset(3,data);m.command(49,struct.pack('<HB',h,0));m.counting=True;out=bytearray()
 for _ in range(24):m.render();out.extend(m.uc.mem_read(m.OUT,512))
 reference=b/'host/s8b/dope-prefix.s16le';assert bytes(out)==reference.read_bytes(),'ARM/C DOPE PCM prefix mismatch'
 assert any(out);snap=m.command(80);assert struct.unpack_from('<H',snap,26)[0]==28
 assert bytes(m.uc.mem_read(m.DATA,len(data)))==data and m.STACK-m.min_sp<=2048
 real=dict(path=str(path),sha256=audio.digest(path),render_frames=3072,audio_sha256=audio.hashlib.sha256(out).hexdigest(),observed_stack=m.STACK-m.min_sp)
 print('PASS linked ARM original DOPE.MOD',real,flush=True)
inputs=[base.elf,b/'multifw-release/picogus.uf2',Path(__file__),Path(__file__).with_name('s8a-arm.py'),Path(__file__).with_name('audio-render-check.py'),*(audio.ROOT/'sw/ultrags').glob('*.c'),*(audio.ROOT/'sw/ultrags').glob('*.h'),*(audio.ROOT/'sw/ultrags').glob('*.inc')]
if real:inputs.extend([Path(real['path']),reference])
(b/'evidence/s8b-arm.json').write_text(json.dumps(dict(status='LINKED_ARM_FLT8_PASS / REAL_PENDING',inputs={str(f.resolve()):audio.digest(f) for f in inputs},results=results,extended=extended,real=real,limits=['Functional PSRAM/timer; no physical timing claim']),indent=2)+'\n')
