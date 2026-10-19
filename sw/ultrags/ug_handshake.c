/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * HANDSHAKE read fuse: TIMER_IRQ_2 runs on core1 above the I2S IRQ. It observes
 * the actual PIO wait, including a stopped core0 before its first FIFO read.
 * A trip disconnects both bus SMs permanently until reboot.
 */
#include "ug_handshake.h"
#include "hardware/pio.h"
#include "hardware/gpio.h"
#include "hardware/irq.h"
#include "hardware/timer.h"
#include "hardware/structs/timer.h"
#include "hardware/sync.h"
#include "pico/stdlib.h"
#include "ug_handshake_ior.pio.h"

enum { GUARD_PERIOD_US = 100, GUARD_HOLD_US = 10000 };
static unsigned program_offset;
static uint16_t current_base, current_alias;
static bool ready, failed, tracking;
static uint32_t held_since;
bool ug_handshake_guard_ready(void) { return __atomic_load_n(&ready, __ATOMIC_ACQUIRE); }
bool ug_handshake_failed(void) { return __atomic_load_n(&failed, __ATOMIC_ACQUIRE); }
static void release_bus(void) {
    __atomic_store_n(&failed, true, __ATOMIC_RELEASE);
    pio_set_sm_mask_enabled(pio0, 3u, false);
    for (unsigned pin = 6; pin < 16; ++pin) {
        gpio_set_dir(pin, GPIO_IN);
        gpio_set_function(pin, GPIO_FUNC_SIO);
    }
    gpio_put(26, 0); /* board inversion: zero releases IOCHRDY */
    gpio_set_dir(26, GPIO_OUT);
    gpio_set_function(26, GPIO_FUNC_SIO);
    gpio_put(27, 0);
    gpio_set_dir(27, GPIO_OUT);
    gpio_set_function(27, GPIO_FUNC_SIO);
}
bool ug_handshake_sync_ports(uint16_t base, uint16_t alias) {
    if (ug_handshake_failed()) return false;
    if (base == current_base && alias == current_alias) return true;
    /* Called by core0 before IO_END of the CONFIG write. ISA cannot issue a
     * read until that write completes; the preceding IOR has already cleaned
     * up its directions. Fail closed if this precondition is ever violated. */
    unsigned pc = pio_sm_get_pc(pio0, 1) - program_offset;
    if (pc > ug_handshake_ior_offset_idle ||
        base < 0x200 || base > 0x3e0 || (base & 31) ||
        (alias != 0xffff && (alias < 0x200 || alias > 0x3e0 || (alias & 31) || alias == base))) {
        release_bus(); return false;
    }
    pio0->instr_mem[program_offset + ug_handshake_ior_offset_base_compare] = pio_encode_set(pio_y, base >> 5);
    pio0->instr_mem[program_offset + ug_handshake_ior_offset_alias_compare] = pio_encode_set(pio_y, (alias == 0xffff ? base : alias) >> 5);
    __dmb();
    current_base = base; current_alias = alias;
    return true;
}
void ug_handshake_init(unsigned offset, uint16_t base, uint16_t alias) {
    program_offset = offset;
    current_base = current_alias = 0;
    hard_assert(ug_handshake_sync_ports(base, alias));
}
static void guard_irq(void) {
    timer_hw->intr = 1u << 2;
    uint32_t now = time_us_32();
    timer_hw->alarm[2] = now + GUARD_PERIOD_US;
    if (ug_handshake_failed()) return;
    /* Completed reads reset the interval even during continuous bus traffic.
     * Checking the pin alone would falsely trip on consecutive short holds. */
    if (pio0->irq & 1u) { pio0->irq = 1u; tracking = false; }
    unsigned pc = pio_sm_get_pc(pio0, 1) - program_offset;
    bool holding = pc >= ug_handshake_ior_offset_owned_submit &&
                   pc <= ug_handshake_ior_offset_value + 1 &&
                   (pio0->dbg_padout & (1u << 26));
    if (!holding) tracking = false;
    else if (!tracking) { held_since = now; tracking = true; }
    else if ((uint32_t)(now - held_since) >= GUARD_HOLD_US) release_bus();
}
void ug_handshake_guard_core1(void) {
    hardware_alarm_claim(2);
    irq_set_exclusive_handler(TIMER_IRQ_2, guard_irq);
    irq_set_priority(TIMER_IRQ_2, 0x00);
    timer_hw->intr = 1u << 2;
    timer_hw->alarm[2] = time_us_32() + GUARD_PERIOD_US;
    hw_set_bits(&timer_hw->inte, 1u << 2);
    irq_set_enabled(TIMER_IRQ_2, true);
    __atomic_store_n(&ready, true, __ATOMIC_RELEASE);
}
