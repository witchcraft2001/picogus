/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  Host unit tests for the S0a render kernel (sw/ultrags/ug_render.c).
 *  The oracle is an independent scalar implementation that reads the
 *  mock store DIRECTLY (no cache machinery, no shared code path), so
 *  kernel bugs in the cache/phase logic are actually caught.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "ug_render.h"
#include "ug_profile.h"

#define POOL (8u << 20)   /* same declared pool as the diag profile */
#define FX_HI (0x110000u) /* fixture offset above the 1 MiB mark */
static uint8_t mem[POOL]; /* mock backing store */
static uint32_t mem_reads, mem_read_bytes, mem_oob;

static int mock_read(void *ctx, uint32_t off, uint8_t *dst, uint32_t len) {
    (void)ctx;
    mem_reads++;
    if (off >= POOL || len > POOL - off) { mem_oob++; return -1; }
    mem_read_bytes += len;
    memcpy(dst, mem + off, len);
    return 0;
}
static int mock_write(void *ctx, uint32_t off, const uint8_t *src,
                      uint32_t len) {
    (void)ctx;
    if (off >= POOL || len > POOL - off) { mem_oob++; return -1; }
    memcpy(mem + off, src, len);
    return 0;
}

static ug_mem_if mock_if(void) {
    ug_mem_if m = {mock_read, mock_write, NULL, POOL};
    return m;
}

static int fails;
#define CHECK(cond, msg) do { \
    if (!(cond)) { printf("FAIL %s:%d %s\n", __FILE__, __LINE__, msg); \
                   fails++; } } while (0)

/* -------- independent reference implementation -----------------------
 * No cache, no ug_lane machinery: plain per-lane state arrays, direct
 * array reads. Integer math mirrors the documented contract (linear
 * interp, gain/64, pan/255, Q32.32 phase) but the code path is
 * deliberately different. */
typedef struct {
    uint32_t off, len, ls, le;
    uint64_t phase, step;
    uint8_t gain, pan, s16, looped, ended, choff, channels;
} ref_lane;

static int32_t ref_rdiv(int64_t n, int64_t d) {
    return (int32_t)((n >= 0 ? n + d / 2 : n - d / 2) / d);
}

static int32_t ref_sample(const ref_lane *r, uint32_t idx) {
    if (idx >= r->len) return 0;
    uint32_t b = r->off + (idx * (r->channels ? r->channels : 1u) + r->choff) * (r->s16 ? 2u : 1u);
    if (!r->s16) return (int32_t)(int8_t)mem[b] * 256;
    return (int32_t)(int16_t)(mem[b] | ((uint16_t)mem[b + 1] << 8));
}

static int32_t ref_tick(ref_lane *r) {
    if (r->ended) return 0;
    uint32_t pos = (uint32_t)(r->phase >> 32);
    uint32_t frac = (uint32_t)r->phase;
    int32_t s0 = ref_sample(r, pos);
    uint32_t p1;
    if (r->looped) p1 = (pos + 1 >= r->le) ? r->ls : pos + 1;
    else p1 = (pos + 1 >= r->len) ? r->len - 1 : pos + 1;
    int32_t s1 = ref_sample(r, p1);
    int32_t s = ref_rdiv((int64_t)s0 * (0x100000000ll - frac) +
                        (int64_t)s1 * frac, 1ll << 32);
    s = ref_rdiv((int64_t)s * r->gain, 64);
    /* advance */
    uint64_t lo = (uint64_t)frac + (r->step & 0xFFFFFFFFull);
    uint64_t np = pos + (r->step >> 32) + (lo >> 32);
    if (r->looped) {
        uint32_t ll = r->le - r->ls;
        uint64_t rel = np - r->ls;
        if (ll && rel >= ll) rel %= ll;
        np = r->ls + (uint32_t)rel;
        r->phase = (np << 32) | (lo & 0xFFFFFFFFull);
    } else {
        if (np >= r->len) { r->ended = 1; r->phase = (uint64_t)(r->len - 1) << 32; }
        else r->phase = (np << 32) | (lo & 0xFFFFFFFFull);
    }
    return s;
}

