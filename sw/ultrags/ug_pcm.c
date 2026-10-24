/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_pcm.h"
#include <string.h>

static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | ((uint16_t)p[1] << 8)); }
static uint32_t rd32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static int valid_pcm(uint32_t rate, uint8_t channels, uint8_t bits,
                     uint32_t bytes, uint32_t offset, uint32_t size,
                     ug_pcm_info *out, uint8_t sample_format) {
    uint32_t align;
    if (rate < 8000 || rate > 48000 || (channels != 1 && channels != 2) ||
        (bits != 8 && bits != 16) || sample_format > 2 ||
        (bits == 8 && sample_format == 2) || (bits == 16 && sample_format != 2)) return -1;
    align = (uint32_t)channels * (bits / 8u);
    if (!bytes || bytes % align || offset > size || bytes > size - offset) return -1;
    memset(out, 0, sizeof(*out));
    out->rate = rate; out->channels = channels; out->bits = bits;
    out->sample_format = sample_format; out->data_offset = offset;
    out->data_length = bytes; out->frames = bytes / align;
    out->loop_end = out->frames;
    return 0;
}

int ug_pcm_raw_config(ug_pcm_info *out, uint32_t file_size,
                      const uint8_t d[24]) {
    if (!out || !d) return -1;
    uint32_t rate = rd32(d), offset = rd32(d + 8), bytes = rd32(d + 12);
    uint32_t ls = rd32(d + 16), le = rd32(d + 20);
    uint8_t ch = d[4], bits = d[5], fmt = d[6], flags = d[7];
    if (flags > 1 || offset != 0 || bytes != file_size ||
        valid_pcm(rate, ch, bits, bytes, offset, file_size, out, fmt)) return -1;
    if ((!flags && (ls || le)) || (flags && !(ls < le && le <= out->frames))) return -1;
    out->flags = flags; out->loop_start = ls;
    out->loop_end = flags ? le : out->frames;
    return 0;
}

void ug_wav_parser_init(ug_wav_parser *p, uint32_t file_size) {
    memset(p, 0, sizeof(*p)); p->file_size = file_size;
}

/* IMA ADPCM block: per channel a 4-byte header (first sample + step index),
 * then 4-byte words per channel in turn, each word holding 8 samples. */
uint32_t ug_ima_block_samples(uint32_t bytes, uint32_t channels) {
    uint32_t header = 4u * channels;
    if (!channels || bytes < header) return 0;
    return 1u + 8u * ((bytes - header) / header);
}

/* Largest accepted block: bounds the decoder's worst-case catch-up after a
 * phase jump to one block (UG_IMA_MAX_BLOCK*2 nibbles per channel). */
#define UG_IMA_MAX_BLOCK 8192u

static int finish_ima(ug_wav_parser *p, ug_pcm_info *out) {
    uint32_t ch = p->channels, header = 4u * ch;
    if ((ch != 1 && ch != 2) || p->bits != 4 || p->rate < 8000 || p->rate > 48000 ||
        p->block_align <= header || p->block_align > UG_IMA_MAX_BLOCK ||
        (p->block_align - header) % header) return -1;
    uint32_t spb = ug_ima_block_samples(p->block_align, ch);
    if (p->have_ext && p->samples_per_block != spb) return -1;
    uint32_t full = p->data_length / p->block_align, tail = p->data_length % p->block_align;
    uint64_t frames = (uint64_t)full * spb;
    if (tail) {
        uint32_t extra = ug_ima_block_samples(tail, ch);
        if (!extra) return -1; /* a partial block must keep its headers */
        frames += extra;
    }
    if (p->have_fact) {
        if (!p->fact_frames || p->fact_frames > frames) return -1;
        frames = p->fact_frames; /* trims encoder padding in the last block */
    }
    if (!frames || frames > UINT32_MAX || p->data_offset > p->file_size ||
        p->data_length > p->file_size - p->data_offset) return -1;
    memset(out, 0, sizeof(*out));
    out->rate = p->rate; out->channels = (uint8_t)ch; out->bits = 4;
    out->sample_format = UG_PCM_FMT_IMA_ADPCM;
    out->data_offset = p->data_offset; out->data_length = p->data_length;
    out->frames = (uint32_t)frames; out->loop_end = out->frames;
    out->block_align = p->block_align; out->samples_per_block = (uint16_t)spb;
    return 0;
}

