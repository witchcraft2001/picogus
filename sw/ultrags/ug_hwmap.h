/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  Ultra GS hardware resource map (S0a diagnostic build).
 *  Mirrors the allocation table in ultra-gs.md S0a: PIO SMs, DMA
 *  channels, IRQs, clocks. Each claim here is explicit (never
 *  "claim_unused") so the runtime audit can detect drift from the
 *  documented plan.
 */
#ifndef UG_HWMAP_H
#define UG_HWMAP_H

#include <stdint.h>
#include <stdbool.h>
#include "hardware/pio.h"
#include "hardware/dma.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Allocation per ultra-gs.md resource map */
#define UG_IOW_SM      0   /* pio0 sm0 */
#define UG_IOR_SM      1   /* pio0 sm1 */
/* UG_LED_DIAG only: alarm1 / TIMER_IRQ_1 on core0 drives GPIO25;
 * default SDK alarm pool remains alarm3; core1 fuse remains alarm2. */
/* HANDSHAKE: a shared 32-word program serves pio0 SM0/SM1.
 * Timer alarm2 / TIMER_IRQ_2 belong to core1, priority 0x00, for the ISA fuse.
 * Core0 counts serviced responses / WAIT releases; ignored captures are
 * not completions. No extra SM, PIO IRQ or DMA channel is used. */
#define UG_M62429_SM   0   /* pio1 sm0 (PICOGUS_2 only) */
#define UG_PSRAM_SM    1   /* pio1 sm1 */
#define UG_I2S_SM      3   /* pio1 sm3 */

#define UG_DMA_I2S0    0   /* I2S TX ping */
#define UG_DMA_I2S1    1   /* I2S TX pong */
#define UG_DMA_PSRAM_TX   2
#define UG_DMA_PSRAM_RX   3
#define UG_DMA_PSRAM_ASYNC 4 /* reserved for async TX (unused in S0a) */
#define UG_DMA_CRC     5   /* reserved: CRC sniffer (not implemented) */

typedef struct {
    const char *name;
    uint8_t bank;      /* 0=pio0,1=pio1 */
    uint8_t index;     /* sm or dma channel */
    uint8_t want;      /* 0 free, 1 claimed, 2 reserved-claimed */
    uint8_t actual;    /* filled by audit */
    const char *owner;
} ug_res_entry;

/* Claims. Order matters: audio DMA 0/1 first, then PSRAM SM, then the
 * driver init lands its dynamic DMA claims on 2/3(/4); DMA5 = CRC
 * reserve claimed in ug_hw_psram_dma_check. */
void ug_hw_claim_isa(void);
int  ug_hw_claim_m62429(PIO pio);          /* PICOGUS_2 boards only */
void ug_hw_claim_psram_sm(void);
void ug_hw_claim_audio(void);
/* Post-init check of the driver's dynamic DMA claims; reserves DMA5. */
int  ug_hw_psram_dma_check(int tx, int rx, int async_chan);

/* Runtime audit: compares claim state with the plan, fills table.
 * Returns bitmask of mismatches (0 = clean). */
uint32_t ug_hw_audit(bool m62429_present);

const ug_res_entry *ug_hw_table(unsigned *count);

/* PIO instruction-memory accounting, filled at program-load time. */
void ug_hw_note_program(PIO pio, uint offset, uint length,
                        const char *name);
void ug_hw_forget_program(PIO pio, uint offset);
uint32_t ug_hw_pio_used(PIO pio);          /* bitmask of used slots */

#ifdef __cplusplus
}
#endif
#endif /* UG_HWMAP_H */