/* render F frames through the reference, one lane index per struct */
static void ref_render_stereo(ref_lane *lanes, int nlanes, uint8_t *mode,
                              int16_t *out, int frames, int32_t vol_q15) {
    for (int f = 0; f < frames; f++) {
        int32_t L = 0, R = 0;
        for (int i = 0; i < nlanes; i++) {
            int32_t s = ref_tick(&lanes[i]);
            if (mode[i] == UG_LANE_LEFT) L += s;
            else if (mode[i] == UG_LANE_RIGHT) R += s;
            else {
                L += ref_rdiv((int64_t)s * (255 - lanes[i].pan), 255);
                R += ref_rdiv((int64_t)s * lanes[i].pan, 255);
            }
        }
        L = ref_rdiv((int64_t)L * vol_q15, 32768);
        R = ref_rdiv((int64_t)R * vol_q15, 32768);
        if (L > 32767) L = 32767;
        if (L < -32768) L = -32768;
        if (R > 32767) R = 32767;
        if (R < -32768) R = -32768;
        out[2 * f] = (int16_t)L;
        out[2 * f + 1] = (int16_t)R;
    }
}

/* set up a lane identically in kernel + reference */
static void both_lane(ug_mixer *m, ref_lane *r, int i, uint32_t off,
                      uint32_t len, uint32_t ls, uint32_t le,
                      uint64_t step, uint8_t gain, uint8_t pan,
                      int s16, int mode, int looped, int choff) {
    int rc = ug_lane_set(m, i, off, len, ls, le, step, gain, pan,
                         s16 ? UG_FMT_S16LE : UG_FMT_S8, mode, looped, choff);
    CHECK(rc == 0, "lane_set");
    r->off = off; r->len = len; r->ls = ls; r->le = le;
    r->phase = looped ? ((uint64_t)ls << 32) : 0;
    r->step = step; r->gain = gain; r->pan = pan; r->s16 = s16;
    r->looped = looped; r->ended = 0; r->choff = choff;
    r->channels = mode == UG_LANE_MONO ? 1 : 2;
}

#define FRAMES 256
static int16_t kbuf[2 * FRAMES], rbuf[2 * FRAMES];

/* ------------------------------------------------------------------ */
static void t_s8_s16_polarity(void) {
    /* S8 sign extension and S16LE endianness */
    memset(mem, 0, 256);
    mem[0] = 0x80; /* S8 -128 -> -32768 */
    mem[1] = 0x7F; /* S8 +127 -> +32512 */
    mem[2] = 0x00; mem[3] = 0x80; /* S16LE -32768 */
    mem[4] = 0xFF; mem[5] = 0x7F; /* S16LE +32767 */
    ug_mixer m; ug_mixer_init(&m, mock_if());
    ref_lane r = {0}; uint8_t mode = UG_LANE_MONO;
    both_lane(&m, &r, 0, 0, 4, 0, 4, 1ull << 32, 64, 128, 0, mode, 0, 0);
    ug_mixer_render(&m, kbuf, 2);
    int32_t l0 = kbuf[0], l1 = kbuf[2];
    /* s[0]=-32768 (pan 128 -> ~half each side) */
    CHECK(l0 < -15000, "S8 -128 did not reach low range");
    /* next frame reads s[1]=+127 */
    CHECK(l1 > 15000, "S8 +127 did not reach high range");

    ug_mixer_init(&m, mock_if());
    memset(&r, 0, sizeof(r));
    both_lane(&m, &r, 0, 2, 2, 0, 2, 1ull << 32, 64, 128, 1, mode, 0, 0);
    ug_mixer_render(&m, kbuf, 2);
    CHECK(kbuf[0] < -15000, "S16LE -32768");
    CHECK(kbuf[2] > 15000, "S16LE +32767");
}

