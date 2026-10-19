/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  Ultra GS S0a synthetic render kernel -- shared between firmware
 *  (pg-ultrags-diag) and host unit tests. All PSRAM access is through
 *  the ug_mem_if callback, bounded by the declared pool size.
 */
#include "ug_render.h"

/* Maximum step accepted in Q32.32 integer part; keeps pos+step math safe */
#define UG_MAX_STEP_INT 0x00FFFFFFu
static void sat_inc(uint32_t *v) { if (*v != UINT32_MAX) ++*v; }
static void peak_update(uint16_t *peak,int32_t sample) {
    uint32_t n=(uint32_t)(sample<0?-(int64_t)sample:sample);
    if(n>32768) n=32768;
    if(n>*peak) *peak=(uint16_t)n;
}

/* All callers are bounded fixed-point audio values, never INT64_MIN.
 * Avoid signed division helpers in the per-sample Cortex-M0+ path while
 * retaining nearest/half-away-from-zero rounding exactly. */
static inline int32_t round_shift(int64_t value,unsigned bits) {
    uint64_t magnitude=(uint64_t)(value<0?-value:value);
    int32_t rounded=(int32_t)((magnitude+(1ull<<(bits-1)))>>bits);
    return value<0?-rounded:rounded;
}

/* Exact floor division for the bounded pan numerators (sample <=32768).
 * The shifted quotient underestimates by at most 2/3; the small remainder
 * correction is exact. No 64-bit multiply or divide is needed. */
static inline uint32_t div255(uint32_t n) {
    uint32_t q=(n>>8)+(n>>16);
    uint32_t r=n-((q<<8)-q)+1;
    return q+((r+(r>>8))>>8);
}
static inline uint32_t div127(uint32_t n) {
    uint32_t q=(n>>7)+(n>>14)+(n>>21);
    uint32_t r=n-((q<<7)-q)+1;
    return q+((r+(r>>7))>>7);
}
static inline int32_t pan255(int32_t sample,unsigned weight) {
    uint32_t n=(uint32_t)(sample<0?-sample:sample)*weight+127;
    int32_t q=(int32_t)div255(n);
    return sample<0?-q:q;
}
static inline int32_t balance127(int32_t sample,unsigned weight) {
    uint32_t n=(uint32_t)(sample<0?-sample:sample)*weight+63;
    int32_t q=(int32_t)div127(n);
    return sample<0?-q:q;
}
static inline int32_t balance128(int32_t sample,unsigned weight) {
    uint32_t n=(uint32_t)(sample<0?-sample:sample)*weight+64;
    int32_t q=(int32_t)(n>>7);
    return sample<0?-q:q;
}

static int ug_fetch_byte(ug_mixer *m, ug_lane *l, uint32_t byte_off,
                         uint8_t *out) {
    if (byte_off >= m->mem.size || !m->mem.read) {
        sat_inc(&m->stats.fetch_errors); l->failed=1;
        m->last_error = -1;
        *out = 0;
        return -1;
    }
    uint32_t tag = byte_off & ~(UG_CACHE_LINE - 1u);
    for (int i = 0; i < UG_CACHE_LINES; i++) {
        if (l->cache_tag[i] == tag) {
            *out = l->cache[i][byte_off - tag];
            sat_inc(&m->stats.cache_hits);
            l->cache_victim = (uint8_t)(i ^ 1);
            return 0;
        }
    }
    /* miss: fill one aligned 256B window, truncated at pool end */
    uint32_t n = m->mem.size - tag;
    if (n > UG_CACHE_LINE) n = UG_CACHE_LINE;
    uint8_t v = l->cache_victim & 1u;
    /* A failed/partial read must not leave a tag for overwritten old data. */
    l->cache_tag[v] = UG_CACHE_TAG_INVALID;
    int rc = m->mem.read(m->mem.ctx, tag, l->cache[v], n);
    if (rc != 0) {
        sat_inc(&m->stats.fetch_errors); l->failed=1;
        m->last_error = rc;
        *out = 0;
        return rc;
    }
    if (n < UG_CACHE_LINE) {
        memset(l->cache[v] + n, 0, UG_CACHE_LINE - n);
    }
    l->cache_tag[v] = tag;
    l->cache_victim = (uint8_t)(v ^ 1u);
    sat_inc(&m->stats.cache_fills);
    *out = l->cache[v][byte_off - tag];
    return 0;
}

