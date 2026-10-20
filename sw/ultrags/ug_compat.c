/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * Separate IOW10/IOR22 transport with a low-port fast path.
 * Keep the independent core1 fuse and optional LED report.
 */
#include "ug_compat.h"
#include "ug_led_diag.h"
#include "hardware/pio.h"
#include "hardware/gpio.h"
#include "hardware/irq.h"
#include "hardware/timer.h"
#include "hardware/structs/timer.h"
#include "hardware/sync.h"
#include "pico/stdlib.h"
#include "ug_compat_ior.pio.h"

enum { GUARD_PERIOD_US=100, GUARD_HOLD_US=10000 };
static unsigned program_offset;
uint32_t ug_compat_read_entry;
uint32_t ug_compat_read_restart;
static uint16_t current_base,current_alias;
static bool configured,ready,failed,tracking;
static uint32_t held_since;
static bool write_waiting;
static unsigned write_completions;
void ug_compat_note_write(uint32_t verdict) {
    if(verdict==UINT32_MAX) write_waiting=true;
    else if(!verdict && write_waiting) {
        write_waiting=false;
        __atomic_fetch_add(&write_completions,1,__ATOMIC_RELEASE);
    }
}
bool ug_handshake_guard_ready(void) { return __atomic_load_n(&ready,__ATOMIC_ACQUIRE); }
bool ug_handshake_failed(void) { return __atomic_load_n(&failed,__ATOMIC_ACQUIRE); }
static void release_bus(unsigned reason) {
    ug_led_diag_fault(reason);
    __atomic_store_n(&failed,true,__ATOMIC_RELEASE);
    pio_set_sm_mask_enabled(pio0,3u,false);
    for(unsigned pin=6;pin<16;pin++) {
        gpio_set_dir(pin,GPIO_IN);gpio_set_function(pin,GPIO_FUNC_SIO);
    }
    gpio_put(26,0);gpio_set_dir(26,GPIO_OUT);gpio_set_function(26,GPIO_FUNC_SIO);
    gpio_put(27,0);gpio_set_dir(27,GPIO_OUT);gpio_set_function(27,GPIO_FUNC_SIO);
}
static bool patch_safe(unsigned pc) {
    return pc==ug_compat_ior_offset_restart || pc==ug_compat_ior_offset_idle ||
        pc==ug_compat_ior_offset_owned_submit ||
        pc==ug_compat_ior_offset_owned_condition ||
        pc==ug_compat_ior_offset_condition;
}
bool ug_compat_sync_ports(uint16_t base,uint16_t alias) {
    if(ug_handshake_failed()) return false;
    if(configured && base==current_base && alias==current_alias) return true;
    if(base<0x200 || base>0x3e0 || (base&31) ||
       (alias!=0xffff && (alias<0x200 || alias>0x3e0 || (alias&31) || alias==base))) {
        release_bus(UG_LED_MAP_INVALID);return false;
    }
    unsigned pc=pio_sm_get_pc(pio0,1)-program_offset;
    for(unsigned i=0;i<64 && !patch_safe(pc);i++) {
        tight_loop_contents();pc=pio_sm_get_pc(pio0,1)-program_offset;
    }
    if(!patch_safe(pc)) { release_bus(UG_LED_MAP_PC);return false; }
    pio0->instr_mem[program_offset+ug_compat_ior_offset_base_compare]=pio_encode_set(pio_y,base>>5);
    pio0->instr_mem[program_offset+ug_compat_ior_offset_alias_compare]=pio_encode_set(pio_y,(alias==0xffff?base:alias)>>5);
    __dmb();current_base=base;current_alias=alias;configured=true;return true;
}
void ug_compat_init(unsigned offset,uint16_t base,uint16_t alias) {
    program_offset=offset;configured=false;
    ug_compat_read_entry=offset+ug_compat_ior_offset_value;
    ug_compat_read_restart=offset+ug_compat_ior_offset_restart;
    hard_assert(ug_compat_sync_ports(base,alias));
}
static void guard_irq(void) {
    static unsigned observed;
    timer_hw->intr=1u<<2;
    uint32_t now=time_us_32();timer_hw->alarm[2]=now+GUARD_PERIOD_US;
    ug_led_diag_guard_beat();
    if(ug_handshake_failed()) return;
    unsigned completed=__atomic_load_n(&write_completions,__ATOMIC_ACQUIRE);
    if(completed!=observed) { observed=completed;tracking=false; }
    /* IRQ0 is set by PIO only after a reply has released its data drivers.
     * Foreign/ignored reads and software polling are not completions. */
    if(pio0->irq&1u) { pio0->irq=1u;tracking=false; }
    /* Cover CONFIG and IOW as well as early-held native reads. */
    bool holding=(pio0->dbg_padout&(1u<<26))!=0;
    if(!holding) tracking=false;
    else if(!tracking) { held_since=now;tracking=true; }
    else if((uint32_t)(now-held_since)>=GUARD_HOLD_US)
        release_bus(UG_LED_HOLD_TIMEOUT);
}
void ug_handshake_guard_core1(void) {
    hardware_alarm_claim(2);irq_set_exclusive_handler(TIMER_IRQ_2,guard_irq);
    irq_set_priority(TIMER_IRQ_2,0);
    timer_hw->intr=1u<<2;timer_hw->alarm[2]=time_us_32()+GUARD_PERIOD_US;
    hw_set_bits(&timer_hw->inte,1u<<2);irq_set_enabled(TIMER_IRQ_2,true);
    __atomic_store_n(&ready,true,__ATOMIC_RELEASE);
}