static void t_interp(void) {
    /* frac=0.5 exactly between 0 and 256 (S16: 0x0100 at idx1) */
    memset(mem, 0, 16);
    mem[2] = 0x01; mem[3] = 0x00; /* s[1] = 0x0001? place real data */
    /* use S16 values: s[0]=0, s[1]=0x4000 */
    mem[0] = 0x00; mem[1] = 0x00;
    mem[2] = 0x00; mem[3] = 0x40;
    ug_mixer m; ug_mixer_init(&m, mock_if());
    int rc = ug_lane_set(&m, 0, 0, 2, 0, 0, 0, 64, 255 /* pan right */,
                         UG_FMT_S16LE, UG_LANE_MONO, 0, 0);
    CHECK(rc == 0, "lane_set interp");
    /* inject phase 0.5 directly */
    m.lanes[0].phase = 0x80000000ull;
    ref_lane r = {0, 2, 0, 2, 0x80000000ull, 0, 64, 255, 1, 0, 0, 0, 1};
    ug_mixer_render(&m, kbuf, 1);
    int16_t rr[2] = {0, 0};
    ref_render_stereo(&r, 1, &(uint8_t){UG_LANE_MONO}, rr, 1, 32768);
    /* expected: (0x4000)*0.5 = 8192 right, 0 left */
    CHECK(rr[1] == 8192 && rr[0] == 0, "ref interp 0.5");
    CHECK(kbuf[1] == 8192 && kbuf[0] == 0, "kernel interp 0.5");
}

static void t_loop_short(void) {
    /* loop lengths 1,2,3 in a single run; step forces multi-wraps */
    memset(mem, 0, 64);
    for (int i = 0; i < 8; i++) { mem[i * 2] = (uint8_t)(i * 8); mem[i * 2 + 1] = 0; }
    /* S16 values: 0,8,16,24,...*256? no: LE (i*8, 0) -> value i*8 */
    ug_mixer m;
    for (int L = 1; L <= 3; L++) {
        ug_mixer_init(&m, mock_if());
        ref_lane r = {0};
        /* loop [2, 2+L), step 4.0 -> several wraps within 4 frames */
        int rc = ug_lane_set(&m, 0, 0, 8, 2, 2 + L,
                             4ull << 32, 64, 128, UG_FMT_S16LE,
                             UG_LANE_MONO, 1, 0);
        CHECK(rc == 0, "loop lane_set");
        r.off = 0; r.len = 8; r.ls = 2; r.le = 2 + L;
        r.phase = (uint64_t)2 << 32; r.step = 4ull << 32;
        r.gain = 64; r.pan = 128; r.s16 = 1; r.looped = 1;
        uint8_t md = UG_LANE_MONO;
        ref_render_stereo(&r, 1, &md, rbuf, FRAMES, 32768);
        ug_mixer_render(&m, kbuf, FRAMES);
        CHECK(!memcmp(kbuf, rbuf, sizeof(kbuf)), "loop L kernel!=ref");
        /* activity: non-silent output expected */
        int nz = 0;
        for (int i = 0; i < FRAMES * 2; i++) nz |= kbuf[i];
        CHECK(nz != 0, "loop output silent");
    }
}

static void t_eof_unlooped(void) {
    memset(mem, 0, 64);
    for (int i = 0; i < 8; i++) { mem[i * 2] = 0x40; mem[i * 2 + 1] = 0; }
    ug_mixer m; ug_mixer_init(&m, mock_if());
    /* step 2.0, len 8 -> 4 frames then EOF */
    int rc = ug_lane_set(&m, 0, 0, 8, 0, 0, 2ull << 32, 64, 255,
                         UG_FMT_S16LE, UG_LANE_MONO, 0, 0);
    CHECK(rc == 0, "eof lane_set");
    ug_mixer_render(&m, kbuf, 16);
    /* after EOF lane ends -> silence */
    CHECK(m.lanes[0].ended == 1, "lane not ended at EOF");
    int tail = 0;
    for (int i = 10; i < 16; i++) tail |= kbuf[2 * i + 1];
    CHECK(tail == 0, "tail not silent after EOF");
}