/* Fetch sample `idx` of lane l as int16-range value (-32768..32767). */
static int32_t ug_fetch_sample(ug_mixer *m, ug_lane *l, uint32_t idx) {
    if (idx >= l->len_samples) {
        sat_inc(&m->stats.fetch_errors); l->failed=1; m->last_error=-1;
        return 0;
    }
    uint32_t channels = l->mode == UG_LANE_MONO ? 1u : 2u;
    uint32_t base = l->src_offset + (idx * channels + l->ch_off) *
                    (l->fmt == UG_FMT_S16LE ? 2u : 1u);
    uint8_t b0, b1;
    if (ug_fetch_byte(m, l, base, &b0) != 0) return 0;
    if (l->fmt == UG_FMT_S8) {
        return (int32_t)(int8_t)b0 * 256;
    }
    if (l->fmt == UG_FMT_U8) return ((int32_t)b0 - 128) * 256;
    if (ug_fetch_byte(m, l, base + 1, &b1) != 0) return 0;
    return (int32_t)(int16_t)(b0 | ((uint16_t)b1 << 8));
}

static inline int32_t cached_sample(const uint8_t *p,uint8_t fmt) {
    if(fmt==UG_FMT_S16LE) return (int16_t)(p[0]|((uint16_t)p[1]<<8));
    return fmt==UG_FMT_S8?(int32_t)(int8_t)*p*256:((int32_t)*p-128)*256;
}

/* Both interpolation taps normally live in the same cached line. Resolve it
 * once per lane/frame instead of looking up each byte of both S16 taps. Misses,
 * loop edges, unaligned S16 and bounds faults keep the normal checked path. */
static inline bool cached_pair(ug_mixer *m,ug_lane *l,uint32_t pos,uint32_t next,
                               bool interpolate,int32_t *s0,int32_t *s1) {
    if(pos>=l->len_samples || next>=l->len_samples || !m->mem.read) return false;
    unsigned bytes=l->fmt==UG_FMT_S16LE?2u:1u;
    unsigned channels=l->mode==UG_LANE_MONO?1u:2u;
    uint32_t a=l->src_offset+(pos*channels+l->ch_off)*bytes;
    uint32_t b=interpolate?l->src_offset+(next*channels+l->ch_off)*bytes:a;
    if(a>=m->mem.size || bytes>m->mem.size-a || b>=m->mem.size || bytes>m->mem.size-b) return false;
    uint32_t tag=a&~(UG_CACHE_LINE-1u),ao=a-tag,bo=b-tag;
    /* b can precede tag at a loop wrap. Compare before adding bytes so a
     * wrapped unsigned offset cannot turn into a small in-line offset. */
    if(ao>UG_CACHE_LINE-bytes || bo>UG_CACHE_LINE-bytes) return false;
    for(unsigned i=0;i<UG_CACHE_LINES;i++) if(l->cache_tag[i]==tag) {
        *s0=cached_sample(l->cache[i]+ao,l->fmt);
        *s1=interpolate?cached_sample(l->cache[i]+bo,l->fmt):*s0;
        unsigned hits=bytes*(interpolate?2u:1u);
        if(m->stats.cache_hits>UINT32_MAX-hits) m->stats.cache_hits=UINT32_MAX;
        else m->stats.cache_hits+=hits;
        l->cache_victim=(uint8_t)(i^1u);
        return true;
    }
    return false;
}

static uint32_t ug_wrap(ug_lane *l, uint64_t pos_i) {
    /* The intro precedes loop_start; later wraps stay inside the loop. */
    if (pos_i < l->loop_end) return (uint32_t)pos_i;
    uint32_t llen = l->loop_end - l->loop_start;
    uint64_t rel = pos_i - l->loop_start;
    if (llen && rel >= llen) {
        /* PSRAM positions fit u32; retain the wide fallback for arbitrary
         * ug_mem_if users and still handle multi-turn short loops. */
        if(rel<=UINT32_MAX) rel=(uint32_t)rel%llen;
        else rel%=llen;
    }
    return l->loop_start + (uint32_t)rel;
}

