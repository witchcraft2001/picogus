/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 */
#include "ug_audio.h"
#include "audio_i2s.pio.h"
#include "hardware/dma.h"
#include "hardware/irq.h"
#include "hardware/clocks.h"
#include "hardware/gpio.h"
#include "pico/sync.h"
#include "ug_hwmap.h"
#include <string.h>

/* pico-extras shifts MSB first: WS=0 (left) is the HIGH halfword. */
static uint32_t buf[UG_AUDIO_BUFS][UG_AUDIO_FRAMES];
static const uint32_t zero_frame[UG_AUDIO_FRAMES] = {0};

/* ring of buffer indices ready to arm; ISR (core1) consumes, the
 * renderer (also core1 mainline) produces. chan_buf[c] = index the
 * channel is currently playing, -1 = playing zero_frame. */
static volatile uint8_t q_head, q_tail;
static volatile uint8_t q_ring[UG_AUDIO_BUFS + 1u];
static volatile uint8_t free_mask = (1u << UG_AUDIO_BUFS) - 1;
static volatile uint8_t filling_mask;
static volatile int8_t chan_buf[2] = {-1, -1};
static volatile bool active;
static bool started;

static PIO a_pio;
static uint a_sm, a_ch0, a_ch1;
static uint32_t a_divider_q8;
static ug_audio_stats stats;

static inline uint ch_of(unsigned i) { return i ? a_ch1 : a_ch0; }

static void __isr __time_critical_func(ug_audio_isr)(void) {
    /* a channel completion means it finished a buffer and
     * chain-triggered its peer; refill the completed channel so it is
     * armed when the peer chains back to it */
    const uint32_t pending = dma_hw->ints0;
    for (unsigned i = 0; i < 2; i++) {
        uint ch = ch_of(i);
        if (!(pending & (1u << ch))) continue;
        dma_hw->ints0 = 1u << ch;
        if (chan_buf[i] >= 0) {
            free_mask |= 1u << (uint8_t)chan_buf[i];
            stats.played++;
            chan_buf[i] = -1;
        }
        stats.frames_out += UG_AUDIO_FRAMES;
        const uint32_t *src = zero_frame;
        if (q_head != q_tail) {
            uint8_t idx = q_ring[q_head];
            q_head = (uint8_t)((q_head + 1) % (UG_AUDIO_BUFS + 1u));
            src = buf[idx];
            chan_buf[i] = (int8_t)idx;
        } else if (active) {
            stats.underruns++;
        }
        dma_channel_set_read_addr(ch, src, false);
        dma_channel_set_trans_count(ch, UG_AUDIO_FRAMES, false);
        stats.cur_chan = (uint8_t)ch;
    }
    __dmb();
}

int ug_audio_init(PIO pio, uint sm, uint dma0, uint dma1,
                  uint data_pin, uint clk_pin_base, uint32_t rate) {
    if (rate != UG_AUDIO_RATE || dma0 == dma1) return -1;
    q_head = q_tail = filling_mask = 0;
    free_mask = (1u << UG_AUDIO_BUFS) - 1u;
    chan_buf[0] = chan_buf[1] = -1;
    active = started = false;
    memset(&stats, 0, sizeof(stats));
    a_pio = pio; a_sm = sm; a_ch0 = dma0; a_ch1 = dma1;
    uint gpio_func = (pio == pio1) ? GPIO_FUNC_PIO1 : GPIO_FUNC_PIO0;
    gpio_set_function(data_pin, gpio_func);
    gpio_set_function(clk_pin_base, gpio_func);
    gpio_set_function(clk_pin_base + 1, gpio_func);

    if (!pio_can_add_program(pio, &audio_i2s_program)) return -1;
    uint offset = pio_add_program(pio, &audio_i2s_program);
    ug_hw_note_program(pio, offset, audio_i2s_program.length, "audio_i2s");
    audio_i2s_program_init(pio, sm, offset, data_pin, clk_pin_base);

    /* divider: program emits 2 BCLK edges per instruction pair;
     * reuse the pico-extras formula divider = sysclk*4/rate (Q8). */
    uint32_t sysclk = clock_get_hz(clk_sys);
    uint32_t divider = sysclk * 4u / rate;
    a_divider_q8 = divider;
    pio_sm_set_clkdiv_int_frac(pio, sm, divider >> 8u, divider & 0xffu);

    for (unsigned i = 0; i < 2; i++) {
        uint ch = ch_of(i);
        dma_channel_config c = dma_channel_get_default_config(ch);
        channel_config_set_dreq(&c, pio_get_dreq(pio, sm, true));
        channel_config_set_transfer_data_size(&c, DMA_SIZE_32);
        channel_config_set_read_increment(&c, true);
        channel_config_set_write_increment(&c, false);
        channel_config_set_chain_to(&c, ch_of(i ^ 1));
        dma_channel_configure(ch, &c, &pio->txf[sm], zero_frame,
                              UG_AUDIO_FRAMES, false);
    }

    /* DMA_IRQ_0, priority 0x40, on this (core1) NVIC */
    irq_set_exclusive_handler(DMA_IRQ_0, ug_audio_isr);
    dma_irqn_set_channel_enabled(0, dma0, true);
    dma_irqn_set_channel_enabled(0, dma1, true);
    irq_set_priority(DMA_IRQ_0, UG_AUDIO_IRQ_PRIO);
    irq_set_enabled(DMA_IRQ_0, true);
    return 0;
}