static void t_oob_and_mask(void) {
    /* source at >1MiB offset: a 0xFFFFF mask would alias it to the
     * fixture at the low address, which holds a different pattern */
    memset(mem, 0x11, 0x400);          /* low region marker 0x11 */
    memset(mem + FX_HI, 0x22, 0x400);  /* high region marker 0x22 */
    ug_mixer m; ug_mixer_init(&m, mock_if());
    ref_lane r = {0};
    both_lane(&m, &r, 0, FX_HI, 64, 0, 64, 1ull << 32, 64, 128, 0,
              UG_LANE_MONO, 1, 0);
    uint8_t md = UG_LANE_MONO;
    ref_render_stereo(&r, 1, &md, rbuf, 8, 32768);
    ug_mixer_render(&m, kbuf, 8);
    CHECK(!memcmp(kbuf, rbuf, 32), "hi-offset kernel!=ref");
    /* explicit: with a 0xFFFFF mask the kernel would read the 0x11
     * low-window pattern; 0x22 S8 -> right channel top byte 0x22 */
    ug_mixer m2; ug_mixer_init(&m2, mock_if());
    CHECK(ug_lane_set(&m2, 0, FX_HI, 64, 0, 64, 1ull << 32, 64, 255,
                      UG_FMT_S8, UG_LANE_MONO, 1, 0) == 0, "hi lane");
    ug_mixer_render(&m2, kbuf, 4);
    CHECK((uint8_t)(kbuf[1] >> 8) == 0x22, "mask/alias: wrong byte read");

    /* OOB: lane source extending past pool end must fail to set */
    int rc = ug_lane_set(&m, 1, POOL - 16, 32, 0, 32, 1ull << 32, 64,
                         128, UG_FMT_S16LE, UG_LANE_MONO, 0, 0);
    CHECK(rc != 0, "OOB lane accepted");
}

static void t_cacheline_boundary(void) {
    /* sample pair straddling a 256B cache line (S16 at byte 254/256) */
    memset(mem, 0, 1024);
    mem[254] = 0x00; mem[255] = 0x20;  /* s at byte 254: 0x2000 */
    mem[256] = 0x00; mem[257] = 0x40;  /* s at byte 256: 0x4000 */
    ug_mixer m; ug_mixer_init(&m, mock_if());
    ref_lane r = {0};
    both_lane(&m, &r, 0, 254, 2, 0, 2, 1ull << 32, 64, 128, 1,
              UG_LANE_MONO, 0, 0);
    uint8_t md = UG_LANE_MONO;
    ref_render_stereo(&r, 1, &md, rbuf, 4, 32768);
    uint32_t fills0 = m.stats.cache_fills;
    ug_mixer_render(&m, kbuf, 4);
    CHECK(!memcmp(kbuf, rbuf, 16), "cache-line boundary mismatch");
    CHECK(m.stats.cache_fills > fills0, "no cache fills counted");
}

static void t_saturation(void) {
    /* all 12 lanes at +32767 * full gain -> sums far past S16 max */
    memset(mem, 0x7F, 512);
    memset(mem + 256, 0xFF, 2); mem[256] = 0xFF; mem[257] = 0x7F;
    ug_mixer m; ug_mixer_init(&m, mock_if());
    uint8_t md[UG_LANES];
    ref_lane rl[UG_LANES];
    memset(rl, 0, sizeof(rl));
    for (int i = 0; i < UG_LANES; i++) {
        md[i] = UG_LANE_MONO;
        both_lane(&m, &rl[i], i, 0, 4, 0, 4, 1ull << 32, 64, 128, 0,
                  UG_LANE_MONO, 1, 0);
    }
    /* make the underlying data S16 max: kernel treats it as S8 0x7F ->
     * close to max. use S16 source for exactness */
    memset(mem, 0xFF, 256);
    for (int i = 1; i < 256; i += 2) mem[i] = 0x7F; /* 0x7FFF pairs */
    ug_mixer_init(&m, mock_if());
    memset(rl, 0, sizeof(rl));
    for (int i = 0; i < UG_LANES; i++) {
        md[i] = UG_LANE_MONO;
        both_lane(&m, &rl[i], i, 0, 4, 0, 4, 1ull << 32, 64, 128, 1,
                  UG_LANE_MONO, 1, 0);
    }
    ref_render_stereo(rl, UG_LANES, md, rbuf, FRAMES, 32768);
    ug_mixer_render(&m, kbuf, FRAMES);
    CHECK(!memcmp(kbuf, rbuf, sizeof(kbuf)), "saturation kernel!=ref");
    CHECK(kbuf[0] == 32767 && kbuf[1] == 32767, "no saturation");
    CHECK(m.stats.clips > 0, "clip counter zero");
}

