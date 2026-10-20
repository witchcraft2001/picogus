#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Exercise production map publication and the core1 fuse with register mocks."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--build', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
p.add_argument('--led-diag', action='store_true', help='Exercise diagnostic fault/heartbeat hooks')
a = p.parse_args()
r = Path(__file__).resolve().parents[2]
out = a.out.resolve()
out.mkdir(parents=True, exist_ok=True)
mock = out / 'include'
mock.mkdir(exist_ok=True)
(mock / 'mock.h').write_text('''#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <assert.h>
#include <string.h>
typedef struct {uint32_t instr_mem[32],irq,dbg_padout,pc[2],enabled,rx[2],gets[2],tx[2],restarts[2],forced_out[2];} mock_pio;
static mock_pio bus;
#define pio0 (&bus)
typedef struct {uint32_t intr,inte,alarm[4];} mock_timer;
static mock_timer timer;
#define timer_hw (&timer)
static uint32_t now;
static unsigned dirs[32],functions[32],values[32],priority,claimed,steps_to_park,park_pc;
static void (*callback)(void);
enum {pio_pins=0,pio_pindirs=4,pio_y=2,GPIO_IN=0,GPIO_OUT=1,GPIO_FUNC_SIO=5,TIMER_IRQ_2=2};
static uint32_t time_us_32(void){return now;}
static unsigned pio_sm_get_pc(mock_pio *p,unsigned sm){assert(sm<2);return p->pc[sm];}
static unsigned pio_encode_jmp(unsigned pc){return pc;}
static unsigned pio_encode_nop(void){return 0xa042;}
static unsigned pio_encode_sideset_opt(unsigned n,unsigned bits){assert(n==2);return 0x1000|(bits<<10);}
static void pio_sm_exec(mock_pio *p,unsigned sm,unsigned word){
 assert(sm<2);if((word>>13)==3){assert(sm==1&&(word==0x7408||word==0x7c88));p->forced_out[sm]++;}
 if((word>>13)==0)p->pc[sm]=word&31;
 if(word&0x1000){p->dbg_padout=(p->dbg_padout&~(3u<<26))|(((word>>10)&3u)<<26);}
}
static unsigned pio_encode_out(unsigned dest,unsigned count){return 0x6000|(dest<<5)|count;}
static void pio_sm_exec_wait_blocking(mock_pio *p,unsigned sm,unsigned word){pio_sm_exec(p,sm,word);}
static void pio_sm_restart(mock_pio *p,unsigned sm){p->restarts[sm]++;}
static void pio_sm_put(mock_pio *p,unsigned sm,unsigned word){p->tx[sm]=word;}
static unsigned gpio_get_all(void){unsigned v=0;for(unsigned i=0;i<32;i++)v|=values[i]<<i;return v;}
static unsigned gpio_get(unsigned n){return values[n];}
static void tight_loop_contents(void){if(steps_to_park&&!--steps_to_park)bus.pc[1]=park_pc;}

static unsigned pio_encode_set(unsigned dest,unsigned value){return 0xe000|(dest<<5)|value;}
static void pio_set_sm_mask_enabled(mock_pio *p,unsigned mask,bool enabled){assert(mask==3&&!enabled);p->enabled=0;}
static void gpio_set_dir(unsigned p,unsigned v){dirs[p]=v;}
static void gpio_set_function(unsigned p,unsigned v){if(p>=6&&p<16)assert(dirs[p]==0);functions[p]=v;}
static void gpio_put(unsigned p,unsigned v){values[p]=v;}
static void hardware_alarm_claim(unsigned n){assert(n==2);claimed++;}
static void irq_set_exclusive_handler(unsigned n,void(*f)(void)){assert(n==2);callback=f;}
static void irq_set_priority(unsigned n,unsigned v){assert(n==2);priority=v;}
static void irq_set_enabled(unsigned n,bool v){assert(n==2&&v);}
#define hw_set_bits(p,v) (*(p)|=(v))
#define __dmb() __atomic_thread_fence(__ATOMIC_SEQ_CST)
#define hard_assert assert
''')
for name in ['hardware/pio.h', 'hardware/gpio.h', 'hardware/irq.h', 'hardware/timer.h',
             'hardware/structs/timer.h', 'hardware/sync.h', 'pico/stdlib.h']:
    path = mock / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('#include "mock.h"\n')
