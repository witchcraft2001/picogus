/* SPDX-License-Identifier: GPL-2.0-or-later */
/* WAV IMA ADPCM (format 0x11): parser limits and decoder equivalence.
 *
 * Fixtures come from tools/ultrags/gen-adpcm.py: ffmpeg encodes a synthetic
 * source and ffmpeg's own decoder provides the reference. Every check here
 * compares the firmware ADPCM lane against an ordinary S16 PCM lane playing
 * that reference through the same mixer, so interpolation, repeats, pan and
 * gain are covered bit-exactly without re-implementing the codec. */
#include "ug_pcm.h"
#include "ug_render.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MEM_SIZE (1u << 20)
static uint8_t mem[MEM_SIZE];
static unsigned mem_reads;
static int mem_read(void *ctx, uint32_t off, uint8_t *dst, uint32_t n) {
    (void)ctx; assert(off <= MEM_SIZE && n <= MEM_SIZE - off);
    memcpy(dst, mem + off, n); ++mem_reads; return 0;
}
static int mem_write(void *ctx, uint32_t off, const uint8_t *src, uint32_t n) {
    (void)ctx; memcpy(mem + off, src, n); return 0;
}
static ug_mixer ima_mix, pcm_mix;

static uint8_t file[4096];
static unsigned step_bytes;
static int file_read(void *ctx, uint32_t off, uint8_t *dst, uint32_t n) {
    const uint8_t *base = ctx ? ctx : file;
    assert(n <= 16); memcpy(dst, base + off, n); step_bytes += n; return 0;
}
static void u16(uint8_t *p, uint16_t n) { p[0] = (uint8_t)n; p[1] = (uint8_t)(n >> 8); }
static void u32(uint8_t *p, uint32_t n) { u16(p, (uint16_t)n); u16(p + 2, (uint16_t)(n >> 16)); }
static uint32_t g32(const uint8_t *p) { return p[0] | (p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }

static int parse_buffer(const uint8_t *data, uint32_t size, ug_pcm_info *out) {
    ug_wav_parser p; ug_wav_parser_init(&p, size); int r = 0, guard = 0;
    while (r == 0 && guard++ < 200) {
        step_bytes = 0; r = ug_wav_parser_step(&p, file_read, (void *)data, out);
        assert(step_bytes <= 24);
    }
    assert(guard < 200); return r;
}

/* Hand-built header: fmt (with or without extension), optional fact, data. */
static unsigned build(uint16_t ch, uint32_t rate, uint16_t align, uint16_t bits,
                      int ext, uint16_t spb, int fact, uint32_t fact_frames, uint32_t data_len) {
    memset(file, 0, sizeof(file)); memcpy(file, "RIFF", 4); memcpy(file + 8, "WAVE", 4);
    unsigned p = 12, fmt_len = ext ? 20 : 16;
    memcpy(file + p, "fmt ", 4); u32(file + p + 4, fmt_len);
    u16(file + p + 8, 0x11); u16(file + p + 10, ch); u32(file + p + 12, rate);
    u32(file + p + 16, rate); u16(file + p + 20, align); u16(file + p + 22, bits);
    if (ext) { u16(file + p + 24, 2); u16(file + p + 26, spb); }
    p += 8 + fmt_len;
    if (fact) { memcpy(file + p, "fact", 4); u32(file + p + 4, 4); u32(file + p + 8, fact_frames); p += 12; }
    memcpy(file + p, "data", 4); u32(file + p + 4, data_len); p += 8 + data_len + (data_len & 1);
    assert(p <= sizeof(file)); u32(file + 4, p - 8); return p;
}

static void parser_limits(void) {
    ug_pcm_info m;
    assert(ug_ima_block_samples(256, 1) == 505 && ug_ima_block_samples(2048, 2) == 2041);
    assert(ug_ima_block_samples(3, 1) == 0 && ug_ima_block_samples(4, 1) == 1);
    /* Two full mono blocks + a 12-byte tail (1 + 8*2 samples). */
    unsigned n = build(1, 11025, 256, 4, 1, 505, 0, 0, 2 * 256 + 12);
    assert(parse_buffer(file, n, &m) == 1);
    assert(m.sample_format == UG_PCM_FMT_IMA_ADPCM && m.bits == 4 && m.channels == 1);
    assert(m.frames == 2 * 505 + 17 && m.loop_end == m.frames && m.flags == 0);
    assert(m.block_align == 256 && m.samples_per_block == 505 && m.data_length == 524);
    /* No extension: samples per block derived from block_align. */
    n = build(2, 22050, 1024, 4, 0, 0, 0, 0, 1024); assert(parse_buffer(file, n, &m) == 1 && m.frames == 1017);
    /* fact trims encoder padding, never extends. */
    n = build(1, 8000, 32, 4, 1, 57, 1, 100, 64); assert(parse_buffer(file, n, &m) == 1 && m.frames == 100);
    n = build(1, 8000, 32, 4, 1, 57, 1, 115, 64); assert(parse_buffer(file, n, &m) < 0);
    n = build(1, 8000, 32, 4, 1, 57, 1, 0, 64); assert(parse_buffer(file, n, &m) < 0);
    n = build(1, 8000, 32, 4, 1, 58, 0, 0, 64); assert(parse_buffer(file, n, &m) < 0);   /* spb mismatch */
    n = build(1, 8000, 32, 3, 1, 57, 0, 0, 64); assert(parse_buffer(file, n, &m) < 0);   /* 3-bit IMA */
    n = build(1, 8000, 34, 4, 0, 0, 0, 0, 68); assert(parse_buffer(file, n, &m) < 0);    /* odd words */
    n = build(2, 8000, 36, 4, 0, 0, 0, 0, 72); assert(parse_buffer(file, n, &m) < 0);    /* stereo needs 8-byte groups */
    n = build(1, 8000, 4, 4, 0, 0, 0, 0, 8); assert(parse_buffer(file, n, &m) < 0);      /* header-only block */
    n = build(1, 8000, 32, 4, 1, 57, 0, 0, 32 + 3); assert(parse_buffer(file, n, &m) < 0); /* tail without header */
    n = build(3, 8000, 52, 4, 0, 0, 0, 0, 52); assert(parse_buffer(file, n, &m) < 0);
    n = build(1, 7999, 32, 4, 1, 57, 0, 0, 32); assert(parse_buffer(file, n, &m) < 0);
    n = build(1, 48001, 32, 4, 1, 57, 0, 0, 32); assert(parse_buffer(file, n, &m) < 0);
    n = build(1, 48000, 8196, 4, 0, 0, 0, 0, 0); u32(file + 4 + 0, g32(file + 4)); assert(parse_buffer(file, n, &m) < 0);
    n = build(1, 48000, 8192, 4, 1, 16377, 0, 0, 64); assert(parse_buffer(file, n, &m) == 1 && m.frames == 1 + 8 * 15);
    n = build(1, 8000, 32, 4, 1, 57, 0, 0, 0); assert(parse_buffer(file, n, &m) < 0);   /* empty data */
    /* PCM WAV behaviour is unchanged: a fact chunk is still ignored there. */
    n = build(1, 8000, 1, 8, 0, 0, 1, 1, 4); u16(file + 20, 1); u32(file + 28, 8000);
    assert(parse_buffer(file, n, &m) == 1 && m.sample_format == 0 && m.frames == 4 && m.block_align == 0);
    /* Lane validation mirrors the parser. */
    ug_mixer_init(&ima_mix, (ug_mem_if){mem_read, mem_write, NULL, MEM_SIZE});
    assert(ug_lane_set_ima(&ima_mix, 0, 0, 256, 505, 256, 505, 64, 128, UG_LANE_MONO, 0) == 0);
    assert(ug_lane_set_ima(&ima_mix, 0, 0, 256, 506, 256, 505, 64, 128, UG_LANE_MONO, 0) < 0);
    assert(ug_lane_set_ima(&ima_mix, 0, 0, 256, 505, 256, 504, 64, 128, UG_LANE_MONO, 0) < 0);
    assert(ug_lane_set_ima(&ima_mix, 0, 0, 256, 505, 256, 505, 65, 128, UG_LANE_MONO, 0) < 0);
    assert(ug_lane_set_ima(&ima_mix, 0, 0, 256, 505, 256, 505, 64, 128, UG_LANE_RIGHT, 0) < 0);
    assert(ug_lane_set_ima(&ima_mix, 0, MEM_SIZE - 100, 256, 505, 256, 505, 64, 128, UG_LANE_MONO, 0) < 0);
    assert(ug_lane_set_ima(&ima_mix, 0, 0, 512 + 12, 2 * 505 + 17, 256, 505, 64, 128, UG_LANE_MONO, 0) == 0);
    assert(ug_lane_set_ima(&ima_mix, 0, 0, 512 + 12, 2 * 505 + 18, 256, 505, 64, 128, UG_LANE_MONO, 0) < 0);
    puts("IMA parser limits, fact/extension rules and lane validation PASS");
}

static uint8_t *load(const char *dir, const char *name, const char *suffix, uint32_t *size) {
    char path[512]; snprintf(path, sizeof(path), "%s/%s%s", dir, name, suffix);
    FILE *f = fopen(path, "rb"); assert(f);
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET); assert(n > 0);
    uint8_t *b = malloc((size_t)n); assert(b && fread(b, 1, (size_t)n, f) == (size_t)n); fclose(f);
    *size = (uint32_t)n; return b;
}

