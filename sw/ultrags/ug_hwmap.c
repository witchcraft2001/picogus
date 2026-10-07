/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 */
#include "ug_hwmap.h"
#include "isa_io.pio.h"
#include <string.h>

enum { WANT_FREE = 0, WANT_CLAIMED = 1, WANT_RESERVED = 2 };

/* The plan, one row per SM/DMA channel actually used or reserved.
 * Rows not listed are expected free and are audited as such. */
static ug_res_entry table[] = {
    {"iow",     0, 0, WANT_CLAIMED,  0, "ISA IOW capture (core0)"},
    {"ior",     0, 1, WANT_CLAIMED,  0, "ISA IOR capture (core0)"},
    {"pio0sm2", 0, 2, WANT_FREE,     0, "reserved (ISA DMA in GUS/SB modes)"},
    {"pio0sm3", 0, 3, WANT_FREE,     0, "free"},
    {"m62429",  1, 0, WANT_FREE,     0, "M62429 vol (PICOGUS_2 only)"},
    {"psram",   1, 1, WANT_CLAIMED,  0, "PSRAM SPI engine (core1)"},
    {"pio1sm2", 1, 2, WANT_FREE,     0, "reserved"},
    {"i2s",     1, 3, WANT_CLAIMED,  0, "I2S audio out (core1)"},
    /* DMA rows (bank field unused) */
    {"i2s0",    0, 0, WANT_CLAIMED,  0, "I2S TX ping (core1)"},
    {"i2s1",    0, 1, WANT_CLAIMED,  0, "I2S TX pong (core1)"},
    {"psramtx", 0, 2, WANT_CLAIMED,  0, "PSRAM DMA write (driver-claimed)"},
    {"psramrx", 0, 3, WANT_CLAIMED,  0, "PSRAM DMA read (driver-claimed)"},
    {"psramas", 0, 4, WANT_RESERVED, 0, "PSRAM async TX (driver-claimed, PSRAM_ASYNC)"},
    {"crc5",    0, 5, WANT_RESERVED, 0, "reserved: CRC sniffer (S0a stub)"},
};
#define N_PIO_ROWS 8
#define N_ROWS (sizeof(table) / sizeof(table[0]))

/* program registry for instruction-space accounting */
static struct { PIO pio; uint off, len; const char *name; } progs[8];
static unsigned n_progs;
static int psram_tx_seen = -1, psram_rx_seen = -1, psram_async_seen = -1;

void ug_hw_claim_isa(void) {
    pio_sm_claim(pio0, UG_IOW_SM);
    pio_sm_claim(pio0, UG_IOR_SM);
}

int ug_hw_claim_m62429(PIO pio) {
    if (pio_sm_is_claimed(pio, UG_M62429_SM)) return -1;
    pio_sm_claim(pio, UG_M62429_SM);
    table[4].want = WANT_CLAIMED;
    table[4].owner = "M62429 vol (PICOGUS_2)";
    return 0;
}

/* I2S DMA claims run BEFORE psram_spi_init so the driver's
 * dma_claim_unused_channel() lands on the planned 2/3(/4). */
void ug_hw_claim_audio(void) {
    pio_sm_claim(pio1, UG_I2S_SM);
    dma_channel_claim(UG_DMA_I2S0);
    dma_channel_claim(UG_DMA_I2S1);
}

void ug_hw_claim_psram_sm(void) {
    pio_sm_claim(pio1, UG_PSRAM_SM);
}

/* Called after psram_spi_init with the channels the driver actually
 * claimed; verifies them against the plan and reserves the rest. */
int ug_hw_psram_dma_check(int tx, int rx, int async_chan) {
    psram_tx_seen = tx;
    psram_rx_seen = rx;
    psram_async_seen = async_chan;
    if (tx != UG_DMA_PSRAM_TX || rx != UG_DMA_PSRAM_RX ||
        (async_chan >= 0 && async_chan != UG_DMA_PSRAM_ASYNC)) return -1;
    if (async_chan < 0) {
        /* async channel unused: claim as reserve per the map */
        if (!dma_channel_is_claimed(UG_DMA_PSRAM_ASYNC))
            dma_channel_claim(UG_DMA_PSRAM_ASYNC);
    }
    if (!dma_channel_is_claimed(UG_DMA_CRC)) dma_channel_claim(UG_DMA_CRC);
    return 0;
}

uint32_t ug_hw_audit(bool m62429_present) {
    uint32_t faults = 0;
    for (unsigned i = 0; i < N_PIO_ROWS; i++) {
        ug_res_entry *e = &table[i];
        if (i == 4 && m62429_present) e->want = WANT_CLAIMED;
        PIO p = e->bank ? pio1 : pio0;
        bool claimed = pio_sm_is_claimed(p, e->index);
        e->actual = claimed ? 1 : 0;
        if (e->want == WANT_FREE && claimed) faults |= 1u << i;
        if (e->want == WANT_CLAIMED && !claimed) faults |= 1u << i;
    }
    for (unsigned i = N_PIO_ROWS; i < N_ROWS; i++) {
        ug_res_entry *e = &table[i];
        bool claimed = dma_channel_is_claimed(e->index);
        e->actual = claimed ? 1 : 0;
        bool want = e->want != WANT_FREE;
        if (claimed != want) faults |= 1u << (i + 8);
    }
    /* PSRAM driver's dynamic claims must match the plan */
    if (psram_tx_seen != UG_DMA_PSRAM_TX ||
        psram_rx_seen != UG_DMA_PSRAM_RX ||
        (psram_async_seen >= 0 && psram_async_seen != UG_DMA_PSRAM_ASYNC))
        faults |= 1u << 22;
    for (unsigned ch = 6; ch < NUM_DMA_CHANNELS; ch++)
        if (dma_channel_is_claimed(ch)) faults |= 1u << 23;
    return faults;
}

const ug_res_entry *ug_hw_table(unsigned *count) {
    *count = N_ROWS;
    return table;
}

void ug_hw_note_program(PIO pio, uint offset, uint length,
                        const char *name) {
    hard_assert(length && offset < 32 && length <= 32 - offset);
    uint32_t mask = length == 32 ? UINT32_MAX : ((1u << length) - 1u) << offset;
    hard_assert(!(ug_hw_pio_used(pio) & mask));
    hard_assert(n_progs < sizeof(progs) / sizeof(progs[0]));
    if (n_progs < sizeof(progs) / sizeof(progs[0])) {
        progs[n_progs].pio = pio;
        progs[n_progs].off = offset;
        progs[n_progs].len = length;
        progs[n_progs].name = name;
        n_progs++;
    }
}

void ug_hw_forget_program(PIO pio, uint offset) {
    for (unsigned i = 0; i < n_progs; i++) {
        if (progs[i].pio == pio && progs[i].off == offset) {
            progs[i] = progs[--n_progs];
            return;
        }
    }
    hard_assert(false);
}

uint32_t ug_hw_pio_used(PIO pio) {
    uint32_t used = 0;
    for (unsigned i = 0; i < n_progs; i++)
        if (progs[i].pio == pio)
            used |= ((progs[i].len >= 32 ? 0xFFFFFFFFu
                                         : ((1u << progs[i].len) - 1))
                     << progs[i].off);
    return used;
}
