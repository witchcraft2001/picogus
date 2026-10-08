/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 * This program is distributed without any warranty; see the GNU General
 * Public License for more details.
 *
 * Finite S1 cycle guard. Alarm2 IRQ belongs exclusively to core1,
 * above I2S priority. Direct timer registers avoid a cross-core SDK lock.
 * Fatal release permanently disconnects both PIO SMs from the pads.
 */
#include "ug_diag_guard.h"
#include "ug_diag_wire.h"
#include "hardware/irq.h"
#include "hardware/pio.h"
#include "hardware/gpio.h"
#include "hardware/timer.h"
#include "hardware/sync.h"
#include "hardware/structs/timer.h"
#include "pico/stdlib.h"
#include "pico/platform.h"
#include <stdatomic.h>
static atomic_bool ready, failed, bus_started;
static atomic_uint cycle_pin, deadline;
static void release_bus(void) {
    atomic_store_explicit(&failed, true, memory_order_release);
    pio_sm_set_enabled(pio0, 0, false);
    pio_sm_set_enabled(pio0, 1, false);
    /* Driver OE uses the data-pin directions. SIO input precedes mux change. */
    for (unsigned pin = 6; pin < 16; pin++) {
        gpio_set_dir(pin, GPIO_IN);
        gpio_set_function(pin, GPIO_FUNC_SIO);
    }
    gpio_put(26, 0); /* board IOCHRDY inversion: zero releases */
    gpio_set_dir(26, GPIO_OUT);
    gpio_set_function(26, GPIO_FUNC_SIO);
    gpio_put(27, 0); /* restore address mux */
    gpio_set_dir(27, GPIO_OUT);
    gpio_set_function(27, GPIO_FUNC_SIO);
}
static void guard_irq(void) {
    timer_hw->intr = 1u << 2;
    unsigned pin = atomic_load_explicit(&cycle_pin, memory_order_acquire);
    uint32_t target = atomic_load_explicit(&deadline, memory_order_acquire);
    /* A late IRQ for the previous completed cycle must not trip a freshly
     * armed cycle. Deadline is published before pin and before alarm. */
    if ((int32_t)(time_us_32() - target) < 0) return;
    uint32_t completion_mask = 1u << (pin == 4 ? 1 : 0);
    if (!(pio0->irq & completion_mask) && !gpio_get(pin)) release_bus();
}
void ug_diag_guard_init_core1(void) {
    hardware_alarm_claim(2);
    irq_set_exclusive_handler(TIMER_IRQ_2, guard_irq);
    irq_set_priority(TIMER_IRQ_2, 0x00);
    timer_hw->intr = 1u << 2;
    hw_set_bits(&timer_hw->inte, 1u << 2);
    irq_set_enabled(TIMER_IRQ_2, true);
    atomic_store_explicit(&ready, true, memory_order_release);
}
bool ug_diag_guard_ready(void) { return atomic_load_explicit(&ready, memory_order_acquire); }
bool ug_diag_guard_failed(void) { return atomic_load_explicit(&failed, memory_order_acquire); }
void ug_diag_guard_arm(unsigned pin) {
    uint32_t target = time_us_32() + UGD_FUSE_US;
    atomic_store_explicit(&deadline, target, memory_order_release);
    atomic_store_explicit(&cycle_pin, pin, memory_order_release);
    __dmb();
    pio0->irq = 1u << (pin == 4 ? 1 : 0); /* W1C stale completion */
    timer_hw->intr = 1u << 2;
    timer_hw->alarm[2] = target;
}
bool ug_diag_guard_delay(uint16_t us) {
    uint32_t start = time_us_32();
    while ((uint32_t)(time_us_32() - start) < us) {
        if (ug_diag_guard_failed()) return false;
        tight_loop_contents();
    }
    return !ug_diag_guard_failed();
}
void ug_diag_guard_bus_started(void) {
    atomic_store_explicit(&bus_started, true, memory_order_release);
}
void ug_diag_guard_wait_bus(void) {
    while (!atomic_load_explicit(&bus_started, memory_order_acquire)) tight_loop_contents();
}
