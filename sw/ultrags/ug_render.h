/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  Ultra GS PCM renderer, also used by the S0a diagnostic profiles.
 *  Host-compatible (no Pico SDK deps): PSRAM access goes through ug_mem_if
 *  callbacks so the same code runs in firmware and in unit tests.
 *  MOD/tick scheduling is outside this PCM kernel.
 */
#ifndef UG_RENDER_H
#define UG_RENDER_H

#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

#ifndef UG_LANES
#define UG_LANES        32
#endif
#if UG_LANES < 32 || UG_LANES > 256
#error "UG_LANES must be in 32..256 (voice IDs are u16, no wire bit mask)"
#endif
#define UG_CACHE_LINES  2
#define UG_CACHE_LINE   256     /* bytes per PSRAM cache line */
#define UG_CACHE_TAG_INVALID 0xFFFFFFFFu

/* Backing-store interface (PSRAM adapter on device, mock on host) */
typedef struct {
    int (*read)(void *ctx, uint32_t offset, uint8_t *dst, uint32_t len);
    int (*write)(void *ctx, uint32_t offset, const uint8_t *src, uint32_t len);
    void *ctx;
    uint32_t size;   /* accessible pool size in bytes; OOB -> error, no wrap */
} ug_mem_if;

typedef enum {
    UG_FMT_S8 = 0,    /* 1 byte/sample, signed */
    UG_FMT_S16LE = 1, /* 2 bytes/sample, signed little-endian */
    UG_FMT_U8 = 2     /* 1 byte/sample, unsigned PCM centered at 128 */
} ug_fmt;

typedef enum {
    UG_LANE_MONO = 0,   /* pans freely */
    UG_LANE_LEFT = 1,   /* hard-left member of a stereo pair */
    UG_LANE_RIGHT = 2   /* hard-right member of a stereo pair */
} ug_lane_mode;

typedef struct {
    uint32_t src_offset;    /* byte offset into backing store */
    uint32_t len_samples;   /* total samples in source (per channel) */
    uint32_t loop_start;    /* sample index, inclusive */
    uint32_t loop_end;      /* sample index, exclusive; ==len means tail */
    uint64_t phase;         /* Q32.32 sample position */
    uint64_t step;          /* Q32.32 phase increment per output frame */
    uint32_t step_remainder, step_denominator, step_residue;
    uint16_t repeats;       /* remaining complete passes; 0=infinite */
    uint8_t  gain;          /* 0..64 channel gain */
    uint8_t  class_gain, class_master;
    uint8_t  pan;           /* 0 left .. 255 right (mono lanes) */
    uint8_t  fmt;           /* ug_fmt */
    uint8_t  mode;          /* ug_lane_mode */
    uint8_t  looped;        /* 1 = loop between loop_start..loop_end */
    uint8_t  active;
    uint8_t  ended;         /* non-looped lane reached EOF */
    uint8_t  failed;        /* backend failure: silence until next PLAY */
    uint8_t  ch_off;        /* interleaved stereo channel (0=L,1=R); mono=0 */
    uint8_t  cache_victim;    /* next line to evict (0/1 round robin) */
    uint16_t cache_peer;     /* FFFF=own cache; stereo right may share left */
    uint32_t cache_tag[UG_CACHE_LINES]; /* byte window base, tag INVALID = empty */
    uint8_t  cache[UG_CACHE_LINES][UG_CACHE_LINE];
    uint8_t  mix_shift;     /* MOD headroom: 0=unity, 1..3=divide by2/4/8 */
} ug_lane;

typedef struct {
    uint32_t cache_fills;
    uint32_t cache_hits;
    uint32_t fetch_errors;   /* OOB / backend error reads */
    uint32_t clips;          /* saturating output samples */
    uint32_t frames;
    uint32_t checksum;       /* FNV-1a over produced stereo frames */
    uint32_t max_render_us;  /* filled by caller */
} ug_stats;

typedef struct {
    ug_mem_if mem;
    ug_lane lanes[UG_LANES];
    int32_t voice_samples[128];
    int32_t accumulation[128][2]; /* bounded block scratch, never core1 stack */
    const int32_t *fm;       /* optional mono input, advanced across event splits */
    int32_t vol_q15;         /* mainVol scale, 32768 == unity */
    ug_stats stats;
    uint16_t peak_frames, peak_current[2], peaks[2];
    uint16_t lane_peak_current[UG_LANES], lane_peaks[UG_LANES];
    int      last_error;     /* sticky backend error code */
} ug_mixer;

/* Round half away from zero. n/d, d > 0. */
static inline int64_t ug_rdiv(int64_t n, int64_t d) {
    return (n >= 0 ? n + d / 2 : n - d / 2) / d;
}

void ug_mixer_init(ug_mixer *m, ug_mem_if mem);

/* Configure one lane. Returns 0, -1 on invalid params (bounds/format/step). */
int ug_lane_set(ug_mixer *m, unsigned lane, uint32_t src_offset,
                uint32_t len_samples, uint32_t loop_start, uint32_t loop_end,
                uint64_t step_q32, uint8_t gain, uint8_t pan,
                uint8_t fmt, uint8_t mode, uint8_t looped, uint8_t ch_off);
/* Configure a detached hidden music voice under a legacy GS FX override. */
int ug_lane_configure(ug_mixer *m,ug_lane *lane,uint32_t src_offset,
                uint32_t len_samples,uint32_t loop_start,uint32_t loop_end,
                uint64_t step_q32,uint8_t gain,uint8_t pan,
                uint8_t fmt,uint8_t mode,uint8_t looped,uint8_t ch_off);
void ug_lane_advance_silent(ug_lane *lane,uint32_t frames);

int ug_lane_share_cache(ug_mixer *m,unsigned right,unsigned left);

/* PCM phase advances by rate/output_rate exactly, retaining division residue. */
void ug_lane_pcm_rate(ug_lane *lane, uint32_t rate, uint32_t output_rate,
                      uint16_t repeats);

/* Render `frames` stereo frames into out[2*frames] (L,R interleaved S16).
 * Returns 0; per-lane errors are counted in stats and contribute silence. */
int ug_mixer_render(ug_mixer *m, int16_t *out, uint32_t frames);
/* Mix pre-resampled streaming PCM through the same voice gains, main volume,
 * clipping and peaks as resident sources. The reserved pair is not advanced. */
int ug_mixer_render_stream(ug_mixer *m,int16_t *out,uint32_t frames,
                            const int16_t *pcm,const uint16_t voices[2]);

#ifdef __cplusplus
}
#endif
#endif /* UG_RENDER_H */
