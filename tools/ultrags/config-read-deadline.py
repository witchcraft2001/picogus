#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Linked ARM + generated PIO, separate WAIT latch and data sampling instants.

Declared instruction ticks, not measured bus/CPU cycles. The regression latch
is chosen between the two observed acquisition instants. In particular, IOR
can remain low after an unaccepted late WAIT; checking IOR alone is insufficient.
"""
import argparse,importlib.util,json,hashlib,subprocess
from pathlib import Path
R=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('config_arm',R/'tools/ultrags/config-read-arm.py');c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
class Read(c.ConfigRead):
 def __init__(self,elf,nm,header,port,latch,data_at,*,pad=0):
  super().__init__(elf,nm,header,port)
  words,labels,wrap=c.pio.program(header,'ug_handshake_ior');sm=c.pio.native(words,labels,wrap,0x2a0,0xffff);sm.port=port;sm.ior=0
  ticks=0
  while sm.pc!=labels['parked']:
   sm.step();ticks+=1;assert ticks<96
  self.now=ticks+8+pad # fixed peer/FIFO dispatch latency, identical in both cases
  self.prelude=ticks;self.pad=pad;self.latch=latch;self.data_at=data_at;self.accepted=None;self.late_drive=False
 def tick(self):
  self.now+=1;before_dirs=self.sm.dirs;before_ior=self.sm.ior;self.sm.step()
  if before_ior and not before_dirs and self.sm.dirs:self.late_drive=True
  if self.sm.hold and self.first_hold is None:self.first_hold=self.now
  if self.now>=self.latch and self.accepted is None:self.accepted=bool(self.sm.hold)
  if self.sample is None and self.now>=self.data_at and (not self.accepted or not self.sm.hold):
   self.sample=self.sm.value if self.sm.dirs==255 and self.sm.ads else 255;self.sm.ior=1
 def mmio_write(self,uc,access,address,size,value,opaque):
  before=self.sm.dirs
  super().mmio_write(uc,access,address,size,value,opaque)
  if self.sm.ior and not before and self.sm.dirs:self.late_drive=True
 def run_timed(self,port,work,*,query,forced_end=False):
  service=self.call('ug_handshake_capture',[1,port,0]);self.advance(work)
  if forced_end:self.sm.ior=1;self.sample=255
  active=service and (self.call('ug_handshake_read_active',[]) if query else True)
  if active:
   self.call('ug_handshake_put',[1,0xffffffff]);self.call('ug_handshake_put',[1,0xff24])
  else:self.call('ug_handshake_put',[1,0])
  self.advance(256)
  assert self.sample is not None and not self.sm.dirs and not self.sm.hold and not self.sm.ads
  return dict(sample=self.sample,consumed=int(bool(active)),first_wait=self.first_hold,wait_accepted=self.accepted,prelude=self.prelude,injected_pad=self.pad,late_drive=self.late_drive,forced_end=forced_end)
def main():
 p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--baseline',type=Path);p.add_argument('--nm',default='arm-none-eabi-nm');a=p.parse_args();b=a.build.resolve()
 elf=b/'multifw-release/pg-ultrags-multifw.elf';header=b/'multifw-release/ug_handshake_ior.pio.h'
 baseline=a.baseline or elf;bh=a.baseline.with_name('ug_handshake_ior.pio.h') if a.baseline else header;pad=0 if a.baseline else 17
 reference_files=[]
 if a.baseline:
  ref=R/'tests/ultrags/reference/handshake-r4.pio';refh=b/'host/r4-reference.pio.h';refh.parent.mkdir(exist_ok=True)
  subprocess.run([str(b/'multifw-release/pioasm-install/pioasm/pioasm'),'-o','c-sdk','-v','0',str(ref),str(refh)],check=True)
  assert c.pio.program(refh,'ug_handshake_ior')[0]==c.pio.program(bh,'ug_handshake_ior')[0],'baseline is not frozen R4 PIO'
  reference_files=[ref,refh]
 rows=[]
 for port in (0x1d0,0x1d1,0x1d2):
  early=Read(elf,a.nm,header,port,10**9,10**9);early.call('ug_handshake_capture',[1,port,0])
  late=Read(baseline,a.nm,bh,port,10**9,10**9,pad=pad);late.call('ug_handshake_capture',[1,port,0])
  assert early.first_hold<late.first_hold,(early.first_hold,late.first_hold)
  latch=(early.first_hold+late.first_hold)//2;data_at=late.first_hold+40
  for work in (128,512,4096):
   old=Read(baseline,a.nm,bh,port,latch,data_at,pad=pad).run_timed(port,work,query=False)
   new=Read(elf,a.nm,header,port,latch,data_at).run_timed(port,work,query=True)
   assert old['sample']==255 and old['wait_accepted'] is False and old['consumed']==1,old
   assert new['sample']==36 and new['wait_accepted'] is True and new['consumed']==1 and not new['late_drive'],new
   rows.append(dict(port=port,work=work,wait_latch=latch,data_sample=data_at,baseline=old,candidate=new))
  expired=Read(elf,a.nm,header,port,latch,data_at).run_timed(port,0,query=True,forced_end=True)
  assert expired['sample']==255 and not expired['consumed'] and not expired['late_drive'],expired
  rows.append(dict(port=port,forced_end=expired))
 files=[elf,header,Path(__file__),R/'tools/ultrags/config-read-arm.py',R/'tools/ultrags/pio-isa-check.py',R/'tools/ultrags/audio-render-check.py',R/'sw/picogus.cpp',R/'sw/ultrags/ug_handshake.c',R/'sw/ultrags/ug_handshake.h']
 if a.baseline:files.extend([a.baseline,bh,*reference_files])
 report=dict(status='LINKED_CONFIG_WAIT_LATCH_PASS / REAL_PENDING',cases=rows,baseline_kind='linked R4' if a.baseline else 'delayed acquisition control on current ARM',limits=['WAIT latch chosen between observed instruction instants, not a measured Sprinter deadline','fixed8-tick peer/FIFO latency, not actual full polling code','production consuming-handler query is tested separately in production-C fixture'],inputs={str(f.resolve()):hashlib.sha256(f.read_bytes()).hexdigest() for f in files})
 (b/'host').mkdir(exist_ok=True);(b/'host/config-read-deadline.json').write_text(json.dumps(report,indent=2)+'\n')
 print('Linked ARM/PIO:9 independent WAIT-latch/data-sample cases and3 ended-cycle suppression cases PASS / REAL_PENDING')
if __name__=='__main__':main()