source = out / 'guard-test.c'
source.write_text('#include "' + str(r / 'sw/ultrags/ug_handshake.c') + '''"
#include <stdio.h>
static void reset(void){
 ready=failed=tracking=false;completions=0;configured=false;read_ignored=false;steps_to_park=0;
 now=0;memset(&bus,0,sizeof(bus));memset(values,0,sizeof(values));
 park_pc=ug_handshake_ior_offset_parked;
 bus.enabled=3;bus.pc[0]=ug_handshake_ior_offset_write_restart;bus.pc[1]=ug_handshake_ior_offset_restart;values[5]=values[4]=1;claimed=0;
 waiting[0]=waiting[1]=false;ug_handshake_init(0,0x2a0,0xffff,false);
}
static void tick(uint32_t us,bool complete){now+=us;if(complete)++completions;callback();}
int main(void){
 reset();ug_handshake_guard_core1();assert(ready&&claimed==1&&priority==0);
 assert(timer.inte==4&&timer.alarm[2]==100);
 for(unsigned base=0x200;base<=0x3e0;base+=32)for(unsigned alias=0x200;alias<=0x400;alias+=32){
  if(alias==base)continue;unsigned a=alias==0x400?65535:alias;
  for(unsigned gs=0;gs<2;gs++){
   assert(ug_handshake_sync_ports(base,a,gs));
   assert(bus.instr_mem[ug_handshake_ior_offset_base_compare]==(0xe040|(base>>5)));
   assert(bus.instr_mem[ug_handshake_ior_offset_alias_compare]==(0xe040|((a==65535?base:a)>>5)));
   assert(bus.instr_mem[ug_handshake_ior_offset_gs_compare]==(gs?0xe045:ug_handshake_ior_offset_submit));
  }
 }
 for(unsigned port=0;port<1024;port++){
  uint32_t raw=((port&31)<<27)|(port>>5);
  for(unsigned sm=0;sm<2;sm++)for(unsigned feedback=0;feedback<2;feedback++){
   uint32_t capture=raw|(feedback<<15);
   assert(ug_handshake_port(sm,capture)==port);
   assert(ug_handshake_port(sm,~capture)==port);
   assert(!ug_handshake_native(sm,capture)&&ug_handshake_native(sm,~capture));
  }
  for(unsigned data=0;data<256;data++)assert(ug_handshake_data(((data&31)<<27)|(data>>5))==data);
 }
 /* R7 failure mechanism: PIO owns a native read, but feedback tag was 0.
  * Production cleanup treats it as foreign and leaves the PIO WAIT set.
  * The guard then disconnects the bus: FF followed by LED5. This is a
  * controlled feedback fault, not a measurement of the user's hardware. */
 reset();ug_handshake_guard_core1();bus.dbg_padout=1u<<26;values[5]=0;
 assert(!ug_handshake_capture(1,0x2a1,false));
 ug_handshake_put(1,IO_END);
 assert(bus.dbg_padout==(1u<<26)&&!bus.forced_out[1]);
 for(unsigned i=0;i<101;i++){
  /* Repeated ignored captures used to increment completions and postpone
   * the fuse indefinitely, even though no one released the PIO wait. */
  assert(!ug_handshake_capture(1,0x2a1,false));
  ug_handshake_put(1,IO_END);
  ug_handshake_capture(0,0x123,false);ug_handshake_put(0,IO_END);
  tick(100,false);
 }
 if(!failed||bus.enabled)return 77;
 /* Explicit branch tag survives the same zero feedback input. */
 reset();ug_handshake_guard_core1();bus.dbg_padout=1u<<26;values[5]=0;
 uint32_t native_snapshot=~((1u<<27)|(0x2a1u>>5)); /* active /IOR = 0 */
 assert(ug_handshake_native(1,native_snapshot));
 assert(ug_handshake_capture(1,ug_handshake_port(1,native_snapshot),true));
 ug_handshake_put(1,0xff01);
 assert(bus.forced_out[1]==2&&bus.tx[1]==0xff01);
 bus.dbg_padout=0; /* autonomous read tail */
 for(unsigned i=0;i<101;i++)tick(100,false);
 assert(!failed&&bus.enabled==3);
 /* Both directions: a stopped core0 cannot prevent the independent fuse. */
 for(unsigned sm=0;sm<2;sm++){
  reset();bus.pc[sm]=ug_handshake_ior_offset_parked;bus.dbg_padout=1u<<26;
  for(unsigned i=0;i<100;i++){tick(100,false);assert(!failed);}
  tick(100,false);assert(failed&&!bus.enabled);
  for(unsigned p=6;p<16;p++)assert(!dirs[p]&&functions[p]==GPIO_FUNC_SIO);
  assert(!values[26]&&!values[27]&&dirs[26]&&dirs[27]);
  assert(!ug_handshake_sync_ports(0x300,0xffff,false));
  assert(!ug_handshake_capture(1,0x2a1,true));
 }
 reset();bus.dbg_padout=1u<<26;
 for(unsigned i=0;i<1000;i++){tick(100,true);assert(!failed);}
 tracking=false;now=0xfffff000;
 for(unsigned i=0;i<100;i++){tick(100,false);assert(!failed);}tick(100,false);assert(failed);
 reset();bus.pc[1]=ug_handshake_ior_offset_value;
 assert(!ug_handshake_sync_ports(0x300,0xffff,false)&&failed);
 reset();assert(!ug_handshake_sync_ports(0x301,0xffff,false)&&failed);
 /* A parked read keeps its immutable capture across a map publication.
  * core0 may already have prefetched it to hold CONFIG before this IOW. */
 reset();bus.pc[1]=ug_handshake_ior_offset_parked;bus.rx[1]=2;
 assert(ug_handshake_sync_ports(0x300,0x280,true));assert(!bus.gets[1]&&bus.rx[1]==2);
 reset();bus.pc[1]=ug_handshake_ior_offset_parked;
 assert(ug_handshake_sync_ports(0x300,0x280,true)&&!failed);
 reset();bus.pc[1]=ug_handshake_ior_offset_idle;
 assert(ug_handshake_sync_ports(0x300,0x280,true)&&!failed);
 reset();bus.pc[1]=ug_handshake_ior_offset_decode;steps_to_park=8;
 assert(ug_handshake_sync_ports(0x300,0x280,true)&&!failed&&!steps_to_park);
 /* All three CONFIG reads acquire wait immediately at capture. No read
  * handler is allowed to consume a stale CONFIG byte or a foreign port. */
 for(unsigned port=0;port<1024;port++) {
  reset();values[5]=0;for(unsigned bit=0;bit<10;bit++)values[6+bit]=(port>>bit)&1;
  bool own=ug_handshake_capture(1,port,false);
  assert(own==(port>=0x1d0&&port<=0x1d2));
  assert(!!bus.dbg_padout==own&&waiting[1]==own);
 }
 for(unsigned port=0x1d0;port<=0x1d2;port++) {
  reset();assert(!ug_handshake_capture(1,port,false));assert(!bus.dbg_padout);
  reset();values[5]=0;values[6]=1;
  assert(!ug_handshake_capture(1,port,false));assert(!bus.dbg_padout);
 }
 /* Software wait is not immutable hardware ownership. The host can end
  * its read despite a late assertion; neither consumption nor TX is safe. */
 reset();values[5]=0;unsigned config=0x1d0;
 for(unsigned bit=0;bit<10;bit++)values[6+bit]=(config>>bit)&1;
 assert(ug_handshake_capture(1,config,false)&&waiting[1]&&!captured_owned[1]);
 assert(ug_handshake_read_active());values[5]=1;
 assert(!ug_handshake_read_active());ug_handshake_put(1,0xff24);
 assert(!bus.restarts[1]&&!bus.tx[1]&&!bus.forced_out[1]&&!bus.dbg_padout);
 /* Passive foreign cleanup must not release a newer write's early wait. */
 reset();values[5]=0;ug_handshake_capture(1,0x123,false);ug_handshake_put(1,IO_END);
 bus.dbg_padout=1u<<26;values[5]=1;ug_handshake_poll();assert(bus.dbg_padout==(1u<<26));
 ug_handshake_capture(0,0x2a3,true);ug_handshake_put(0,IO_END);assert(!bus.dbg_padout&&bus.pc[0]==ug_handshake_ior_offset_write_restart);
 /* Read verdict is a single empty-OSR data delivery, then autonomous PIO. */
 reset();ug_handshake_capture(1,0x2a3,true);ug_handshake_put(1,0xff24);
 assert(bus.forced_out[1]==2&&bus.restarts[1]==1&&bus.tx[1]==0xff24&&bus.pc[1]==ug_handshake_ior_offset_value);
 /* A stale CONFIG read never drives data or asserts wait on another port. */
 reset();ug_handshake_capture(1,0x1d1,false);ug_handshake_put(1,IO_WAIT);assert(!bus.dbg_padout);
 ug_handshake_put(1,0xff24);assert(!bus.restarts[1]&&!bus.dbg_padout);
 puts("HANDSHAKE production C: all maps/GS toggles, read+write fuse, stopped core0, stale/foreign passivity, OSR delivery PASS");
}

''')
if a.led_diag:
    text=source.read_text()
    prefix='''#define UG_LED_DIAG 1
#include "mock.h"
#include "''' + str(r/'sw/ultrags/ug_led_diag.h') + '''"
uint32_t ug_led_main_beats,ug_led_guard_beats,ug_led_config_reads;
static unsigned fault_reason,fault_enabled;
void ug_led_diag_fault(unsigned reason) {
 if(!fault_reason){fault_reason=reason;fault_enabled=bus.enabled;}
}
'''
    text=prefix+text
    text=text.replace('ready=failed=tracking=false;', 'fault_reason=fault_enabled=ug_led_guard_beats=0;ready=failed=tracking=false;')
    text=text.replace('tick(100,false);assert(failed&&!bus.enabled);',
                      'tick(100,false);assert(failed&&!bus.enabled);assert(fault_reason==5&&fault_enabled==3&&ug_led_guard_beats==101);')
    text=text.replace('assert(!ug_handshake_sync_ports(0x300,0xffff,false)&&failed);',
                      'assert(!ug_handshake_sync_ports(0x300,0xffff,false)&&failed);assert(fault_reason==6&&fault_enabled==3);')
    text=text.replace('reset();assert(!ug_handshake_sync_ports(0x301,0xffff,false)&&failed);',
                      'reset();assert(!ug_handshake_sync_ports(0x301,0xffff,false)&&failed);assert(fault_reason==7&&fault_enabled==3);')
    source.write_text(text)
