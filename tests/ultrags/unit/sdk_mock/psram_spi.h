/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "sdk_mock.h"
typedef struct { PIO pio; int sm; uint offset; int write_dma_chan, read_dma_chan, async_dma_chan; } psram_spi_inst_t;
static const struct pio_program spi_psram_program = {.length=9};
static const struct pio_program spi_psram_fudge_program = {.length=10};
psram_spi_inst_t psram_spi_init_clkdiv(PIO p, int sm, float div, bool fudge);
void psram_spi_uninit(psram_spi_inst_t s, bool fudge);
void psram_read(psram_spi_inst_t *s, uint32_t off, uint8_t *dst, uint32_t n);
void psram_write(psram_spi_inst_t *s, uint32_t off, const uint8_t *src, uint32_t n);
void psram_write_async_fast(psram_spi_inst_t *s, uint32_t off, uint8_t *src, uint32_t n);

void pio_spi_write_read_dma_blocking(psram_spi_inst_t *,const uint8_t *,size_t,uint8_t *,size_t);