static void ug_advance(ug_lane *l) {
    uint64_t step=l->step;
    if (l->step_denominator) {
        l->step_residue += l->step_remainder;
        if (l->step_residue >= l->step_denominator) {
            l->step_residue -= l->step_denominator; ++step;
        }
    }
    uint64_t lo = (l->phase & 0xFFFFFFFFull) + (step & 0xFFFFFFFFull);
    uint64_t pos = (l->phase >> 32) + (step >> 32) + (lo >> 32);
    if (l->looped) {
        l->phase = ((uint64_t)ug_wrap(l, pos) << 32) | (lo & 0xFFFFFFFFull);
    } else {
        while (pos >= l->len_samples && (l->repeats==0 || l->repeats>1)) {
            pos -= l->len_samples;
            if (l->repeats) --l->repeats;
        }
        if (pos >= l->len_samples) {
            /* EOF: park at last sample and mute */
            l->ended = 1;
            l->active = 0;
            l->phase = ((uint64_t)(l->len_samples - 1) << 32);
            return;
        }
        l->phase = (pos << 32) | (lo & 0xFFFFFFFFull);
    }
}

static int32_t ug_lane_tick(ug_mixer *m, ug_lane *l) {
    if (!l->active || l->len_samples == 0) return 0;
    uint32_t pos = (uint32_t)(l->phase >> 32);
    uint32_t frac = (uint32_t)(l->phase & 0xFFFFFFFFull);

    /* second tap position */
    uint32_t pos1;
    if (l->looped) {
        pos1 = (pos + 1 >= l->loop_end) ? l->loop_start : pos + 1;
    } else {
        /* Whole-object repeats interpolate across the wrap; the final pass
         * of a finite PLAY clamps its last tap without extending duration. */
        pos1 = pos + 1;
        if(pos1>=l->len_samples) pos1=(l->repeats==0 || l->repeats>1)?0:l->len_samples-1;
    }
    int32_t s0,s1;
    if(!cached_pair(m,l,pos,pos1,frac!=0,&s0,&s1)) {
        s0=ug_fetch_sample(m,l,pos);
        s1=frac?ug_fetch_sample(m,l,pos1):s0;
    }
    if (l->failed) { l->active=0; return 0; }

    /* linear interpolation, rounding half away from zero */
    int32_t s=s0;
    if(frac) {
        int64_t weighted=(int64_t)s0*0x100000000ll+(int64_t)(s1-s0)*frac;
        s=round_shift(weighted,32);
    }

    /* Multiply all three gains before rounding, preserving quiet samples. */
    uint32_t gain=(uint32_t)l->gain*l->class_gain*l->class_master;
    if(gain!=64u*64*64) s=round_shift((int64_t)s*gain,18);

    ug_advance(l);
    return s;
}

void ug_mixer_init(ug_mixer *m, ug_mem_if mem) {
    memset(m, 0, sizeof(*m));
    m->mem = mem;
    m->vol_q15 = 32768;  /* unity */
    m->stats.checksum = 0x811c9dc5u;
    for (int i = 0; i < UG_LANES; i++) {
        m->lanes[i].cache_tag[0] = UG_CACHE_TAG_INVALID;
        m->lanes[i].cache_tag[1] = UG_CACHE_TAG_INVALID;
    }
}

int ug_lane_set(ug_mixer *m, unsigned li, uint32_t src_offset,
                uint32_t len_samples, uint32_t loop_start, uint32_t loop_end,
                uint64_t step_q32, uint8_t gain, uint8_t pan,
                uint8_t fmt, uint8_t mode, uint8_t looped, uint8_t ch_off) {
    if (li >= UG_LANES || !m || !len_samples) return -1;
    if (fmt != UG_FMT_S8 && fmt != UG_FMT_S16LE && fmt != UG_FMT_U8) return -1;
    if ((step_q32 >> 32) > UG_MAX_STEP_INT) return -1;
    if (looped && !(loop_start < loop_end && loop_end <= len_samples)) return -1;
    if (!looped) { loop_start = 0; loop_end = len_samples; }
    /* source range must fit inside declared pool (checked against byte len) */
    uint32_t bps = fmt == UG_FMT_S16LE ? 2u : 1u;
    uint32_t channels = mode == UG_LANE_MONO ? 1u : 2u;
    if ((mode == UG_LANE_MONO && ch_off != 0) ||
        (mode == UG_LANE_LEFT && ch_off != 0) ||
        (mode == UG_LANE_RIGHT && ch_off != 1) || !m->mem.read)
        return -1;
    uint64_t span = (uint64_t)len_samples * channels * bps;
    if ((uint64_t)src_offset + span > m->mem.size) return -1;
    if (mode != UG_LANE_MONO && mode != UG_LANE_LEFT && mode != UG_LANE_RIGHT)
        return -1;
    if (gain > 64) return -1;

    ug_lane *l = &m->lanes[li];
    memset(l, 0, sizeof(*l));
    l->src_offset = src_offset;
    l->len_samples = len_samples;
    l->loop_start = loop_start;
    l->loop_end = loop_end;
    l->step = step_q32;
    l->phase = ((uint64_t)loop_start << 32); /* start at loop_start/first sample */
    if (!looped) l->phase = 0;
    l->gain = gain;
    l->class_gain = l->class_master = 64;
    l->repeats = 1;
    l->pan = pan;
    l->fmt = fmt;
    l->mode = mode;
    l->looped = looped;
    l->ch_off = ch_off;
    l->active = 1;
    l->ended = 0;
    l->cache_tag[0] = l->cache_tag[1] = UG_CACHE_TAG_INVALID;
    return 0;
}