exe = out / 'guard-test'
subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-const-variable',
                '-fsanitize=undefined', '-fno-sanitize-recover=all', '-DPICO_NO_HARDWARE=1',
                '-I' + str(mock), '-I' + str(a.build.resolve()), str(source), '-o', str(exe)], check=True)
subprocess.run([str(exe)], check=True)
# Restore the R7 unconditional "completion" to prove this regression check
# rejects the old masking behaviour, rather than only testing the happy path.
production = (r/'sw/ultrags/ug_handshake.c').read_text()
assert production.count('    if(!sm) {') == 1
mutant_impl = out/'guard-progress-mutant.c'
mutant_impl.write_text(production.replace('    if(!sm) {',
    '    __atomic_fetch_add(&completions,1,__ATOMIC_RELEASE);\n    if(!sm) {'))
mutant = out/'guard-progress-test.c'
mutant.write_text(source.read_text().replace(str(r/'sw/ultrags/ug_handshake.c'), str(mutant_impl)))
mutant_exe = out/'guard-progress-test'
subprocess.run(['cc', '-std=c11', '-fsanitize=undefined', '-fno-sanitize-recover=all',
                '-DPICO_NO_HARDWARE=1', '-I'+str(mock), '-I'+str(a.build.resolve()),
                '-I'+str(r/'sw/ultrags'), str(mutant), '-o', str(mutant_exe)], check=True)