static void t_silence(void) {
    memset(mem, 0, 512);
    ug_mixer m; ug_mixer_init(&m, mock_if());
    ref_lane r = {0};
    both_lane(&m, &r, 0, 0, 8, 0, 8, 1ull << 32, 64, 128, 0,
              UG_LANE_MONO, 1, 0);
    ug_mixer_render(&m, kbuf, FRAMES);
    int nz = 0;
    for (int i = 0; i < FRAMES * 2; i++) nz |= kbuf[i];
    CHECK(nz == 0, "silence not silent");
    CHECK(m.stats.frames == FRAMES, "frame counter");
}

static void t_determinism(void) {
    /* same profile rendered twice must produce identical output */
    memset(mem, 0, 8192);
    for (int i = 0; i < 2048; i++) mem[i] = (uint8_t)(i * 37);
    ug_mixer m; ref_lane rl[UG_LANES];
    uint8_t md[UG_LANES];
    uint32_t cks[2];
    for (int run = 0; run < 2; run++) {
        ug_mixer_init(&m, mock_if());
        memset(rl, 0, sizeof(rl));
        for (int i = 0; i < UG_LANES; i++) {
            md[i] = UG_LANE_MONO;
            both_lane(&m, &rl[i], i, (i % 2) * 2048 + i * 17, 64,
                      4, 60, ((i + 1) * 0.7) * (1ull << 32) +
                      (i * 0x1111), 48 + i, (i * 21) & 0xFF,
                      i & 1, UG_LANE_MONO, 1, 0);
        }
        ug_mixer_render(&m, kbuf, FRAMES);
        cks[run] = m.stats.checksum;
    }
    CHECK(cks[0] == cks[1] && cks[0] != 0, "non-deterministic output");
}

