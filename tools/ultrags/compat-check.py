#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""R10 low-port fast path, R9 negative control, PIO and production fuse.

Instruction scheduling is functional evidence, not a Sprinter timing proof.
"""
import argparse, ast, hashlib, importlib.util, json, subprocess
from pathlib import Path

r=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser()
p.add_argument('--build',type=Path,required=True)
p.add_argument('--out',type=Path,required=True)
a=p.parse_args();b=a.build.resolve();out=a.out.resolve();out.mkdir(parents=True,exist_ok=True)
spec=importlib.util.spec_from_file_location('pio',r/'tools/ultrags/pio-isa-check.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
header=b/'ug_compat_ior.pio.h'
words,labels,wrap=m.program(header,'ug_compat_ior')
ref=r/'tests/ultrags/reference/handshake-v1.pio';refh=out/'v1.pio.h'
subprocess.run([str(b/'pioasm-install/pioasm/pioasm'),'-o','c-sdk','-v','0',str(ref),str(refh)],check=True)
reference,ref_labels,ref_wrap=m.program(refh,'ug_handshake_ior')
iow,_,iow_wrap=m.program(b/'isa_io.pio.h','iow')
assert words!=reference and len(words)==22 and len(iow)==10
def compat(w,l,wr,base,alias):
    sm=m.SM(w,wr,early=True)
    if w==words:
        sm.jmp_pin=15
        sm.native_entry=l['value']
    sm.words[l['base_compare']]=0xe040|(base>>5)
    sm.words[l['alias_compare']]=0xe040|((base if alias==0xffff else alias)>>5)
    return sm
cases=0
for base in range(0x200,0x400,32):
    for alias in [0xffff,*range(0x200,0x400,32)]:
        if alias==base:continue
        sm=compat(words,labels,wrap,base,alias)
        for port in range(1024):
            sm.pc=1;sm.isr=sm.osr=sm.inc=sm.hold=sm.ads=sm.dirs=sm.delay=0;sm.outc=32
            sm.tx.clear();sm.rx.clear();sm.port=port;sm.ior=0
            for _ in range(32):
                sm.step()
                if sm.rx:break
            assert len(sm.rx)==1
            captured=sm.rx[0];owned=bool(captured&(1<<26))
            assert owned==(port//32 in (base//32,alias//32))
            raw=(~captured&0xffffffff) if owned else captured
            assert ((raw>>27)&31)|((raw&31)<<5)==port
            assert bool(sm.hold)==owned and not sm.dirs and not sm.ads
            cases+=1
def transaction(port,value,delay):
    sm=compat(words,labels,wrap,0x2a0,0xffff);sm.port=port
    sm.step();sm.ior=0;capture_at=None;sample=None
    for tick in range(delay+256):
        sm.step()
        if sm.rx and capture_at is None:
            capture_at=tick;sm.rx.clear()
        if capture_at is not None and tick==capture_at+delay:
            sm.tx.extend([labels['value'] if port>=0x200 else 0xffffffff,0xff00|value])
        if tick>=74 and sample is None and not sm.hold:
            sample=sm.value if sm.dirs==255 and sm.ads else 255;sm.ior=1
    assert sample is not None and not sm.dirs and not sm.hold and not sm.ads
    assert not sm.rx and not sm.tx
    return sample
for port in (0x1d0,0x1d1,0x1d2,0xb3,0xbb):
    for value in range(256):assert transaction(port,value,8)==value
    # The legacy CONFIG/GS path still needs prompt ARM service. Preserve
    # this failing control rather than calling it hardware-independent.
    assert transaction(port,36,128)==255
for delay in (8,128,4096):
    assert transaction(0x2a3,36,delay)==36
saved_native=m.native;m.native=compat
for period in (1,2):
    for phase in range(period):assert m.coupled(iow,iow_wrap,words,labels,wrap,writer_period=period,writer_phase=phase)
assert not m.coupled(iow,iow_wrap,words,labels,wrap,mutate=True)
m.native=saved_native

# Measure generated instruction schedules, with the same supplied ARM latency.
# The finite sampling window below is deliberately constructed between the two
# WAIT edges: it is a regression/negative control, NOT a measured host deadline.
def schedule(w,l,wr,latency,deadline=10000):
    sm=compat(w,l,wr,0x2a0,0xffff);sm.port=0x1d2
    sm.step();sm.ior=0
    captured=held=driven=released=sample=None
    for tick in range(11000):
        sm.step()
        if sm.rx and captured is None:captured=tick;sm.rx.clear()
        if captured is not None and tick==captured+latency:
            sm.tx.extend([0xffffffff,0xff24])
        if sm.hold and held is None:held=tick
        if sm.ads and sm.dirs==255 and driven is None:driven=tick
        if driven is not None and not sm.hold and released is None:released=tick
        if tick>=deadline and sample is None and not sm.hold:
            sample=sm.value if sm.ads and sm.dirs==255 else 255
            sm.ior=1
        if sample is not None and tick>deadline+200:break
    return dict(capture=captured,wait=held,drive=driven,release=released,sample=sample)
timing=[]
for latency in (4,8,16,32,64,128):
    old=schedule(reference,ref_labels,ref_wrap,latency)
    new=schedule(words,labels,wrap,latency)
    assert old['capture']-new['capture']==5
    assert old['wait']-new['wait']==5
    assert new['release']-new['drive']==4
    assert old['release']-old['drive']==1
    deadline=new['wait']+1
    bad=schedule(reference,ref_labels,ref_wrap,latency,deadline)
    good=schedule(words,labels,wrap,latency,deadline)
    assert bad['sample']==255 and good['sample']==36
    timing.append(dict(armLatencyTicks=latency,old=old,new=new,
                       constructedDeadline=deadline,oldSample=bad['sample'],newSample=good['sample']))

# Reuse only the SDK register mock, not the shared frontend's test body.
guard_source=r/'tools/ultrags/handshake-guard-check.py'
mock_text=next(n.value for n in ast.walk(ast.parse(guard_source.read_text()))
              if isinstance(n,ast.Constant) and isinstance(n.value,str)
              and n.value.startswith('#pragma once\n#include <stdbool.h>'))
mock=out/'include';mock.mkdir(exist_ok=True);(mock/'mock.h').write_text(mock_text)
for name in ['hardware/pio.h','hardware/gpio.h','hardware/irq.h','hardware/timer.h',
             'hardware/structs/timer.h','hardware/sync.h','pico/stdlib.h']:
    path=mock/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('#include "mock.h"\n')
test=out/'guard.c'
test.write_text('#define UG_LED_DIAG 1\n#include "'+str(r/'sw/ultrags/ug_compat.c')+r'''"
#include <stdio.h>
uint32_t ug_led_main_beats,ug_led_guard_beats,ug_led_config_reads;
static unsigned fault;
void ug_led_diag_fault(unsigned code){if(!fault)fault=code;}
static void reset(void){
 ready=failed=tracking=configured=write_waiting=false;write_completions=0;
 fault=now=steps_to_park=0;memset(&bus,0,sizeof(bus));memset(values,0,sizeof(values));
 bus.enabled=3;bus.pc[1]=ug_compat_ior_offset_idle;park_pc=ug_compat_ior_offset_condition;
 ug_compat_init(0,0x2a0,0xffff);
}
static void tick(unsigned dt){
 now+=dt;guard_irq();bus.irq=0; /* emulate IRQ register write-one-to-clear */
}
int main(void){
 reset();ug_handshake_guard_core1();assert(ready&&callback&&priority==0);
 for(unsigned off=0;off<=10;off++){
  reset();bus.pc[1]=off+ug_compat_ior_offset_idle;ug_compat_init(off,0x2a0,65535);
  assert(!failed&&ug_compat_read_entry==off+ug_compat_ior_offset_value);
  assert(ug_compat_read_restart==off+ug_compat_ior_offset_restart);
 }
 reset();
 for(unsigned base=0x200;base<0x400;base+=32)for(unsigned alias=0x200;alias<=0x400;alias+=32){
  if(base==alias)continue;
  assert(ug_compat_sync_ports(base,alias==0x400?65535:alias));
  assert(bus.instr_mem[ug_compat_ior_offset_base_compare]==(0xe040|(base>>5)));
 }
 reset();bus.dbg_padout=1u<<26;
 for(unsigned i=0;i<102;i++){ug_compat_note_write(0);tick(100);}
 assert(failed&&!bus.enabled&&fault==UG_LED_HOLD_TIMEOUT);
 for(unsigned p=6;p<16;p++)assert(!dirs[p]&&functions[p]==GPIO_FUNC_SIO);
 assert(!values[26]&&!values[27]);
 assert(!ug_compat_sync_ports(0x300,0xffff));
 reset();bus.dbg_padout=1u<<26;
 for(unsigned i=0;i<1000;i++){ug_compat_note_write(UINT32_MAX);ug_compat_note_write(0);tick(100);}
 assert(!failed); /* actual slow writes count; ignored IO_END above does not */
 reset();bus.dbg_padout=1u<<26;
 for(unsigned i=0;i<1000;i++){bus.irq=1;tick(100);}
 assert(!failed);
 reset();now=0xfffff000;bus.dbg_padout=1u<<26;
 for(unsigned i=0;i<103;i++)tick(100);
 assert(failed&&fault==UG_LED_HOLD_TIMEOUT);
 reset();assert(!ug_compat_sync_ports(0x201,0xffff)&&fault==UG_LED_MAP_INVALID);
 reset();bus.pc[1]=ug_compat_ior_offset_value;
 assert(!ug_compat_sync_ports(0x300,0xffff)&&fault==UG_LED_MAP_PC);
 reset();bus.pc[1]=ug_compat_ior_offset_base_compare;steps_to_park=8;
 assert(ug_compat_sync_ports(0x300,0xffff)&&!failed&&!steps_to_park);
 for(unsigned pc=0;pc<22;pc++)if(patch_safe(pc)){
  reset();bus.pc[1]=pc;bus.rx[1]=1;
  assert(ug_compat_sync_ports(0x300,0x280)&&bus.rx[1]==1&&!bus.gets[1]);
 }
 puts("COMPAT guard: map publication, ignored writes, active completions, stopped core0, rollover, LED fault PASS");
}
''')
exe=out/'guard'
subprocess.run(['cc','-std=c11','-fsanitize=undefined','-fno-sanitize-recover=all',
 '-DPICO_NO_HARDWARE=1','-I'+str(mock),'-I'+str(b),'-I'+str(r/'sw/ultrags'),str(test),'-o',str(exe)],check=True)
subprocess.run([str(exe)],check=True)
inputs=[Path(__file__).resolve(),guard_source,r/'tools/ultrags/pio-isa-check.py',header,
 b/'isa_io.pio.h',ref,r/'sw/ultrags/ug_compat_ior.pio',r/'sw/ultrags/ug_compat.c',
 r/'sw/ultrags/ug_compat.h',r/'sw/ultrags/ug_handshake.h',r/'sw/picogus.cpp',r/'sw/CMakeLists.txt']
(out/'compat.json').write_text(json.dumps(dict(status='HOST_PASS / REAL_PENDING',
referenceWordsIdentical=False,pio0Words=32,addressCases=cases,configGsBytes=1280,timing=timing,
 coupledMutationRejected=True,guard='PASS',
 limits=['CONFIG/GS still depend on ARM latency; physical startup is pending',
         'PIO instruction ticks are not measured Sprinter timing'],
 inputs={str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in inputs}),indent=2)+'\n')
print('COMPAT R10 PIO:',cases,'addresses,1280 CONFIG/GS bytes, R9 timing negative control, read/write overlap and production guard PASS')
