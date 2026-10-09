/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  Ultra GS S0a PSRAM adapter.
 *  Serialized single-owner (core 1) access to the SPI PSRAM through the
 *  existing rp2040-psram PIO/DMA driver. The SPI PSRAM is NOT memory
 *  mapped; all access is bounded, chunked and error-checked here.
 */
#ifndef UG_PSRAM_H
#define UG_PSRAM_H

#include <stdint.h>
#include <stdbool.h>
#include "psram_spi.h"
#include "ug_render.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Max bytes per single backend transaction. Cache fills (256B) and
 * background ops must fit; adapter rejects anything larger. */
#define UG_PSRAM_CHUNK 256u

typedef struct ug_psram_s {
    psram_spi_inst_t spi;
    uint32_t divider256; /* actual 16.8 divider (truncated by SDK) */
    uint32_t pool_bytes;   /* declared test profile pool, NOT probed capacity */
    PIO pio;
    int sm;
    int dma_tx;            /* claimed DMA channel numbers, -1 = none */
    int dma_rx;
    int dma_async;
    int dma_crc;           /* claimed but unused: CRC sniffer reserve */
    bool fudge;            /* backend variant actually in use */
    bool up;
} ug_psram_t;

/* Init PIO SM + DMA channels (explicitly claimed by ug_hwmap before call).
 * pool_bytes = declared test pool; NOT proof of physical capacity.
 * CS/SCK/MOSI/MISO pins come from PSRAM_PIN_* build defines.
 * Returns 0 on success. */
int ug_psram_init(ug_psram_t *ps, PIO pio, int sm, float clkdiv,
                  uint32_t pool_bytes, bool fudge_first);

extern bool ug_psram_dma_fault;
int ug_psram_recover(ug_psram_t *ps);
int ug_psram_read_id(ug_psram_t *ps, uint8_t id[8]);
void ug_psram_uninit(ug_psram_t *ps);

/* Bounded ops: offset+len must be inside pool_bytes, len <= UG_PSRAM_CHUNK.
 * Return 0 on success, -1 on bounds/len/backend error. */
int ug_psram_read(ug_psram_t *ps, uint32_t offset, uint8_t *dst, uint32_t len);
int ug_psram_write(ug_psram_t *ps, uint32_t offset, const uint8_t *src,
                   uint32_t len);

/* Use driver's async TX channel, serializing its bounded staging chunks.
 * This spike wrapper returns only after all chunks AND final SPI/CS completion.
 * It is intentionally synchronous to the caller; no outstanding staging owns src. */
int ug_psram_write_async(ug_psram_t *ps, uint32_t offset, const uint8_t *src,
                         uint32_t len);
bool ug_psram_async_done(ug_psram_t *ps);

/* Quick bounded probe: write/read a few boundary addresses. Informational
 * only -- a passing probe does NOT prove the full pool is functional. */
int ug_psram_probe(ug_psram_t *ps);

#ifdef __cplusplus
}
#endif
#endif /* UG_PSRAM_H */
