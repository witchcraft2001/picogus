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
typedef struct {uint32_t instr_mem[32],irq,dbg_padout,pc,enabled;} mock_pio;
static mock_pio bus;
#define pio0 (&bus)
typedef struct {uint32_t intr,inte,alarm[4];} mock_timer;
static mock_timer timer;
#define timer_hw (&timer)
static uint32_t now;
static unsigned dirs[32],functions[32],values[32],priority,claimed;
static void (*callback)(void);
enum {pio_y=2,GPIO_IN=0,GPIO_OUT=1,GPIO_FUNC_SIO=5,TIMER_IRQ_2=2};
static uint32_t time_us_32(void){return now;}
static unsigned pio_sm_get_pc(mock_pio *p,unsigned sm){assert(sm==1);return p->pc;}
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
    ready=failed=tracking=false; now=0; bus.enabled=3; bus.pc=2; bus.irq=0;
    bus.dbg_padout=0; claimed=0; ug_handshake_init(2,0x2a0,0xffff);
}
static void tick(uint32_t us,bool complete){
    now+=us;bus.irq=complete?1:0;callback();bus.irq=0; /* W1C register */
}
int main(void){
 reset();ug_handshake_guard_core1();assert(ready&&claimed==1&&priority==0);
 assert(timer.inte==4&&timer.alarm[2]==100);
 for(unsigned base=0x200;base<=0x3e0;base+=32)for(unsigned alias=0x200;alias<=0x400;alias+=32){
  if(alias==base)continue;unsigned a=alias==0x400?65535:alias;
  assert(ug_handshake_sync_ports(base,a));
  assert(bus.instr_mem[2+ug_handshake_ior_offset_base_compare]==(0xe040|(base>>5)));
  assert(bus.instr_mem[2+ug_handshake_ior_offset_alias_compare]==(0xe040|((a==65535?base:a)>>5)));
 }
 for(unsigned port=0;port<1024;port++){
  uint32_t raw=((port&31)<<27)|(port>>5);
  assert(!ug_handshake_native(raw)&&ug_handshake_port(raw)==port);
  assert(ug_handshake_native(~raw)&&ug_handshake_port(~raw)==port);
 }
 /* A stopped core0 never arms a software deadline: core1 detects PIO itself. */
 reset();bus.pc=2+ug_handshake_ior_offset_owned_submit;bus.dbg_padout=1u<<26;
 for(unsigned i=0;i<100;i++){tick(100,false);assert(!failed);}
 tick(100,false);assert(failed&&!bus.enabled);
 for(unsigned p=6;p<16;p++)assert(!dirs[p]&&functions[p]==GPIO_FUNC_SIO);
 assert(!values[26]&&!values[27]&&dirs[26]&&dirs[27]);
 assert(!ug_handshake_sync_ports(0x300,0xffff));
 /* Completion activity prevents false trips under sustained read traffic. */
 reset();bus.pc=2+ug_handshake_ior_offset_value;bus.dbg_padout=1u<<26;
 for(unsigned i=0;i<1000;i++){tick(100,true);assert(!failed);}
 /* Unsigned deadline arithmetic across the 32-bit microsecond wrap. */
 tracking=false;now=0xfffff000;
 for(unsigned i=0;i<100;i++){tick(100,false);assert(!failed);}
 tick(100,false);assert(failed);
 /* Unsafe live map edits and invalid maps disconnect, without patching. */
 reset();bus.pc=2+ug_handshake_ior_offset_value;
 assert(!ug_handshake_sync_ports(0x300,0xffff)&&failed);
 reset();assert(!ug_handshake_sync_ports(0x301,0xffff)&&failed);
 puts("HANDSHAKE production guard: map publication, stopped core0, wrap, consecutive cycles, permanent pad release PASS");
}
''')
exe = out / 'guard-test'
subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-const-variable',
                '-fsanitize=undefined', '-fno-sanitize-recover=all', '-DPICO_NO_HARDWARE=1',
                '-I' + str(mock), '-I' + str(a.build.resolve()), str(source), '-o', str(exe)], check=True)
subprocess.run([str(exe)], check=True)
inputs = [r / 'sw/ultrags/ug_handshake.c', r / 'sw/ultrags/ug_handshake.h',
          a.build.resolve() / 'ug_handshake_ior.pio.h', Path(__file__).resolve()]
(out / 'guard.json').write_text(json.dumps(dict(status='HOST_GUARD_PASS / REAL_PENDING',
    inputs={str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in inputs}), indent=2) + '\n')