int ug_wav_parser_step(ug_wav_parser *p, ug_pcm_read_fn read, void *ctx,
                       ug_pcm_info *out) {
    uint8_t b[16];
    if (!p || !read || !out || p->state == 0xff) return -1;
    if (p->ext_pending) {
        /* IMA ADPCM fmt extension: cbSize, then samples per block. */
        if (read(ctx, p->ext_offset, b, 4)) return -2;
        if (rd16(b) >= 2) { p->samples_per_block = rd16(b + 2); p->have_ext = 1; }
        p->ext_pending = 0; p->cursor = p->ext_next; return 0;
    }
    if (p->state == 0) {
        if (p->file_size < 12) return -1;
        if (read(ctx, 0, b, 12)) return -2;
        if (memcmp(b, "RIFF", 4) || memcmp(b + 8, "WAVE", 4)) return -1;
        uint32_t riff_size = rd32(b + 4);
        if (riff_size < 4 || riff_size > UINT32_MAX - 8) return -1;
        p->riff_end = riff_size + 8;
        if (p->riff_end > p->file_size) return -1;
        p->cursor = 12; p->state = 1; return 0;
    }
    if (p->cursor == p->riff_end) {
        if (p->have_fmt && p->have_data && p->data_length &&
            p->audio_format == UG_WAV_FORMAT_IMA_ADPCM) {
            if (finish_ima(p, out)) return -1;
            p->state = 0xff; return 1;
        }
        if (!p->have_fmt || !p->have_data || !p->data_length ||
            p->audio_format != 1 || (p->channels != 1 && p->channels != 2) ||
            (p->bits != 8 && p->bits != 16)) return -1;
        uint32_t align = (uint32_t)p->channels * (p->bits / 8u);
        uint64_t expected_rate = (uint64_t)p->rate * align;
        if (p->rate < 8000 || p->rate > 48000 || p->block_align != align ||
            expected_rate > UINT32_MAX || p->byte_rate != (uint32_t)expected_rate ||
            p->data_length % align) return -1;
        if (valid_pcm(p->rate, (uint8_t)p->channels, (uint8_t)p->bits, p->data_length,
                      p->data_offset, p->file_size, out,
                      p->bits == 8 ? 0 : 2)) return -1;
        p->state = 0xff; return 1;
    }
    if (p->cursor > p->riff_end || p->riff_end - p->cursor < 8) return -1;
    if (read(ctx, p->cursor, b, 8)) return -2;
    uint32_t n = rd32(b + 4), payload = p->cursor + 8;
    if (n > p->riff_end - payload || (n & 1u && payload + n == p->riff_end)) return -1;
    uint32_t next = payload + n + (n & 1u);
    if (next > p->riff_end) return -1;
    if (!memcmp(b, "fmt ", 4)) {
        if (p->have_fmt || n < 16) return -1;
        if (read(ctx, payload, b, 16)) return -2;
        p->audio_format = rd16(b); p->channels = rd16(b + 2);
        p->rate = rd32(b + 4); p->byte_rate = rd32(b + 8);
        p->block_align = rd16(b + 12); p->bits = rd16(b + 14);
        p->have_fmt = 1;
        if (p->audio_format == UG_WAV_FORMAT_IMA_ADPCM && n >= 20) {
            /* Read the extension in the next step: one step stays <=24 bytes. */
            p->ext_pending = 1; p->ext_offset = payload + 16; p->ext_next = next;
            return 0;
        }
    } else if (!memcmp(b, "data", 4)) {
        if (p->have_data) return -1;
        p->have_data = 1; p->data_offset = payload; p->data_length = n;
    } else if (!memcmp(b, "fact", 4)) {
        /* Only IMA ADPCM uses it; the first one wins, as before for PCM. */
        if (!p->have_fact && n >= 4) {
            if (read(ctx, payload, b, 4)) return -2;
            p->fact_frames = rd32(b); p->have_fact = 1;
        }
    }
    p->cursor = next;
    return 0;
}