assert subprocess.run([str(mutant_exe)], capture_output=True).returncode == 77
# Execute the generated C-SDK initialization body as well: a model that
# silently selects a different wrap would not validate the real SM setup.
header=(a.build.resolve()/'ug_handshake_ior.pio.h').read_text()
init=header[header.index('static inline void ug_handshake_sm_init'):].split('\n}',1)[0]+'\n}\n'
init_source=out/'init-test.c'
init_source.write_text('#include "mock.h"\n#include "ug_handshake_ior.pio.h"\n'+r'''
typedef unsigned uint;
typedef mock_pio *PIO;
typedef struct {unsigned bottom,top,inbase,threshold;bool push;float divider;} pio_sm_config;
static pio_sm_config configs[2];
static pio_sm_config ug_handshake_ior_program_get_default_config(unsigned off){(void)off;return (pio_sm_config){0};}
static void sm_config_set_in_pins(pio_sm_config*c,unsigned v){c->inbase=v;}
static void sm_config_set_in_shift(pio_sm_config*c,bool right,bool push,unsigned n){assert(!right);c->push=push;c->threshold=n;}
static void sm_config_set_out_shift(pio_sm_config*c,bool right,bool pull,unsigned n){(void)c;assert(right&&pull&&n==32);}
static void sm_config_set_out_pins(pio_sm_config*c,unsigned b,unsigned n){(void)c;assert(b==6&&n==8);}
static void sm_config_set_set_pins(pio_sm_config*c,unsigned b,unsigned n){(void)c;assert(b==27&&n==1);}
static void sm_config_set_sideset_pins(pio_sm_config*c,unsigned b){(void)c;assert(b==26);}
static void sm_config_set_jmp_pin(pio_sm_config*c,unsigned b){(void)c;assert(b==19);}
static void sm_config_set_wrap(pio_sm_config*c,unsigned b,unsigned t){c->bottom=b;c->top=t;}
static void sm_config_set_clkdiv(pio_sm_config*c,float d){c->divider=d;}
static void pio_sm_init(PIO p,unsigned sm,unsigned pc,const pio_sm_config*c){p->pc[sm]=pc;configs[sm]=*c;}
'''+init+r'''
int main(void){
 ug_handshake_sm_init(pio0,0,0,false,259.0f/256.0f);
 ug_handshake_sm_init(pio0,1,0,true,259.0f/256.0f);
 assert(configs[0].bottom==ug_handshake_ior_offset_decode&&configs[0].top==ug_handshake_ior_offset_dack);
 assert(configs[1].bottom==ug_handshake_ior_offset_parked&&configs[1].top==ug_handshake_ior_offset_address_only);
 assert(bus.pc[0]==ug_handshake_ior_offset_write_restart&&bus.pc[1]==ug_handshake_ior_offset_restart);
 for(unsigned sm=0;sm<2;sm++)assert(configs[sm].inbase==11&&configs[sm].threshold==32&&configs[sm].push&&configs[sm].divider==259.0f/256.0f);
 return 0;
}
''')
init_exe=out/'init-test'
subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-Wno-unused-variable','-Wno-unused-function','-Wno-unused-const-variable','-DPICO_NO_HARDWARE=1','-I'+str(mock),'-I'+str(a.build.resolve()),str(init_source),'-o',str(init_exe)],check=True)
subprocess.run([str(init_exe)],check=True)
print('Generated C-SDK SM init: IOR address-only wrap, IOW pair wrap, pins, shifts, divider PASS')
inputs = [r / 'sw/ultrags/ug_handshake.c', r / 'sw/ultrags/ug_handshake.h',
          r / 'sw/ultrags/ug_led_diag.h',
          a.build.resolve() / 'ug_handshake_ior.pio.h', Path(__file__).resolve()]
(out / 'guard.json').write_text(json.dumps(dict(status='HOST_GUARD_PASS / REAL_PENDING',
    addressOnlyInit='PASS',ignoredProgressMutationRejected=True,ledDiagHooks=a.led_diag,
    inputs={str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in inputs}), indent=2) + '\n')
