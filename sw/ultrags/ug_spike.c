/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  S0a spike: 12 synthetic lanes with real PSRAM cache fills mixed to
 *  48kHz stereo and DMA'd to I2S, plus a bounded background PSRAM
 *  read/write loop for storage-contention measurement. This is NOT
 *  the final mixer -- deterministic synthetic sources only.
 */
#include "ug_spike.h"
#include "picogus.h"
#include "ug_profile.h"
#include "ug_psram.h"
#include "ug_audio.h"
#include "ug_hwmap.h"
#include "ug_diag_link.h"
#include "M62429.pio.h"
#include "hardware/clocks.h"
#include "hardware/irq.h"
#include "pico/time.h"
#include "pico/stdlib.h"
#include <string.h>

static ug_mixer mixer;
static ug_psram_t psram;
static ug_diag_status published;
static uint32_t bg_addr = 0x400000u;
static bool bg_read;
extern uint8_t BOARD_TYPE;
void ug_diag_isa_stats(uint32_t *iow, uint32_t *ior);

static int mem_read(void *ctx, uint32_t off, uint8_t *dst, uint32_t len) {
    return ug_psram_read(ctx, off, dst, len);
}
static int mem_write(void *ctx, uint32_t off, const uint8_t *src, uint32_t len) {
    return ug_psram_write(ctx, off, src, len);
}

/* One bounded storage operation per scheduler turn, always after rendering. */
static void bg_step(void) {
    uint8_t expected[256], actual[256];
    for (unsigned i = 0; i < sizeof(expected); i++)
        expected[i] = (uint8_t)(i * 37u + (bg_addr >> 8));
    int rc;
    if (!bg_read) rc = ug_psram_write(&psram, bg_addr, expected, sizeof(expected));
    else rc = ug_psram_read(&psram, bg_addr, actual, sizeof(actual)) ||
              memcmp(expected, actual, sizeof(expected));
    if (rc) published.bg_errors++;
    else published.bg_bytes += sizeof(expected);
    if (bg_read) {
        bg_addr += sizeof(expected);
        if (bg_addr >= 0x500000u) bg_addr = 0x400000u;
    }
    bg_read = !bg_read;
}

static bool render_quantum(void) {
    int idx = ug_audio_buf_get();
    if (idx < 0) return false;
    int16_t samples[2 * UG_AUDIO_FRAMES];
    uint32_t *dst = ug_audio_buf_ptr(idx);
    uint64_t start = time_us_64();
    ug_mixer_render(&mixer, samples, UG_AUDIO_FRAMES);
    for (unsigned i = 0; i < UG_AUDIO_FRAMES; i++)
        dst[i] = ug_audio_pack_frame(samples[2 * i], samples[2 * i + 1]);
    uint32_t elapsed = (uint32_t)(time_us_64() - start);
    if (elapsed > published.render_max_us) published.render_max_us = elapsed;
    published.render_sum_us += elapsed;
    ug_audio_buf_push(idx);
    published.quanta++;
    published.frames = mixer.stats.frames;
    published.cache_fills = mixer.stats.cache_fills;
    published.cache_misses = mixer.stats.cache_fills;
    published.fetch_errors = mixer.stats.fetch_errors;
    published.out_checksum = mixer.stats.checksum;
    return true;
}

void ug_spike_link_init(void) { ug_diag_link_init(); }
uint8_t ug_spike_cmd(uint8_t cmd, uint16_t quanta) {
    if (cmd < 1 || cmd > 3) return UGD_CMD_BAD_ARGUMENT;
    return ug_diag_link_send(cmd, quanta) ? UGD_CMD_OK : UGD_CMD_BUSY;
}
bool ug_spike_status(ug_diag_status *out) { return ug_diag_link_snapshot(out); }
void ug_spike_publish(void) {
    uint32_t iow, ior;
    published.board_type = BOARD_TYPE;
    ug_diag_isa_stats(&iow, &ior);
    published.iow_count = iow;
    published.ior_count = ior;
    ug_diag_link_publish(&published);
}

static void fault(void) {
    ug_audio_set_active(false);
    published.state = UGD_STATE_ERR;
    ug_spike_publish();
    for (;;) tight_loop_contents();
}

