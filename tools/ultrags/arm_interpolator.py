# SPDX-License-Identifier: GPL-2.0-or-later
"""Functional RP2040 interpolator for linked ARM verification."""
import struct
from unicorn import UC_HOOK_MEM_WRITE,UC_HOOK_MEM_READ
class Interpolator:
 def __init__(self,uc):
  self.uc=uc;self.regs=[[0]*16 for _ in range(2)];self.reads=0;self.writes=0
  uc.hook_add(UC_HOOK_MEM_WRITE,self.write,begin=0xd0000080,end=0xd00000ff)
  uc.hook_add(UC_HOOK_MEM_READ,self.read,begin=0xd0000080,end=0xd00000ff)
 def values(self,r):
  raw=[];result=[]
  for lane in range(2):
   c=r[11+lane];assert not c&(1<<21),'blend not implemented'
   acc=r[lane^bool(c&(1<<16))];lo=(c>>5)&31;hi=(c>>10)&31
   v=(acc>>(c&31))&(((1<<(hi+1))-1)^((1<<lo)-1))
   if c&(1<<15) and v&(1<<hi):v-=1<<(hi+1)
   raw.append(v&0xffffffff);result.append((r[2+lane]+(acc if c&(1<<18) else v))&0xffffffff)
  return raw,result+[(r[4]+sum(raw))&0xffffffff]
 def write(self,uc,access,address,size,value,arg):
  self.writes+=1;i=(address-0xd0000080)//64;k=(address%64)//4;r=self.regs[i]
  if k in (13,14):r[k-13]=(r[k-13]+value)&0xffffffff
  elif k==15:
   for lane in range(2):
    v=(value>>(lane*16))&65535
    if r[11+lane]&(1<<15) and v&32768:v-=65536
    r[2+lane]=v&0xffffffff
  else:r[k]=value&0xffffffff
 def read(self,uc,access,address,size,value,arg):
  self.reads+=1;i=(address-0xd0000080)//64;k=(address%64)//4;r=self.regs[i];raw,result=self.values(r)
  if 5<=k<=10:
   value=result[(k-5)%3]
   if k<8:r[:2]=[result[lane^bool(r[11+lane]&(1<<17))] for lane in range(2)]
  elif k in (13,14):value=raw[k-13]
  else:value=r[k]
  uc.mem_write(address,struct.pack('<I',value))
