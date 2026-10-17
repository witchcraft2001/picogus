/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  Ultra GS S0a I2S output: 48 kHz stereo S16, 128-frame quanta,
 *  DMA0/1 ping-pong into PIO1 SM3 TX fifo, DMA_IRQ_0 on core 1.
 *  Modelled on sw/audio/audio_i2s_minimal.c + pico-extras DMA wiring.
 */
#ifndef UG_AUDIO_H
#define UG_AUDIO_H

#include <stdint.h>
#include <stdbool.h>
#include "hardware/pio.h"

#ifdef __cplusplus
extern "C" {
#endif

#define UG_AUDIO_RATE    48000u
#define UG_AUDIO_FRAMES  128u              /* frames per quantum/buffer */
#define UG_AUDIO_BUFS    3u                /* minimum 3 data buffers */
#define UG_AUDIO_IRQ_PRIO 0x40u            /* DMA_IRQ_0 priority on core1 */

typedef struct {
    volatile uint32_t underruns;
    volatile uint32_t played;      /* buffers consumed by DMA */
    volatile uint32_t frames_out;
    volatile uint8_t  cur_chan;
} ug_audio_stats;

/* Set up PIO SM + DMA0/1. Call on core1 before starting the render loop.
 * sm/dma channels must already be claimed via ug_hw_claim_audio().
 * Returns 0 on success. */
int ug_audio_init(PIO pio, uint sm, uint dma0, uint dma1,
                  uint data_pin, uint clk_pin_base, uint32_t rate);

/* Start DMA ch0 (ch1 follows via chain). Call after at least one
 * buffer has been pushed, or it plays the zero frame first. */
void ug_audio_start(void);
/* Drop queued data on STOP; in-flight buffers remain owned until completion.
 * Idle silence does not count as an underrun. DMA and I2S keep running. */
void ug_audio_set_active(bool running);
void ug_audio_stats_copy(ug_audio_stats *out);
unsigned ug_audio_bufs_pending(void);
void ug_audio_finish(void);

static inline uint32_t ug_audio_pack_frame(int16_t left, int16_t right) {
    return ((uint32_t)(uint16_t)left << 16) | (uint16_t)right;
}

/* Producer side (core1 mainline): returns index of a free buffer to fill,
 * or -1 if all are queued/playing. */
int ug_audio_buf_get(void);
/* Publish a filled buffer (index from ug_audio_buf_get). */
void ug_audio_buf_push(int idx);
/* Writable pointer only while idx is FILLING. READY/DMA ownership is immutable. */
uint32_t *ug_audio_buf_ptr(int idx);

const ug_audio_stats *ug_audio_get_stats(void);
uint32_t ug_audio_divider_q8(void);   /* SM clkdiv, Q8 */
uint32_t ug_audio_lrclk_hz(void);     /* derived sample rate */

#ifdef __cplusplus
}
#endif
#endif /* UG_AUDIO_H */
#ifdef __cplusplus
extern "C" {
#endif
/* Idle maintenance only: channels must be aborted before returning ownership. */
void ug_audio_resume_idle(void);
#ifdef __cplusplus
}
#endif
