/* SPDX-License-Identifier: GPL-2.0-or-later
 * Shared baseline bus transceiver/pull initialization.
 * Extracted from sw/picogus.cpp; retain upstream timing and polarity.
 */
#ifndef ISA_BUS_H
#define ISA_BUS_H
#include "pico/stdlib.h"
static inline void isa_bus_prepare(uint ad0, uint iow, uint ior,
                                   uint ready, uint ads) {
    for (uint i = ad0; i < ad0 + 10; i++) gpio_disable_pulls(i);
    gpio_disable_pulls(iow);
    gpio_disable_pulls(ior);
    gpio_pull_down(ready);
    gpio_set_dir(ready, GPIO_OUT);
    gpio_init(ads);
    gpio_set_dir(ads, GPIO_OUT);
    gpio_put(ads, 1);
    busy_wait_ms(10);
    gpio_put(ads, 0);
    gpio_set_slew_rate(ads, GPIO_SLEW_RATE_FAST);
}
#endif
