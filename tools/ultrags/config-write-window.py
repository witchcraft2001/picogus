#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Finite write-data window regression, generated PIO -> production CONFIG C.

A declared model window, not a measurement of Sprinter strobes or GPIO timing.
R3 and the candidate use identical absolute ADS setup time; classifier clocks
are 183/366MHz respectively. No byte is replayed or repaired by the ARM peer.
"""
import argparse,importlib.util,json,subprocess,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--fixture',type=Path,required=True);a=p.parse_args()
r=Path(__file__).resolve().parents[2];out=a.out.resolve();out.mkdir(parents=True,exist_ok=True)
spec=importlib.util.spec_from_file_location('pio',r/'tools/ultrags/pio-isa-check.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
ref=r/'tests/ultrags/reference/handshake-r3.pio';refh=out/'r3.pio.h'
subprocess.run([str(a.build.resolve()/'pioasm-install/pioasm/pioasm'),'-o','c-sdk','-v','0',str(ref),str(refh)],check=True)
old,ol,ow=m.program(refh,'ug_handshake_ior');new,nl,nw=m.program(a.build/'ug_handshake_ior.pio.h','ug_handshake_ior')
def capture(words,labels,wrap,port,data,period,phase,deadline):
 sm=m.native(words,labels,wrap,0x2a0,0xffff,gs=True,write=True);sm.port=port;sm.data=data;sm.dack=0;sm.mux_delay=16 if sm.fast else 8;sm.step();sm.iow=0
 first_hold=None
 for t in range(192):
  if t>=deadline and not sm.hold:sm.iow=1;sm.data=255
  if (t+phase)%period==0:sm.step()
  if sm.hold and first_hold is None:first_hold=t
  if len(sm.rx)==2:return m.data_byte(sm,sm.rx[1]),first_hold
 raise AssertionError('PIO did not capture')
rows=[];wrong=0
for port in (0x1d0,0x1d1,0x1d2):
 for byte in range(256):
  for window in (32,34):
   for phase in (0,1):
    b,_=capture(old,ol,ow,port,byte,2,phase,window)
    n,_=capture(new,nl,nw,port,byte,1,0,window)
    assert b==255 and n==byte,(port,byte,window,phase,b,n)
    wrong+=b!=byte;rows.append([port,byte,window,phase,b,n])
# Faster classification must preserve early waits at native/GS addresses.
for port in (0x2a0,0x2a3,0xb3,0xbb):
 byte,hold=capture(new,nl,nw,port,0xcc,1,0,32)
 previous,previous_hold=capture(old,ol,ow,port,0xcc,2,0,32)
 assert byte==0xcc and hold is not None and hold<32,(port,byte,hold)
 assert hold<previous_hold,(port,hold,previous_hold)
# Execute the captured CONFIG sequence through the unmodified production
# handlers extracted by config-exchange.py and its real linked ug_config.c.
f=a.fixture.resolve()
deps=json.loads((f/'config-exchange-inputs.json').read_text())
for name,expected in deps.items():
 path=Path(name) if Path(name).is_absolute() else r/name
 assert hashlib.sha256(path.read_bytes()).hexdigest()==expected,'stale production fixture: '+name
source=out/'captured-config.c';source.write_text('''#define main config_exchange_reference_main
#include "'''+str(f/'config-exchange.c')+'''"
#undef main
int main(int argc,char **argv){
 assert(argc==3);config_exchange_reference_main(2,argv);
 control_active=false;sel_reg=0;
 FILE *stream=fopen(argv[2],"r");assert(stream);unsigned p,v;
 while(fscanf(stream,"%x %x",&p,&v)==2)bus_write(p,v);
 fclose(stream);if(!control_active||sel_reg!=CMD_PROTOCOL)return 100;
 assert(bus_read(CONTROL_PORT)==CMD_PROTOCOL);
 assert(bus_read(DATA_PORT_HIGH)==PICOGUS_PROTOCOL_VER);
 return 0;
}
''')
flags=['-std=c11','-DSOUND_ULTRAGS=1','-DUG_ISA_EARLY_READ=1','-DUG_BUNDLE=1','-fsanitize=undefined','-fno-sanitize-recover=all','-I'+str(r/'common'),'-I'+str(r/'sw'),'-I'+str(r/'tests/ultrags/unit/s2_mock'),'-I'+str(f/'gen')]
obj=out/'captured-config.o';exe=out/'captured-config'
subprocess.run(['cc',*flags,'-c',str(source),'-o',str(obj)],check=True)
subprocess.run(['c++','-fsanitize=undefined',str(obj),*[str(f/f'config-exchange-{i}.o') for i in range(1,6)],'-o',str(exe)],check=True)
for name,words,labels,wrap,period,expected in [('r3',old,ol,ow,2,100),('candidate',new,nl,nw,1,0)]:
 seq=out/(name+'-writes.txt');seq.write_text(''.join(f'1d0 {capture(words,labels,wrap,0x1d0,b,period,0,32)[0]:02x}\n' for b in (0xcc,1)))
 run=subprocess.run([str(exe),str(a.build.resolve()/'generated/multifw/catalog.bin'),str(seq)],capture_output=True)
 assert run.returncode==expected,(name,run.returncode,run.stderr.decode())
(out/'write-window.json').write_text(json.dumps(dict(status='GENERATED_PIO_TO_PRODUCTION_C_PASS / REAL_PENDING',cases=len(rows),r3_wrong_bytes=wrong,baselineRejected=True,candidateUnlocked=True,absolute_clock_units_MHz=366,windows=[32,34],limitations='Declared finite write window; not a measurement of Sprinter bus or GPIO setup.',inputs={**{str(Path(n) if Path(n).is_absolute() else r/n):h for n,h in deps.items()},**{str(x):hashlib.sha256(x.read_bytes()).hexdigest() for x in (ref,refh,a.build/'ug_handshake_ior.pio.h',r/'sw/ultrags/ug_handshake_ior.pio',Path(__file__),r/'tools/ultrags/pio-isa-check.py',f/'config-exchange.c')}}),indent=2)+'\n')
print('CONFIG write window:3072 captures; old loses CC/selector, candidate unlocks real production CONFIG; native/GS early waits PASS')