/* Configure both mixers with the same voice parameters and compare. */
static void equivalence(const ug_pcm_info *ima, uint32_t ima_off, const ug_pcm_info *pcm,
                        uint32_t pcm_off, uint16_t repeats, uint8_t pan, uint8_t gain,
                        uint32_t frames_out, const char *name) {
    ug_mixer_init(&ima_mix, (ug_mem_if){mem_read, mem_write, NULL, MEM_SIZE});
    ug_mixer_init(&pcm_mix, (ug_mem_if){mem_read, mem_write, NULL, MEM_SIZE});
    for (unsigned side = 0; side < ima->channels; side++) {
        uint8_t mode = ima->channels == 1 ? UG_LANE_MONO : side ? UG_LANE_RIGHT : UG_LANE_LEFT;
        assert(!ug_lane_set_ima(&ima_mix, side, ima_off, ima->data_length, ima->frames,
                                ima->block_align, ima->samples_per_block, gain, pan, mode, (uint8_t)side));
        assert(!ug_lane_set(&pcm_mix, side, pcm_off, pcm->frames, 0, pcm->frames, 0, gain, pan,
                            UG_FMT_S16LE, mode, 0, (uint8_t)side));
        ug_lane_pcm_rate(&ima_mix.lanes[side], ima->rate, 48000, repeats);
        ug_lane_pcm_rate(&pcm_mix.lanes[side], pcm->rate, 48000, repeats);
    }
    if (ima->channels == 2) {
        assert(!ug_lane_share_cache(&ima_mix, 1, 0));
        assert(!ug_lane_share_cache(&pcm_mix, 1, 0));
    }
    int16_t a[256], b[256]; unsigned nonzero = 0;
    for (uint32_t done = 0; done < frames_out; done += 128) {
        ug_mixer_render(&ima_mix, a, 128); ug_mixer_render(&pcm_mix, b, 128);
        for (unsigned i = 0; i < 256; i++) {
            if (a[i] != b[i]) {
                fprintf(stderr, "%s: mismatch frame %u ch %u: ima %d pcm %d\n", name, done + i / 2, i & 1, a[i], b[i]);
                exit(1);
            }
            nonzero += a[i] != 0;
        }
    }
    assert(nonzero);
    assert(ima_mix.stats.fetch_errors == 0 && pcm_mix.stats.fetch_errors == 0);
    for (unsigned side = 0; side < ima->channels; side++) {
        assert(ima_mix.lanes[side].active == pcm_mix.lanes[side].active);
        assert(ima_mix.lanes[side].phase == pcm_mix.lanes[side].phase);
    }
}

