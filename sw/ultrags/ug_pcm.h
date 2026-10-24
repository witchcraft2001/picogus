/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <stdint.h>
#include <stdbool.h>

/* sample_format codes: 0=U8, 1=S8, 2=S16LE, 3=IMA ADPCM (WAV format 0x11).
 * IMA ADPCM objects carry bits=4 and their block layout below; PCM leaves
 * block_align/samples_per_block zero. */
#define UG_PCM_FMT_IMA_ADPCM 3u
#define UG_WAV_FORMAT_IMA_ADPCM 0x11u

typedef struct {
    uint32_t rate, data_offset, data_length, frames, loop_start, loop_end;
    uint8_t channels, bits, sample_format, flags;
    uint16_t block_align, samples_per_block;
} ug_pcm_info;

typedef int (*ug_pcm_read_fn)(void *ctx, uint32_t offset, uint8_t *dst, uint32_t len);

typedef struct {
    uint32_t file_size, riff_end, cursor, chunk_end, data_offset, data_length;
    uint32_t rate, byte_rate, fact_frames, ext_offset, ext_next;
    uint16_t block_align, channels, bits, audio_format, samples_per_block;
    uint8_t have_fmt, have_data, have_fact, have_ext, ext_pending, state;
} ug_wav_parser;

/* Samples per channel held by one IMA ADPCM block of `bytes` bytes, or 0 when
 * the block cannot hold its 4-byte-per-channel header. */
uint32_t ug_ima_block_samples(uint32_t bytes, uint32_t channels);

/* Validate RAW descriptor against the complete uploaded object size. */
int ug_pcm_raw_config(ug_pcm_info *out, uint32_t file_size,
                      const uint8_t descriptor[24]);
void ug_wav_parser_init(ug_wav_parser *p, uint32_t file_size);
/* One call reads <=24 bytes in operations of <=16 bytes. Returns 0 pending,
 * 1 complete, -1 malformed/unsupported, -2 backing-store I/O failure. */
int ug_wav_parser_step(ug_wav_parser *p, ug_pcm_read_fn read, void *ctx,
                       ug_pcm_info *out);
