/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 *
 * Diagnostic only: TIMER_IRQ_1 on core0 owns GPIO25. No waits, USB, flash
 * writes, FIFO reads or ISA verdicts. TIMER_IRQ_2 remains the core1 fuse.
 * A stopped core0 with interrupts disabled also stops this indication.
 */
#include "ug_led_diag.h"
#include "hardware/gpio.h"
#include "hardware/pio.h"
#include "hardware/irq.h"
#include "hardware/timer.h"
#include "hardware/structs/timer.h"
#include "hardware/sync.h"
#include "pico/stdlib.h"

/* SDK default pool normally owns alarm3; core1 guard owns alarm2. */
#if PICO_TIME_DEFAULT_ALARM_POOL_HARDWARE_ALARM_NUM == 1 && !PICO_TIME_DEFAULT_ALARM_POOL_DISABLED
#error "UG_LED_DIAG alarm1 conflicts with the SDK default alarm pool"
#endif
enum { SAMPLE_US=25000, STALL_US=500000, PULSE_US=200000, GAP_US=2000000 };
uint32_t ug_led_main_beats,ug_led_guard_beats,ug_led_config_reads;
/* Retained until reset, inspectable with SWD. code is published last.
 * UINT32_MAX reserves the record while the first reporter copies registers. */
struct ug_led_fault_record {
    uint32_t code, time_us, stage, gpio, ctrl, fstat, fdebug, padout;
    uint32_t pc[2], execctrl[2], shiftctrl[2];
    uint32_t main_beats,guard_beats,config_reads;
};
volatile struct ug_led_fault_record ug_led_first_fault;
static uint32_t stage=UG_LED_INIT,stage_at;
static uint32_t seen_main,seen_guard,main_at,guard_at,frame_at;
static unsigned frame_code=UG_LED_INIT;
static bool enabled;

void ug_led_diag_fault(unsigned reason) {
    if(reason<UG_LED_HOLD_TIMEOUT || reason>UG_LED_GUARD_STALLED) return;
    uint32_t empty=0;
    if(!__atomic_compare_exchange_n(&ug_led_first_fault.code,&empty,UINT32_MAX,
                                    false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE)) return;
    ug_led_first_fault.time_us=time_us_32();
    ug_led_first_fault.stage=__atomic_load_n(&stage,__ATOMIC_ACQUIRE);
    ug_led_first_fault.gpio=gpio_get_all();
    ug_led_first_fault.ctrl=pio0->ctrl;
    ug_led_first_fault.fstat=pio0->fstat;
    ug_led_first_fault.fdebug=pio0->fdebug;
    ug_led_first_fault.padout=pio0->dbg_padout;
    for(unsigned sm=0;sm<2;sm++) {
        ug_led_first_fault.pc[sm]=pio0->sm[sm].addr;
        ug_led_first_fault.execctrl[sm]=pio0->sm[sm].execctrl;
        ug_led_first_fault.shiftctrl[sm]=pio0->sm[sm].shiftctrl;
    }
    ug_led_first_fault.main_beats=__atomic_load_n(&ug_led_main_beats,__ATOMIC_RELAXED);
    ug_led_first_fault.guard_beats=__atomic_load_n(&ug_led_guard_beats,__ATOMIC_RELAXED);
    ug_led_first_fault.config_reads=__atomic_load_n(&ug_led_config_reads,__ATOMIC_RELAXED);
    __atomic_store_n(&ug_led_first_fault.code,reason,__ATOMIC_RELEASE);
}
void ug_led_diag_stage(unsigned value) {
    /* Called only on core0. Publish the time and stage together w.r.t. IRQ1. */
    uint32_t flags=save_and_disable_interrupts();
    stage_at=time_us_32();
    __atomic_store_n(&stage,value,__ATOMIC_RELEASE);
    restore_interrupts(flags);
}
static unsigned status(uint32_t now) {
    uint32_t m=__atomic_load_n(&ug_led_main_beats,__ATOMIC_RELAXED);
    uint32_t g=__atomic_load_n(&ug_led_guard_beats,__ATOMIC_RELAXED);
    if(m!=seen_main) {seen_main=m;main_at=now;}
    if(g!=seen_guard) {seen_guard=g;guard_at=now;}
    unsigned s=__atomic_load_n(&stage,__ATOMIC_ACQUIRE);
    if(s==UG_LED_RUNNING && (uint32_t)(now-stage_at)>=STALL_US) {
        if((uint32_t)(now-main_at)>=STALL_US) ug_led_diag_fault(UG_LED_CORE0_STALLED);
        else if((uint32_t)(now-guard_at)>=STALL_US) ug_led_diag_fault(UG_LED_GUARD_STALLED);
    }
    unsigned fault=__atomic_load_n(&ug_led_first_fault.code,__ATOMIC_ACQUIRE);
    if(fault>=UG_LED_HOLD_TIMEOUT && fault<=UG_LED_GUARD_STALLED) return fault;
    if(s==UG_LED_RUNNING && __atomic_load_n(&ug_led_config_reads,__ATOMIC_RELAXED))
        return UG_LED_CONFIG_READS;
    return s;
}
static void led_irq(void) {
    timer_hw->intr=1u<<1;
    uint32_t now=time_us_32();
    timer_hw->alarm[1]=now+SAMPLE_US;
    unsigned next=status(now);
    uint32_t elapsed=now-frame_at, pulses=frame_code*2u*PULSE_US;
    /* Finish each group even when state changes; never splice pulse counts. */
    if(elapsed>=pulses+GAP_US) {
        frame_at=now;frame_code=next;elapsed=0;pulses=frame_code*2u*PULSE_US;
    }
    gpio_put(25,elapsed<pulses && (elapsed/PULSE_US)%2u==0);
}
void ug_led_diag_init(bool pico_based) {
    /* GPIO25 is the M62429 clock on chipdown boards: never take it there. */
    if(!pico_based || enabled) return;
    enabled=true;
    gpio_init(25);gpio_set_dir(25,GPIO_OUT);gpio_put(25,0);
    uint32_t now=time_us_32();
    main_at=guard_at=stage_at=frame_at=now;
    hardware_alarm_claim(1);
    irq_set_exclusive_handler(TIMER_IRQ_1,led_irq);
    irq_set_priority(TIMER_IRQ_1,0x80);
    timer_hw->intr=1u<<1;timer_hw->alarm[1]=now+SAMPLE_US;
    hw_set_bits(&timer_hw->inte,1u<<1);
    irq_set_enabled(TIMER_IRQ_1,true);
}
