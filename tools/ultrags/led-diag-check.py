#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute production LED diagnostic C with register mocks and UBSan."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--out', type=Path, required=True)
a = p.parse_args()
r = Path(__file__).resolve().parents[2]
out = a.out.resolve()
mock = out / 'include'
mock.mkdir(parents=True, exist_ok=True)
(mock / 'mock.h').write_text(r'''#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <assert.h>
#include <string.h>
#define PICO_TIME_DEFAULT_ALARM_POOL_HARDWARE_ALARM_NUM 3
#define PICO_TIME_DEFAULT_ALARM_POOL_DISABLED 0
typedef struct {uint32_t addr,execctrl,shiftctrl;} mock_sm;
typedef struct {uint32_t ctrl,fstat,fdebug,dbg_padout;mock_sm sm[4];} mock_pio;
static mock_pio bus;
#define pio0 (&bus)
typedef struct {uint32_t intr,inte,alarm[4];} mock_timer;
static mock_timer timer;
#define timer_hw (&timer)
static uint32_t now,pins;
static unsigned gpio_writes,led,claims,irq_priority;
static void (*callback)(void);
enum {GPIO_OUT=1,TIMER_IRQ_1=1};
static uint32_t time_us_32(void){return now;}
static uint32_t gpio_get_all(void){return pins;}
static void gpio_init(unsigned p){assert(p==25);}
static void gpio_set_dir(unsigned p,unsigned d){assert(p==25&&d==GPIO_OUT);}
static void gpio_put(unsigned p,bool v){assert(p==25);led=v;gpio_writes++;}
static void hardware_alarm_claim(unsigned n){assert(n==1);claims++;}
static void irq_set_exclusive_handler(unsigned n,void(*f)(void)){assert(n==1);callback=f;}
static void irq_set_priority(unsigned n,unsigned v){assert(n==1);irq_priority=v;}
static void irq_set_enabled(unsigned n,bool v){assert(n==1&&v);}
static uint32_t save_and_disable_interrupts(void){return 123;}
static void restore_interrupts(uint32_t v){assert(v==123);}
#define hw_set_bits(p,v) (*(p)|=(v))
''')
for n in ['hardware/gpio.h', 'hardware/pio.h', 'hardware/irq.h', 'hardware/timer.h',
          'hardware/structs/timer.h', 'hardware/sync.h', 'pico/stdlib.h']:
    path = mock / n
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('#include "mock.h"\n')
source = out / 'led-test.c'
source.write_text('#define UG_LED_DIAG 1\n#include "' + str(r / 'sw/ultrags/ug_led_diag.c') + r'''"
#include <stdio.h>
static void reset(uint32_t start) {
 now=start;pins=0x12345678;gpio_writes=led=claims=irq_priority=0;callback=0;
 memset(&bus,0,sizeof(bus));memset(&timer,0,sizeof(timer));
 memset((void*)&ug_led_first_fault,0,sizeof(ug_led_first_fault));
 ug_led_main_beats=ug_led_guard_beats=ug_led_config_reads=0;
 stage=UG_LED_INIT;stage_at=0;seen_main=seen_guard=0;
 main_at=guard_at=frame_at=0;frame_code=UG_LED_INIT;enabled=false;
}
static void tick(bool main,bool guard) {
 now+=SAMPLE_US;
 if(main) ug_led_diag_main_beat();
 if(guard) ug_led_diag_guard_beat();
 callback();
 assert(timer.alarm[1]==now+SAMPLE_US);
}
int main(void) {
 reset(0);ug_led_diag_init(false);assert(!claims&&!gpio_writes&&!callback);
 ug_led_diag_init(true);ug_led_diag_init(true);
 assert(claims==1&&irq_priority==0x80&&timer.inte==2&&callback);
 assert(status(now)==1);ug_led_diag_stage(2);
 for(unsigned i=0;i<80;i++) tick(false,false);
 assert(status(now)==2&&!ug_led_first_fault.code); /* wait-core1 is not code9 */
 ug_led_diag_stage(3);
 for(unsigned i=0;i<80;i++) tick(true,true);
 assert(status(now)==3&&!ug_led_first_fault.code);
 ug_led_diag_read(0x1cf);ug_led_diag_read(0x1d3);assert(!ug_led_config_reads);
 for(unsigned p=0x1d0;p<=0x1d2;p++) ug_led_diag_read(p);
 assert(ug_led_config_reads==3&&status(now)==4);
 /* Every complete frame has exactly N pulses, including across timer wrap. */
 for(unsigned code=1;code<=9;code++) for(unsigned wrap=0;wrap<2;wrap++) {
  reset(wrap?UINT32_MAX-1000000u:0);ug_led_diag_init(true);
  stage=code<=4?code:3;
  if(code>=5) ug_led_diag_fault(code);
  if(code==4) stage=3,ug_led_config_reads=1;
  frame_code=code;frame_at=now;
  unsigned rises=0,prev=0;
  uint32_t duration=code*2u*PULSE_US+GAP_US;
  for(uint32_t t=0;t<duration;t+=SAMPLE_US) {
   ug_led_diag_main_beat();ug_led_diag_guard_beat();led_irq();
   rises+=led&&!prev;prev=led;now+=SAMPLE_US;
  }
  assert(rises==code&&!led);
 }
 /* Changing status halfway through a frame never splices pulse counts. */
 reset(0);ug_led_diag_init(true);frame_code=3;stage=3;
 unsigned rises=0,prev=0;
 for(uint32_t t=0;t<3u*2u*PULSE_US+GAP_US;t+=SAMPLE_US) {
  if(t==100000) ug_led_diag_fault(5);
  ug_led_diag_main_beat();ug_led_diag_guard_beat();led_irq();
  rises+=led&&!prev;prev=led;now+=SAMPLE_US;
 }
 assert(rises==3);led_irq();assert(frame_code==5&&led);
 /* Main stopped but IRQ1 still runs: stable code8; guard stopped: code9. */
 for(unsigned wrap=0;wrap<2;wrap++) for(unsigned lost=0;lost<2;lost++) {
  reset(wrap?UINT32_MAX-300000u:0);ug_led_diag_init(true);ug_led_diag_stage(3);
  for(unsigned i=0;i<19;i++) {tick(lost!=0,lost!=1);assert(!ug_led_first_fault.code);}
  tick(lost!=0,lost!=1);assert(ug_led_first_fault.code==(lost?9u:8u));
 }
 /* Freeze the FIRST fault and the registers before the bus is disabled. */
 reset(42);ug_led_diag_init(true);bus.ctrl=3;bus.fstat=0x55;bus.fdebug=0x66;
 bus.sm[0].addr=19;bus.sm[1].addr=18;bus.dbg_padout=1u<<26;
 ug_led_diag_fault(5);
 struct ug_led_fault_record saved;memcpy(&saved,(const void*)&ug_led_first_fault,sizeof(saved));
 assert(saved.code==5&&saved.ctrl==3&&saved.pc[1]==18&&saved.gpio==pins&&saved.time_us==42);
 bus.ctrl=0;now+=1000000;ug_led_diag_fault(6);ug_led_diag_fault(7);ug_led_diag_fault(8);
 assert(!memcmp(&saved,(const void*)&ug_led_first_fault,sizeof(saved)));
 assert(bus.fdebug==0x66); /* read-only snapshot; no W1C write */
 reset(0);ug_led_diag_init(true);ug_led_first_fault.code=UINT32_MAX;
 ug_led_diag_fault(7);assert(ug_led_first_fault.code==UINT32_MAX);
 puts("LED production C: GPIO25 ownership, stages, 18 pulse frames, state transition, wrap, stalls, first-fault snapshot PASS");
}
''')
exe = out / 'led-test'
subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fsanitize=undefined',
                '-fno-sanitize-recover=all', '-I'+str(mock), str(source), '-o', str(exe)], check=True)
text = subprocess.check_output([str(exe)], text=True)
print(text, end='')
paths = ['sw/ultrags/ug_led_diag.c', 'sw/ultrags/ug_led_diag.h',
         'sw/ultrags/ug_handshake.c', 'sw/picogus.cpp', 'sw/CMakeLists.txt',
         'tools/ultrags/led-diag-check.py']
(out / 'led.json').write_text(json.dumps({
    'status': 'HOST_LED_DIAG_PASS / REAL_PENDING', 'actual': text.strip(),
    'inputs': {n: hashlib.sha256((r/n).read_bytes()).hexdigest() for n in paths},
}, indent=2)+'\n')