void ug_spike_core1(void) {
    irq_set_enabled(PIO0_IRQ_1, false);
    memset(&published, 0, sizeof(published));
    published.magic0 = UG_DIAG_MAGIC0;
    published.magic1 = UG_DIAG_MAGIC1;
    published.version = UG_DIAG_VERSION;
    published.sys_clk_khz = clock_get_hz(clk_sys) / 1000;

    /* Reserve audio DMA first; dynamic driver claims must then be 2/3/4. */
    ug_hw_claim_audio();
    if (ug_audio_init(pio1, UG_I2S_SM, UG_DMA_I2S0, UG_DMA_I2S1,
                      PICO_AUDIO_I2S_DATA_PIN, PICO_AUDIO_I2S_CLOCK_PIN_BASE,
                      UG_AUDIO_RATE)) fault();
    ug_audio_start(); /* One start only: continuous digital silence even at idle. */

    bool first_fudge = BOARD_TYPE != PICOGUS_2;
    bool memory_ok = false;
    for (unsigned attempt = 0; attempt < 2; attempt++) {
        ug_hw_claim_psram_sm();
        if (ug_psram_init(&psram, pio1, UG_PSRAM_SM,
                          (float)clock_get_hz(clk_sys) / 200000000.0f,
                          UG_SPIKE_POOL_BYTES, first_fudge ^ (attempt != 0))) fault();
        if (ug_hw_psram_dma_check(psram.dma_tx, psram.dma_rx, psram.dma_async)) fault();
        if (ug_psram_probe(&psram) == 0) { memory_ok = true; break; }
        ug_psram_uninit(&psram); /* Stops SM/DMA and removes the old PIO program. */
    }
    if (!memory_ok) fault();
    published.psram_backend = psram.fudge ? 2 : 1;
    published.psram_pool_bytes = psram.pool_bytes; /* Declared, not measured capacity. */
    published.i2s_div_q8 = ug_audio_divider_q8();
    published.lrclk_hz = ug_audio_lrclk_hz();
    ug_mem_if mem = {mem_read, mem_write, &psram, psram.pool_bytes};
    if (ug_profile_load(mem)) fault();
    published.res_faults = ug_hw_audit(BOARD_TYPE == PICOGUS_2);
    if (published.res_faults) fault();
    published.flags = 1u | (BOARD_TYPE == PICOGUS_2 ? 2u : 0u);
    published.state = UGD_STATE_IDLE;
    ug_spike_publish();

    uint32_t left = 0, underrun_base = 0;
    for (;;) {
        uint8_t cmd;
        uint16_t arg;
        if (ug_diag_link_take(&cmd, &arg)) {
            ug_audio_set_active(false);
            if (cmd == 3) published.state = UGD_STATE_IDLE;
            else {
                if (ug_profile_setup(&mixer, mem, cmd)) fault();
                published.profile = cmd;
                published.quanta = published.frames = 0;
                published.render_max_us = published.render_sum_us = 0;
                published.bg_bytes = published.bg_errors = published.underruns = 0;
                bg_addr = 0x400000u; bg_read = false;
                left = arg ? arg : 24000u; /* 64 seconds at 48k, sufficient for C00. */
                ug_audio_stats audio;
                ug_audio_stats_copy(&audio);
                underrun_base = audio.underruns;
                published.state = UGD_STATE_RUN;
                /* Prefill available buffers before counting missing READY buffers. */
                for (unsigned i = 0; i < UG_AUDIO_BUFS && left; i++)
                    if (render_quantum()) left--;
                if (left) ug_audio_set_active(true);
                else ug_audio_finish(); /* Short runs may finish entirely in prefill. */
            }
            ug_spike_publish();
        }
        if (published.state == UGD_STATE_RUN) {
            if (left && render_quantum()) left--;
            if (!left) ug_audio_finish();
            ug_audio_stats audio;
            ug_audio_stats_copy(&audio);
            published.underruns = audio.underruns - underrun_base;
            if (!left) {
                /* Let the final queued buffers complete; STOP drops them explicitly. */
                if (ug_audio_bufs_pending() == 0) {
                    ug_audio_set_active(false);
                    published.state = UGD_STATE_DONE;
                }
            } else bg_step();
        }
        ug_spike_publish();
        tight_loop_contents();
    }
}