void ug_lane_pcm_rate(ug_lane *l,uint32_t rate,uint32_t output_rate,uint16_t repeats) {
    uint64_t numerator=(uint64_t)rate<<32;
    l->step=numerator/output_rate;
    l->step_remainder=(uint32_t)(numerator%output_rate);
    l->step_denominator=output_rate; l->step_residue=0;
    l->repeats=repeats;
    /* A sample loop plays its intro once before wrapping to loop_start. */
    l->phase=0;
}

int ug_mixer_render(ug_mixer *m, int16_t *out, uint32_t frames) {
    if (!m || !out) return -1;
    for (uint32_t f = 0; f < frames; f++) {
        int32_t accL = 0, accR = 0;
        for (int i = 0; i < UG_LANES; i++) {
            ug_lane *l = &m->lanes[i];
            int32_t s = ug_lane_tick(m, l);
            peak_update(&m->lane_peak_current[i],s);
            if (!s) continue;
            if (l->mode == UG_LANE_LEFT) {       /* stereo balance, left sample */
                accL += l->pan<=128 ? s : balance127(s,255-l->pan);
            } else if (l->mode == UG_LANE_RIGHT) { /* stereo balance, right sample */
                accR += l->pan>=128 ? s : balance128(s,l->pan);
            } else {
                /* mono pan: L = s*(255-pan)/255, R = s*pan/255 */
                if(l->pan==0) accL+=s;
                else if(l->pan==255) accR+=s;
                else { accL+=pan255(s,255-l->pan);accR+=pan255(s,l->pan); }
            }
        }
        /* master volume scale, then saturate to S16 without overflow */
        if(m->vol_q15!=32768) {
            accL=round_shift((int64_t)accL*m->vol_q15,15);
            accR=round_shift((int64_t)accR*m->vol_q15,15);
        }
        peak_update(&m->peak_current[0],accL); peak_update(&m->peak_current[1],accR);
        if(++m->peak_frames==960) {
            memcpy(m->peaks,m->peak_current,sizeof(m->peaks));
            memcpy(m->lane_peaks,m->lane_peak_current,sizeof(m->lane_peaks));
            memset(m->peak_current,0,sizeof(m->peak_current));
            memset(m->lane_peak_current,0,sizeof(m->lane_peak_current));
            m->peak_frames=0;
        }
        if (accL > 32767) { accL = 32767; sat_inc(&m->stats.clips); }
        if (accL < -32768) { accL = -32768; sat_inc(&m->stats.clips); }
        if (accR > 32767) { accR = 32767; sat_inc(&m->stats.clips); }
        if (accR < -32768) { accR = -32768; sat_inc(&m->stats.clips); }
        out[2 * f] = (int16_t)accL;
        out[2 * f + 1] = (int16_t)accR;
        /* FNV-1a over both samples (LE order) */
        for (unsigned ch = 0; ch < 2; ch++) {
            uint16_t v = (uint16_t)out[2 * f + ch];
            m->stats.checksum = (m->stats.checksum ^ (v & 0xffu)) * 0x01000193u;
            m->stats.checksum = (m->stats.checksum ^ (v >> 8)) * 0x01000193u;
        }
        sat_inc(&m->stats.frames);
    }
    return 0;
}
