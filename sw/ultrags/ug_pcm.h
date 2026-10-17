/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <stdint.h>
#include <stdbool.h>

typedef struct {
    uint32_t rate, data_offset, data_length, frames, loop_start, loop_end;
    uint8_t channels, bits, sample_format, flags;
} ug_pcm_info;

typedef int (*ug_pcm_read_fn)(void *ctx, uint32_t offset, uint8_t *dst, uint32_t len);

typedef struct {
    uint32_t file_size, riff_end, cursor, chunk_end, data_offset, data_length;
    uint32_t rate, byte_rate;
    uint16_t block_align, channels, bits, audio_format;
    uint8_t have_fmt, have_data, state;
} ug_wav_parser;

/* Validate RAW descriptor against the complete uploaded object size. */
int ug_pcm_raw_config(ug_pcm_info *out, uint32_t file_size,
                      const uint8_t descriptor[24]);
void ug_wav_parser_init(ug_wav_parser *p, uint32_t file_size);
/* One call reads <=24 bytes in operations of <=16 bytes. Returns 0 pending,
 * 1 complete, -1 malformed/unsupported, -2 backing-store I/O failure. */
int ug_wav_parser_step(ug_wav_parser *p, ug_pcm_read_fn read, void *ctx,
                       ug_pcm_info *out);