static void fixtures(const char *dir) {
    char path[512]; snprintf(path, sizeof(path), "%s/manifest.txt", dir);
    FILE *list = fopen(path, "r"); assert(list);
    char name[64]; unsigned rate, ch, block, frames, cases = 0;
    while (fscanf(list, "%63s %u %u %u %u", name, &rate, &ch, &block, &frames) == 5) {
        uint32_t wav_size, pcm_size;
        uint8_t *wav = load(dir, name, ".wav", &wav_size), *pcmwav = load(dir, name, ".pcm.wav", &pcm_size);
        ug_pcm_info ima, pcm;
        assert(parse_buffer(wav, wav_size, &ima) == 1);
        assert(ima.sample_format == UG_PCM_FMT_IMA_ADPCM && ima.rate == rate && ima.channels == ch);
        assert(ima.block_align == block && ima.frames == frames && ima.bits == 4);
        assert(parse_buffer(pcmwav, pcm_size, &pcm) == 1 && pcm.frames == frames && pcm.sample_format == 2);
        uint32_t ima_off = 1000, pcm_off = 1000 + ((wav_size + 4095) & ~4095u);
        assert(pcm_off + pcm_size <= MEM_SIZE);
        memset(mem, 0xA5, MEM_SIZE);
        memcpy(mem + ima_off, wav + ima.data_offset, ima.data_length);
        memcpy(mem + pcm_off, pcmwav + pcm.data_offset, pcm.data_length);
        uint32_t once = (uint32_t)(((uint64_t)frames * 48000 + rate - 1) / rate) + 256;
        static const uint8_t pans[] = {0, 128, 255, 77};
        equivalence(&ima, ima_off, &pcm, pcm_off, 1, pans[cases & 3], 64, once, name);
        equivalence(&ima, ima_off, &pcm, pcm_off, 3, 128, 40, once * 3, name);   /* whole-object repeats */
        equivalence(&ima, ima_off, &pcm, pcm_off, 0, 200, 64, once * 2 + 999, name); /* LOOP_OBJECT */
        /* Bounded decode work: one nibble per source sample per channel. */
        ug_mixer_init(&ima_mix, (ug_mem_if){mem_read, mem_write, NULL, MEM_SIZE});
        for (unsigned side = 0; side < ch; side++) {
            uint8_t mode = ch == 1 ? UG_LANE_MONO : side ? UG_LANE_RIGHT : UG_LANE_LEFT;
            assert(!ug_lane_set_ima(&ima_mix, side, ima_off, ima.data_length, ima.frames,
                                    ima.block_align, ima.samples_per_block, 64, 128, mode, (uint8_t)side));
            ug_lane_pcm_rate(&ima_mix.lanes[side], rate, 48000, 1);
        }
        if (ch == 2) assert(!ug_lane_share_cache(&ima_mix, 1, 0));
        mem_reads = 0; int16_t out[256];
        for (uint32_t done = 0; done < once; done += 128) ug_mixer_render(&ima_mix, out, 128);
        assert(!ima_mix.lanes[0].active);
        unsigned lines = (ima.data_length + 255) / 256 + 2;
        assert(mem_reads <= lines * (ch == 2 ? 2u : 1u) + 2);
        if (rate == 48000 && ch == 1) {
            /* Rate 48000: no interpolation, output equals ffmpeg's decode. */
            ug_mixer_init(&ima_mix, (ug_mem_if){mem_read, mem_write, NULL, MEM_SIZE});
            assert(!ug_lane_set_ima(&ima_mix, 0, ima_off, ima.data_length, ima.frames,
                                    ima.block_align, ima.samples_per_block, 64, 0, UG_LANE_MONO, 0));
            ug_lane_pcm_rate(&ima_mix.lanes[0], rate, 48000, 1);
            const int16_t *ref = (const int16_t *)(pcmwav + pcm.data_offset);
            for (uint32_t done = 0; done < frames; done += 128) {
                ug_mixer_render(&ima_mix, out, 128);
                for (unsigned i = 0; i < 128 && done + i < frames; i++) assert(out[2 * i] == ref[done + i] && out[2 * i + 1] == 0);
            }
        }
        printf("IMA %s rate=%u ch=%u block=%u frames=%u reads=%u: matches ffmpeg via PCM lane (once/x3/loop) PASS\n",
               name, rate, ch, block, frames, mem_reads);
        free(wav); free(pcmwav); ++cases;
    }
    fclose(list); assert(cases >= 7);
}

int main(int argc, char **argv) {
    assert(argc == 2);
    parser_limits();
    fixtures(argv[1]);
    puts("IMA ADPCM render PASS");
    return 0;
}