void ug_audio_start(void) {
    if (started) return;
    uint32_t irq_state = save_and_disable_interrupts();
    /* arm ch0 with a queued buffer if any, else zero_frame */
    const uint32_t *src = zero_frame;
    if (q_head != q_tail) {
        uint8_t idx = q_ring[q_head];
        q_head = (q_head + 1) % (UG_AUDIO_BUFS + 1u);
        src = buf[idx];
        chan_buf[0] = (int8_t)idx;
    }
    dma_channel_set_read_addr(a_ch0, src, false);
    dma_channel_set_trans_count(a_ch0, UG_AUDIO_FRAMES, false);
    dma_channel_start(a_ch0);
    pio_sm_set_enabled(a_pio, a_sm, true);
    started = true;
    restore_interrupts(irq_state);
}

int ug_audio_buf_get(void) {
    uint32_t irq_state = save_and_disable_interrupts();
    int idx = -1;
    for (uint i = 0; i < UG_AUDIO_BUFS; i++) {
        if (free_mask & (1u << i)) {
            free_mask &= ~(1u << i);
            filling_mask |= 1u << i;
            idx = (int)i;
            break;
        }
    }
    restore_interrupts(irq_state);
    return idx;
}

void ug_audio_buf_push(int idx) {
    uint32_t irq_state = save_and_disable_interrupts();
    if (idx >= 0 && idx < (int)UG_AUDIO_BUFS &&
        (filling_mask & (1u << idx))) {
        filling_mask &= ~(1u << idx);
        q_ring[q_tail] = (uint8_t)idx;
        __dmb();
        q_tail = (q_tail + 1) % (UG_AUDIO_BUFS + 1u);
    }
    restore_interrupts(irq_state);
}

void ug_audio_set_active(bool running) {
    uint32_t irq_state = save_and_disable_interrupts();
    active = running;
    if (!running) {
        /* Retain DMA-owned buffers until completion, discard only queued data. */
        while (q_head != q_tail) {
            free_mask |= 1u << q_ring[q_head];
            q_head = (q_head + 1) % (UG_AUDIO_BUFS + 1u);
        }
    }
    restore_interrupts(irq_state);
}

void ug_audio_stats_copy(ug_audio_stats *out) {
    uint32_t irq_state = save_and_disable_interrupts();
    *out = stats;
    restore_interrupts(irq_state);
}

void ug_audio_finish(void) {
    uint32_t irq_state = save_and_disable_interrupts();
    active = false; /* EOF silence is expected; retain queued/in-flight buffers. */
    restore_interrupts(irq_state);
}

unsigned ug_audio_bufs_pending(void) {
    uint32_t irq_state = save_and_disable_interrupts();
    unsigned n = 0;
    for (unsigned i = 0; i < UG_AUDIO_BUFS; i++)
        if (!(free_mask & (1u << i))) n++;
    restore_interrupts(irq_state);
    return n;
}

uint32_t *ug_audio_buf_ptr(int idx) {
    return (idx >= 0 && idx < (int)UG_AUDIO_BUFS) ? buf[idx] : NULL;
}

const ug_audio_stats *ug_audio_get_stats(void) { return &stats; }

uint32_t ug_audio_divider_q8(void) { return a_divider_q8; }
uint32_t ug_audio_lrclk_hz(void) {
    /* SM runs sysclk/(div/256); one stereo frame = 64 SM instructions */
    return a_divider_q8 ? (clock_get_hz(clk_sys) * 4u) / a_divider_q8 : 0;
}

void ug_audio_resume_idle(void) {
    for(unsigned i=0;i<2;++i) {
        uint ch=ch_of(i);
        dma_channel_set_read_addr(ch,zero_frame,false);
        dma_channel_set_trans_count(ch,UG_AUDIO_FRAMES,false);
    }
    dma_channel_start(a_ch0);
}
