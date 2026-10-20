/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * Shared32-word PIO frontend. TIMER_IRQ_2 on core1 is independent of core0.
 * Expiry permanently disconnects both SMs, data drivers, IOCHRDY and ADS.
 */
#include "ug_handshake.h"
#include "ug_led_diag.h"
#include "hardware/pio.h"
#include "hardware/gpio.h"
#include "hardware/irq.h"
#include "hardware/timer.h"
#include "hardware/structs/timer.h"
#include "hardware/sync.h"
#include "pico/stdlib.h"
#include "ug_handshake_ior.pio.h"
enum { GUARD_PERIOD_US=100,GUARD_HOLD_US=10000 };
static unsigned program_offset,completions;
static uint16_t current_base,current_alias,captured_port[2];
enum { IO_END=0 };
#define IO_WAIT UINT32_MAX
static bool current_gs,configured,captured_owned[2],waiting[2],read_ignored;
static bool ready,failed,tracking;
static uint32_t held_since;
/* Only a serviced response or an actual software WAIT release is progress.
 * Discarding foreign/stale captures must not mask a stuck PIO WAIT. */
static void completed(void) {
    __atomic_fetch_add(&completions,1,__ATOMIC_RELEASE);
}
bool ug_handshake_guard_ready(void) { return __atomic_load_n(&ready,__ATOMIC_ACQUIRE); }
bool ug_handshake_failed(void) { return __atomic_load_n(&failed,__ATOMIC_ACQUIRE); }
static void release_bus(unsigned reason) {
    ug_led_diag_fault(reason);
    __atomic_store_n(&failed,true,__ATOMIC_RELEASE);
    pio_set_sm_mask_enabled(pio0,3u,false);
    for(unsigned pin=6;pin<16;pin++) { gpio_set_dir(pin,GPIO_IN);gpio_set_function(pin,GPIO_FUNC_SIO); }
    gpio_put(26,0);gpio_set_dir(26,GPIO_OUT);gpio_set_function(26,GPIO_FUNC_SIO);
    gpio_put(27,0);gpio_set_dir(27,GPIO_OUT);gpio_set_function(27,GPIO_FUNC_SIO);
}
static void jump(unsigned sm,unsigned target) {
    pio_sm_exec(pio0,sm,pio_encode_jmp(program_offset+target));
}
static void side(unsigned sm,unsigned bits) {
    pio_sm_exec(pio0,sm,pio_encode_nop()|pio_encode_sideset_opt(2,bits));
}
void ug_handshake_poll(void) {
    if(!ug_handshake_failed() && read_ignored && gpio_get(5)) {
        read_ignored=false;jump(1,ug_handshake_ior_offset_restart);
    }
}
bool ug_handshake_capture(unsigned sm,uint16_t port,bool owned) {
    if(ug_handshake_failed()) return false;
    bool hardware_owned=owned;
    if(sm==1 && !owned && port>=0x1d0 && port<=0x1d2) {
        /* IOR captures address only and never switches ADS. Hold CONFIG now,
         * before applying a preceding write or consuming a config register.
         * Never stretch an ended cycle or another device's current address. */
        uint32_t pins=gpio_get_all();
        if(!(pins&(1u<<5)) && ((pins>>6)&1023u)==port) {
            side(1,1);owned=true;
        }
    }
    captured_port[sm]=port;captured_owned[sm]=hardware_owned;waiting[sm]=owned;
    return owned;
}
bool ug_handshake_read_active(void) {
    if(ug_handshake_failed()) return false;
    if(captured_owned[1]) return true;
    uint32_t pins=gpio_get_all();
    return !(pins&(1u<<5)) && ((pins>>6)&1023u)==captured_port[1];
}
void ug_handshake_put(unsigned sm,uint32_t word) {
    if(ug_handshake_failed()) return;
    if(word==IO_WAIT) {
        /* Config uses the historical late software handshake. Never assert
         * it for a stale, already completed cycle or a different bus address. */
        uint32_t pins=gpio_get_all();
        if(captured_owned[sm] || (!(pins&(1u<<(sm?5:4))) &&
           ((pins>>6)&1023u)==captured_port[sm])) { side(sm,1);waiting[sm]=true; }
        return;
    }
    if(!sm) {
        if(waiting[0]) { side(0,0);waiting[0]=false;completed(); }
        jump(0,ug_handshake_ior_offset_write_restart);
    } else if(word==IO_END) {
        if(waiting[1]) { side(1,0);waiting[1]=false;completed(); }
        /* Passive cleanup cannot clear a newer IOW's early wait. */
        read_ignored=true;ug_handshake_poll();
    } else {
        uint32_t pins=gpio_get_all();
        if(!captured_owned[1] && ((pins&(1u<<5)) || ((pins>>6)&1023u)!=captured_port[1])) {
            if(waiting[1]) { side(1,0);waiting[1]=false;completed(); }
            read_ignored=true;ug_handshake_poll();return;
        }
        /* Classification may have used OSR. Empty it before the data word;
         * read data, FF directions and zero directions are consumed once. */
        pio_sm_restart(pio0,1);
        pio_sm_put(pio0,1,word);
        // Free two PIO words for ADS settling at twice the classifier clock.
        // Keep WAIT asserted through value, direction and mux setup. Only
        // the PIO tail releases WAIT and then data directions after IOR.
        pio_sm_exec_wait_blocking(pio0,1,pio_encode_out(pio_pins,8)|pio_encode_sideset_opt(2,1));
        pio_sm_exec_wait_blocking(pio0,1,pio_encode_out(pio_pindirs,8)|pio_encode_sideset_opt(2,3));
        jump(1,ug_handshake_ior_offset_value);
        completed();
    }
}
bool ug_handshake_sync_ports(uint16_t base,uint16_t alias,bool gs) {
    if(ug_handshake_failed()) return false;
    if(configured && base==current_base && alias==current_alias && gs==current_gs) return true;
    ug_handshake_poll();
    unsigned pc=pio_sm_get_pc(pio0,1)-program_offset;
    /* The following host cycle may have entered the classifier while this
     * late CONFIG write was being applied. It reaches parked autonomously;
     * wait a bounded number of instruction clocks instead of treating a
     * transient classifier PC as a permanent transport failure. */
    for(unsigned i=0;i<64 && pc!=ug_handshake_ior_offset_restart && pc!=ug_handshake_ior_offset_idle && pc!=ug_handshake_ior_offset_parked;i++) {
        tight_loop_contents();pc=pio_sm_get_pc(pio0,1)-program_offset;
    }
    /* Parked reads retain their immutable captured ownership, including a
     * prefetched read held for CONFIG while the preceding IOW changes maps.
     * None of the three patched comparisons executes at parked or idle.
     * Do not discard the FIFO: it may hold the next CONFIG selector read. */
    if(base<0x200 || base>0x3e0 || (base&31) ||
       (alias!=0xffff && (alias<0x200 || alias>0x3e0 || (alias&31) || alias==base))) {
        release_bus(UG_LED_MAP_INVALID);return false;
    }
    if(pc!=ug_handshake_ior_offset_restart && pc!=ug_handshake_ior_offset_idle && pc!=ug_handshake_ior_offset_parked) {
        release_bus(UG_LED_MAP_PC);return false;
    }
    pio0->instr_mem[program_offset+ug_handshake_ior_offset_base_compare]=pio_encode_set(pio_y,base>>5);
    pio0->instr_mem[program_offset+ug_handshake_ior_offset_alias_compare]=pio_encode_set(pio_y,(alias==0xffff?base:alias)>>5);
    pio0->instr_mem[program_offset+ug_handshake_ior_offset_gs_compare]=gs?pio_encode_set(pio_y,5):pio_encode_jmp(program_offset+ug_handshake_ior_offset_submit);
    __dmb();current_base=base;current_alias=alias;current_gs=gs;configured=true;return true;
}
void ug_handshake_init(unsigned offset,uint16_t base,uint16_t alias,bool gs) {
    program_offset=offset;configured=false;
    hard_assert(ug_handshake_sync_ports(base,alias,gs));
}
static void guard_irq(void) {
    static unsigned observed;
    timer_hw->intr=1u<<2;uint32_t now=time_us_32();timer_hw->alarm[2]=now+GUARD_PERIOD_US;
    ug_led_diag_guard_beat();
    if(ug_handshake_failed()) return;
    unsigned completed=__atomic_load_n(&completions,__ATOMIC_ACQUIRE);
    if(completed!=observed) { observed=completed;tracking=false; }
    bool holding=(pio0->dbg_padout&(1u<<26))!=0;
    if(!holding) tracking=false;
    else if(!tracking) { held_since=now;tracking=true; }
    else if((uint32_t)(now-held_since)>=GUARD_HOLD_US) release_bus(UG_LED_HOLD_TIMEOUT);
}
void ug_handshake_guard_core1(void) {
    hardware_alarm_claim(2);irq_set_exclusive_handler(TIMER_IRQ_2,guard_irq);irq_set_priority(TIMER_IRQ_2,0);
    timer_hw->intr=1u<<2;timer_hw->alarm[2]=time_us_32()+GUARD_PERIOD_US;
    hw_set_bits(&timer_hw->inte,1u<<2);irq_set_enabled(TIMER_IRQ_2,true);
    __atomic_store_n(&ready,true,__ATOMIC_RELEASE);
}
