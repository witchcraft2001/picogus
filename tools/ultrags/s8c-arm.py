#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute linked RP2040 streaming resampler and shared FX mixer in Unicorn."""
import argparse,json,struct
from pathlib import Path
from importlib.util import spec_from_file_location,module_from_spec
spec=spec_from_file_location('audio_check',Path(__file__).with_name('audio-render-check.py'));audio=module_from_spec(spec);spec.loader.exec_module(audio)
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();a.build=a.build.resolve()
elf=a.build/'multifw-release/pg-ultrags-multifw.elf';results=[]
profiles=[(44100,2,2),(22050,1,2),(22050,2,0),(48000,1,2),(12345,1,1),(47999,2,0)]
for rate,source_channels,fmt in profiles:
 for channels in (1,2):
  m=audio.Machine(elf,'arm-none-eabi-nm');S=0x20150000;PCM=0x20170000;IDS=0x20171000
  fb=source_channels*(2 if fmt==2 else 1)
  capacity=28 if rate!=44100 else 12288;total=1031 if rate!=44100 else capacity//4*4+17
  values=[];data=bytearray()
  for i in range(total):
   frame=[]
   for ch in range(source_channels):
    if fmt==2:
     v=(i*73)%30000-15000 if not ch else 15000-(i*31)%30000
     data.extend(struct.pack('<h',v))
    else:
     b=(i*73+ch*111)&255;data.append(b);v=(b-128 if fmt==0 else b if b<128 else b-256)*256
    frame.append(v)
   values.append(frame if source_channels==2 else frame*2)
  data=bytes(data)
  assert m.call('ug_stream_init',[S,0,capacity,(capacity//2)//fb*fb,(capacity//4)//fb*fb,rate,source_channels,16 if fmt==2 else 8,fmt])==0
  # Explicit ABI guard for the core1-only structure, before reading its counters.
  assert struct.unpack('<4I',m.uc.mem_read(S+24,16))==(capacity,(capacity//2)//fb*fb,(capacity//4)//fb*fb,0)
  assert struct.unpack('<I',m.uc.mem_read(S+56,4))[0]==1
  m.call('ug_mixer_init',[m.MIX,m.READ|1,0,m.DATA,8<<20])
  for ch in range(source_channels):
   assert not m.call('ug_lane_set',[m.MIX,ch,0,capacity//4,0,capacity//4,0,0,64,0 if source_channels==1 else 128,1,0 if source_channels==1 else ch+1,0,ch])
  # The external pair owns voices0/1. Every additional sample uses normal lanes.
  left=right=0
  for i in range(4//channels):
   value=(i+1)*100;off=0x100000+i*4
   m.uc.mem_write(m.DATA+off,struct.pack('<hh',value,value+100))
   for ch in range(channels):
    voice=2+i*channels+ch;mode=0 if channels==1 else ch+1;pan=(255 if i%2 else 0) if channels==1 else 128
    assert not m.call('ug_lane_set',[m.MIX,voice,off,1,0,1,0,1,64,pan,1,mode,1,ch])
   if channels==1:
    if i%2:right+=value
    else:left+=value
   else:left+=value;right+=value+100
  supplied=played=0;worst=0;output=bytearray();m.uc.mem_write(IDS,struct.pack('<HH',0,1 if source_channels==2 else 65535))
  m.counting=True
  while played<(total*48000+rate-1)//rate:
   free=m.call('ug_stream_free',[S]);n=min(free,1024,len(data)-supplied)
   n=n//fb*fb
   if n:
    write=struct.unpack('<I',m.uc.mem_read(S+44,4))[0]
    first=min(n,capacity-write);m.uc.mem_write(m.DATA+write,data[supplied:supplied+first])
    if first<n:m.uc.mem_write(m.DATA,data[supplied+first:supplied+n])
    m.call('ug_stream_publish',[S,n]);supplied+=n
   if supplied==len(data):m.uc.mem_write(S+338,b'\1')
   # Small packets plus rendering force buffer stalls and multiple ring laps.
   prior=m.instructions
   position,fraction=struct.unpack('<Q',m.uc.mem_read(S+16,8))[0],struct.unpack('<I',m.uc.mem_read(S+48,4))[0]
   m.call('ug_stream_render',[S,m.READ|1,0,m.DATA,8<<20,PCM,128])
   m.call('ug_mixer_render_stream',[m.MIX,m.OUT,128,PCM,IDS]);worst=max(worst,m.instructions-prior)
   samples=struct.unpack('<256h',m.uc.mem_read(PCM,512));mixed=struct.unpack('<256h',m.uc.mem_read(m.OUT,512))
   advanced_position=struct.unpack('<Q',m.uc.mem_read(S+16,8))[0]
   # Reconstruct the exact number of produced frames from rational phase;
   # zero-valued source samples (notably S8 center) are real audio too.
   after_fraction=struct.unpack('<I',m.uc.mem_read(S+48,4))[0]
   total_played=(((advanced_position<<32)+after_fraction)*48000+(rate<<32)-1)//(rate<<32)
   produced=total_played-played
   assert 0<=produced<=128
   for f in range(128):
    clamp=lambda v:max(-32768,min(32767,v))
    assert mixed[2*f]==clamp(samples[2*f]+left) and mixed[2*f+1]==clamp((samples[2*f+1] if source_channels==2 else 0)+right)
    if f<produced:
     pos=played*rate//48000;frac=((played*rate%48000)<<32)//48000
     for ch in range(2):
      x=values[pos][ch];y=values[min(pos+1,total-1)][ch]
      v=x*(1<<32)+(y-x)*frac;expected=(-1 if v<0 else 1)*((abs(v)+(1<<31))>>32)
      assert samples[2*f+ch]==expected,(played,ch,samples[2*f+ch],expected)
     played+=1
    else:assert not samples[2*f] and not samples[2*f+1]
   assert advanced_position<=total
   output.extend(m.uc.mem_read(m.OUT,512))
  assert m.div64==0,'64-bit division in linked streaming hot path'
  results.append(dict(rate=rate,source_channels=source_channels,format=fmt,fx_channels=channels,fx_instances=4//channels,source_bytes=len(data),output_frames=played,worst_quantum_instructions=worst,instructions=m.instructions,cache_reads=m.reads,division64_calls=m.div64,output_sha256=audio.hashlib.sha256(output).hexdigest()))
  print('PASS linked ARM streaming + FX',channels,results[-1],flush=True)
inputs=[elf,Path(__file__),Path(__file__).with_name('audio-render-check.py')]
inputs.extend((audio.ROOT/'sw/ultrags').glob('ug_stream.*'));inputs.extend((audio.ROOT/'sw/ultrags').glob('ug_render.*'))
(a.build/'evidence').mkdir(exist_ok=True)
(a.build/'evidence/stream-arm.json').write_text(json.dumps(dict(status='LINKED_ARM_STREAM_PASS / REAL_PENDING',inputs={str(f.resolve()):audio.digest(f) for f in inputs},results=results,limits=['Functional PSRAM model; instruction counts do not certify physical render deadline']),indent=2)+'\n')
