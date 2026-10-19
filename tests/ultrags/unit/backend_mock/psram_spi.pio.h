/* SPDX-License-Identifier: GPL-2.0-or-later
 * Model the peripheral boundary, not electrical PIO timing. The real pinned
 * psram_spi.c/.h execute their init, DMA calls, command packing and teardown.
 */
#pragma once
#include "sdk_mock.h"
static const struct pio_program spi_psram_program={.length=9};
static const struct pio_program spi_psram_fudge_program={.length=10};
void backend_sm_init(PIO p,uint sm,uint offset);
void backend_clock_init(float divider);
static inline void pio_spi_psram_cs_init(PIO p,uint sm,uint off,uint bits,
                                       float div,bool fudge,uint cs,uint mosi,uint miso) {
    assert(bits==8 && div>=1 && cs==1 && mosi==3 && miso==0);
    (void)fudge; backend_sm_init(p,sm,off);backend_clock_init(div);
}