static void t_rounding_stereo_overflow(void) {
    static const int16_t pairs[][3] = {
        {-1, 0, -1}, {-2, -1, -2}, {1, 0, 1}, {0, 1, 1}, {32767, -32768, -1}
    };
    ug_mixer m;
    for (unsigned i = 0; i < sizeof(pairs) / sizeof(pairs[0]); i++) {
        for (unsigned j = 0; j < 2; j++) {
            mem[2*j] = (uint8_t)pairs[i][j];
            mem[2*j+1] = (uint16_t)pairs[i][j] >> 8;
        }
        ug_mixer_init(&m, mock_if());
        CHECK(ug_lane_set(&m, 0, 0, 2, 0, 2, 0, 64, 255,
                         UG_FMT_S16LE, UG_LANE_MONO, 0, 0) == 0, "round lane");
        m.lanes[0].phase = 0x80000000ull;
        ug_mixer_render(&m, kbuf, 1);
        CHECK(kbuf[1] == pairs[i][2], "half tie rounds whole interpolated sample");
    }
    const int16_t stereo[] = {1000,-2000,3000,-4000,5000,-6000};
    for (unsigned i = 0; i < 6; i++) {
        mem[2*i] = (uint8_t)stereo[i]; mem[2*i+1] = (uint16_t)stereo[i] >> 8;
    }
    ug_mixer_init(&m, mock_if());
    CHECK(ug_lane_set(&m,0,0,3,0,3,1ull<<32,64,0,UG_FMT_S16LE,UG_LANE_LEFT,0,0)==0,"left");
    CHECK(ug_lane_set(&m,1,0,3,0,3,1ull<<32,64,0,UG_FMT_S16LE,UG_LANE_RIGHT,0,1)==0,"right");
    ug_mixer_render(&m, kbuf, 4);
    CHECK(!memcmp(kbuf, stereo, sizeof(stereo)) && kbuf[6]==0 && kbuf[7]==0,
          "interleaved stereo stride and exact EOF");
    CHECK(ug_lane_set(&m,0,0,UINT32_MAX,0,0,1ull<<32,64,0,
                     UG_FMT_S8,UG_LANE_RIGHT,0,1)!=0,"span must widen before adding/multiplying");
    ug_mixer_init(&m, mock_if());
    mem[POOL-1]=0xff;
    CHECK(ug_lane_set(&m,0,POOL-1,1,0,0,1ull<<32,64,255,
                     UG_FMT_S8,UG_LANE_MONO,0,0)==0,"last byte valid");
    ug_mixer_render(&m,kbuf,2);
    CHECK(kbuf[1]==-256 && kbuf[3]==0 && mem_oob==0,"pool tail and silence after EOF");
}

static void t_actual_profiles(void) {
    CHECK(ug_profile_load(mock_if()) == 0, "actual fixture load/readback");
    for (unsigned profile = 1; profile <= 2; profile++) {
        uint32_t checksum[2];
        for (unsigned run = 0; run < 2; run++) {
            ug_mixer m;
            CHECK(ug_profile_setup(&m, mock_if(), profile) == 0, "actual profile setup");
            ref_lane reference[12] = {0};
            uint8_t modes[12];
            for (unsigned i = 0; i < 12; i++) {
                const ug_lane *l=&m.lanes[i];
                CHECK(l->active, "12 active lanes");
                reference[i]=(ref_lane){l->src_offset,l->len_samples,l->loop_start,l->loop_end,
                    l->phase,l->step,l->gain,l->pan,l->fmt==UG_FMT_S16LE,l->looped,0,
                    l->ch_off,l->mode==UG_LANE_MONO?1:2};
                modes[i]=l->mode;
            }
            uint32_t warm_fills=0;
            for (unsigned q=0;q<2048;q++) {
                ref_render_stereo(reference,12,modes,rbuf,128,32768);
                ug_mixer_render(&m,kbuf,128);
                CHECK(!memcmp(kbuf,rbuf,128*2*sizeof(int16_t)),"profile vs scalar oracle");
                if (q==9) warm_fills=m.stats.cache_fills;
            }
            CHECK(m.stats.cache_fills>warm_fills+100,"recurring cache misses after warm-up");
            CHECK(m.stats.fetch_errors==0 && m.stats.frames==2048*128,"profile counters");
            checksum[run]=m.stats.checksum;
            if (!run) printf("profile %u: 2048 quanta, cache_fills=%u, checksum=%08x\n",
                            profile,m.stats.cache_fills,checksum[run]);
        }
        CHECK(checksum[0]==checksum[1],"actual profile deterministic");
    }
}

/* NOTE: multi-turn wrap and fractional-vs-step interactions are covered
 * by t_loop_short (step 4.0 over 1..3-sample loops wraps several times
 * per frame) and t_determinism (fractional steps). */
int main(void) {
    t_s8_s16_polarity();
    t_interp();
    t_loop_short();
    t_eof_unlooped();
    t_oob_and_mask();
    t_cacheline_boundary();
    t_saturation();
    t_silence();
    t_determinism();
    t_rounding_stereo_overflow();
    t_actual_profiles();
    if (fails == 0) {
        printf("ALL TESTS PASSED\n");
        return 0;
    }
    printf("%d FAILURES\n", fails);
    return 1;
}
