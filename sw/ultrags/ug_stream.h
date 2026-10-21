/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#pragma once
#include "ug_render.h"
/* Core1 owns this ring and its two interpolation taps. consumed counts frames
 * retired from PSRAM; position counts frames played. Cached taps remain in SRAM
 * when their PSRAM slots are reused, including a one-frame ring. */
typedef struct {
    uint64_t published, consumed, position;
    uint32_t capacity, prefill, low, offset, read_offset, write_offset;
    uint32_t fraction, residue, next_sequence, underruns;
    uint32_t cache_offset, cache_length;
    uint8_t cache[256];
    int16_t tap[2][2];
    uint8_t have_first, have_next, eof, buffering, started, error;
    uint64_t step;
    uint32_t rate, step_remainder;
    uint8_t channels, bits, sample_format, frame_bytes;
} ug_stream;
int ug_stream_init(ug_stream *s,uint32_t offset,uint32_t capacity,
                   uint32_t prefill,uint32_t low,uint32_t rate,
                   uint8_t channels,uint8_t bits,uint8_t sample_format);
uint32_t ug_stream_fill(const ug_stream *s);
uint32_t ug_stream_free(const ug_stream *s);
/* Called only after all SPI writes of one whole-frame packet complete. */
void ug_stream_publish(ug_stream *s,uint32_t bytes);
/* Source PCM -> stereo S16/48k. Produces silence while buffering, preserves taps,
 * exact phase and stereo alignment. Returns true at drained EOF. */
bool ug_stream_render(ug_stream *s,ug_mem_if mem,int16_t *out,uint32_t frames);
