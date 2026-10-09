/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 */
#include "ug_psram.h"
#include "pico/stdlib.h"
#include "hardware/dma.h"
#include "hardware/gpio.h"
#include "ug_hwmap.h"
#include <string.h>

/* The rp2040-psram SPI program stores bit counts in 8-bit fields, so one
 * CS window can move at most 31 payload bytes on read (31*8<=255) and
 * 27 on write ((4+27)*8<=255). Adapter calls of up to UG_PSRAM_CHUNK
 * bytes are split into sub-transactions here; each sub-transaction
 * carries its own command+address so stays bounded. */
#define UG_SPI_READ_MAX  31u
#define UG_SPI_WRITE_MAX 27u
#ifdef PSRAM_ASYNC
psram_spi_inst_t *async_spi_inst;
#endif

/* Even a failed peripheral cannot hold core1 indefinitely. Timer is free
 * running; a second iteration bound also covers a broken host timer mock. */
bool ug_psram_dma_fault;
void ug_psram_dma_wait(unsigned channel) {
    uint32_t start=time_us_32(); unsigned budget=100000;
    while(dma_channel_is_busy(channel)) {
        if((uint32_t)(time_us_32()-start)>=2000 || !--budget) {
            ug_psram_dma_fault=true; dma_channel_abort(channel);
            __compiler_memory_barrier();
            return;
        }
        tight_loop_contents();
    }
    /* Preserve the SDK wait's DMA-buffer ordering guarantee, including
     * builds where whole-program optimization can see this wrapper. */
    __compiler_memory_barrier();
}
static int completion(ug_psram_t *ps) {
    uint32_t start=time_us_32(); unsigned budget=100000;
    while(!ug_psram_async_done(ps)) {
        if(ug_psram_dma_fault || (uint32_t)(time_us_32()-start)>=2000 || !--budget) {
            ug_psram_dma_fault=true;
            pio_sm_set_enabled(ps->pio,ps->sm,false);
            dma_channel_abort(ps->dma_tx); dma_channel_abort(ps->dma_rx);
            if(ps->dma_async>=0) dma_channel_abort(ps->dma_async);
            return -1;
        }
        tight_loop_contents();
    }
    return ug_psram_dma_fault?-1:0;
}
int ug_psram_init(ug_psram_t *ps, PIO pio, int sm, float clkdiv,
                  uint32_t pool_bytes, bool fudge_first) {
    if (!ps || sm < 0 || sm > 3 || !pool_bytes || pool_bytes > (8u << 20) ||
        !(clkdiv >= 1.0f && clkdiv < 65536.0f) ||
        !pio_sm_is_claimed(pio,sm) ||
        dma_channel_is_claimed(UG_DMA_PSRAM_TX) ||
        dma_channel_is_claimed(UG_DMA_PSRAM_RX) ||
        dma_channel_is_claimed(UG_DMA_PSRAM_ASYNC) ||
        !pio_can_add_program(pio, fudge_first ? &spi_psram_fudge_program :
                                               &spi_psram_program)) return -1;
    memset(ps, 0, sizeof(*ps));
    ps->pio = pio;
    ps->sm = sm;
    ps->pool_bytes = pool_bytes;
    ps->dma_tx = ps->dma_rx = ps->dma_async = ps->dma_crc = -1;
    ps->fudge = fudge_first;
    ug_psram_dma_fault=false;
    ps->divider256=(uint32_t)(clkdiv*256.0f);
    ps->spi = psram_spi_init_clkdiv(pio, sm, clkdiv, fudge_first);
    ug_hw_note_program(pio, ps->spi.offset,
                      fudge_first ? spi_psram_fudge_program.length :
                                    spi_psram_program.length, "psram");
    ps->dma_tx = ps->spi.write_dma_chan;
    ps->dma_rx = ps->spi.read_dma_chan;
#ifdef PSRAM_ASYNC
    ps->dma_async = ps->spi.async_dma_chan;
#endif
    ps->up = true;
    return completion(ps);
}

void ug_psram_uninit(ug_psram_t *ps) {
    if (!ps || !ps->up) return;
    (void)completion(ps);
    pio_sm_set_enabled(ps->pio, ps->sm, false);
    dma_channel_abort(ps->dma_tx);
    dma_channel_abort(ps->dma_rx);
    if (ps->dma_async >= 0) dma_channel_abort(ps->dma_async);
    ug_hw_forget_program(ps->pio, ps->spi.offset);
    psram_spi_uninit(ps->spi, ps->fudge);
    ps->up = false;
}

static int ug_bounds(const ug_psram_t *ps, uint32_t offset, uint32_t len) {
    return (!ps->up || !len || len > UG_PSRAM_CHUNK ||
            offset >= ps->pool_bytes || len > ps->pool_bytes - offset)
               ? -1 : 0;
}

int ug_psram_read(ug_psram_t *ps, uint32_t offset, uint8_t *dst,
                  uint32_t len) {
    if (!ps || !dst || ug_bounds(ps, offset, len)) return -1;
    if(completion(ps)) return -1;
    while (len) {
        uint32_t n = len > UG_SPI_READ_MAX ? UG_SPI_READ_MAX : len;
        if(n>1024-(offset&1023)) n=1024-(offset&1023);
        psram_read(&ps->spi, offset, dst, n);
        if(completion(ps)) return -1;
        offset += n; dst += n; len -= n;
    }
    return 0;
}

int ug_psram_write(ug_psram_t *ps, uint32_t offset, const uint8_t *src,
                   uint32_t len) {
    if (!ps || !src || ug_bounds(ps, offset, len)) return -1;
    if(completion(ps)) return -1;
    while (len) {
        uint32_t n = len > UG_SPI_WRITE_MAX ? UG_SPI_WRITE_MAX : len;
        if(n>1024-(offset&1023)) n=1024-(offset&1023);
        psram_write(&ps->spi, offset, src, n);
        if(completion(ps)) return -1;
        offset += n; src += n; len -= n;
    }
    return 0;
}

int ug_psram_write_async(ug_psram_t *ps, uint32_t offset, const uint8_t *src,
                         uint32_t len) {
#ifndef PSRAM_ASYNC
    return ug_psram_write(ps, offset, src, len);
#else
    if (!ps || !src || ug_bounds(ps, offset, len) || ps->dma_async < 0) return -1;
    if(completion(ps)) return -1;
    while (len) {
        uint32_t n = len > UG_SPI_WRITE_MAX ? UG_SPI_WRITE_MAX : len;
        if(n>1024-(offset&1023)) n=1024-(offset&1023);
        /* psram_write_async_fast uses the driver's static staging
         * (134B cap); caller must await ug_psram_async_done() between
         * chunks anyway so the staging is safe to reuse. */
        psram_write_async_fast(&ps->spi, offset, (uint8_t *)src, n);
        if(completion(ps)) return -1;
        offset += n; src += n; len -= n;
    }
    return 0;
#endif
}

bool ug_psram_async_done(ug_psram_t *ps) {
    if (!ps || !ps->up) return false;
    if (dma_channel_is_busy(ps->dma_tx) || dma_channel_is_busy(ps->dma_rx) ||
        (ps->dma_async >= 0 && dma_channel_is_busy(ps->dma_async))) return false;
    /* FIFO empty alone can still leave bits in OSR. At begin, the SPI
     * program has deasserted CS and stalls waiting for a NEW command. */
    if (!pio_sm_is_tx_fifo_empty(ps->pio, ps->sm)) return false;
    return pio_sm_get_pc(ps->pio, ps->sm) == ps->spi.offset &&
           gpio_get(PSRAM_PIN_CS) != 0;
}

int ug_psram_probe(ug_psram_t *ps) {
    /* Bounded probe at the first bytes of each 1MiB region inside the
     * declared pool. A pass here is NOT a capacity proof: marking,
     * SCK limit and full-region coverage stay REAL-pending. */
    uint8_t pat[8], rb[8];
    for (uint32_t off = 0; off < ps->pool_bytes; off += (1u << 20)) {
        for (unsigned i = 0; i < sizeof(pat); i++)
            pat[i] = (uint8_t)(0xa5u ^ i ^ (off >> 20));
        if (ug_psram_write(ps, off, pat, sizeof(pat)) != 0) return -1;
    }
    /* Read after ALL writes: distinguish quick boundary aliasing. This
     * remains a small destructive startup check, not a full capacity test. */
    for (uint32_t off = 0; off < ps->pool_bytes; off += (1u << 20)) {
        for (unsigned i = 0; i < sizeof(pat); i++)
            pat[i] = (uint8_t)(0xa5u ^ i ^ (off >> 20));
        if (ug_psram_read(ps, off, rb, sizeof(rb)) != 0) return -1;
        if (memcmp(rb, pat, sizeof(pat)) != 0) return -2;
    }
    return 0;
}

int ug_psram_read_id(ug_psram_t *ps,uint8_t id[8]) {
    if(!ps || !ps->up || completion(ps)) return -1;
    const uint8_t command[]={32,64,0x9f,0,0,0};
    pio_spi_write_read_dma_blocking(&ps->spi,command,sizeof(command),id,8);
    return completion(ps);
}

int ug_psram_recover(ug_psram_t *ps) {
    if(!ps || !ps->divider256) return -1;
    PIO pio=ps->pio; int sm=ps->sm; bool fudge=ps->fudge;
    float divider=(float)ps->divider256/256.0f;
    uint32_t pool=ps->pool_bytes;
    ug_psram_uninit(ps);
    if(pio_sm_is_claimed(pio,sm)) return -1;
    pio_sm_claim(pio,sm);
    int status=ug_psram_init(ps,pio,sm,divider,pool,fudge);
    /* Startup may have failed before its DMA audit/reserve step. Recovery
     * must establish the same resource map, including the CRC reserve. */
    if(!status) status=ug_hw_psram_dma_check(ps->dma_tx,ps->dma_rx,ps->dma_async);
    return status;
}
