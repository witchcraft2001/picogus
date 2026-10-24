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

/* Both products have bounded16-bit operands. Keep the exact33/48-bit
 * results with two native multiplies, avoiding generic __aeabi_lmul. */
static inline int32_t scale_gain(int32_t sample,uint32_t gain) {
    uint32_t magnitude=(uint32_t)(sample<0?-sample:sample);
    uint32_t low=magnitude*(gain&65535u),high=magnitude*(gain>>16);
    uint32_t rounded=(low+((high&3u)<<16)+131072u)>>18;
    int32_t result=(int32_t)((high>>2)+rounded);
    return sample<0?-result:result;
}
static inline int32_t interpolate(int32_t first,int32_t second,uint32_t fraction) {
    int32_t delta=second-first;
    uint32_t magnitude=(uint32_t)(delta<0?-delta:delta);
    uint32_t a=magnitude*(fraction>>16),b=magnitude*(fraction&65535u);
    uint32_t low=b+(a<<16),high=(a>>16)+(low<b);
    int32_t base=delta<0?first-(int32_t)high:first+(int32_t)high;
    bool round_up=low>UINT32_C(0x80000000) ||
        (low==UINT32_C(0x80000000) && (delta<0?base<=0:base>=0));
    return delta<0?base-round_up:base+round_up;
}

static int ug_fetch_byte(ug_mixer *m, ug_lane *l, uint32_t byte_off,
                         uint8_t *out) {
    if (byte_off >= m->mem.size || !m->mem.read) {
        sat_inc(&m->stats.fetch_errors); l->failed=1;
        m->last_error = -1;
        *out = 0;
        return -1;
    }
    ug_lane *cache=l->cache_peer<UG_LANES?&m->lanes[l->cache_peer]:l;
    uint32_t tag = byte_off & ~(UG_CACHE_LINE - 1u);
    for (int i = 0; i < UG_CACHE_LINES; i++) {
        if (cache->cache_tag[i] == tag) {
            *out = cache->cache[i][byte_off - tag];
            sat_inc(&m->stats.cache_hits);
            cache->cache_victim = (uint8_t)(i ^ 1);
            return 0;
        }
    }
    /* miss: fill one aligned 256B window, truncated at pool end */
    uint32_t n = m->mem.size - tag;
    if (n > UG_CACHE_LINE) n = UG_CACHE_LINE;
    uint8_t v = cache->cache_victim & 1u;
    /* A failed/partial read must not leave a tag for overwritten old data. */
    cache->cache_tag[v] = UG_CACHE_TAG_INVALID;
    int rc = m->mem.read(m->mem.ctx, tag, cache->cache[v], n);
    if (rc != 0) {
        sat_inc(&m->stats.fetch_errors); l->failed=1;
        m->last_error = rc;
        *out = 0;
        return rc;
    }
    if (n < UG_CACHE_LINE) {
        memset(cache->cache[v] + n, 0, UG_CACHE_LINE - n);
    }
    cache->cache_tag[v] = tag;
    cache->cache_victim = (uint8_t)(v ^ 1u);
    sat_inc(&m->stats.cache_fills);
    *out = cache->cache[v][byte_off - tag];
    return 0;
}

/* Fetch sample `idx` of lane l as int16-range value (-32768..32767). */
static int32_t ug_fetch_sample(ug_mixer *m, ug_lane *l, uint32_t idx) {
    if (idx >= l->len_samples) {
        sat_inc(&m->stats.fetch_errors); l->failed=1; m->last_error=-1;
        return 0;
    }
    uint32_t base = l->src_offset + idx*l->stride + l->ch_off*((l->fmt&1)?2u:1u);
    uint8_t b0, b1;
    if (ug_fetch_byte(m, l, base, &b0) != 0) return 0;
    if (l->fmt == UG_FMT_S8) {
        return (int32_t)(int8_t)b0 * 256;
    }
    if (l->fmt == UG_FMT_U8) return ((int32_t)b0 - 128) * 256;
    if (ug_fetch_byte(m, l, base + 1, &b1) != 0) return 0;
    uint16_t value=b0|((uint16_t)b1<<8);
    return l->fmt==UG_FMT_U16LE?(int32_t)value-32768:(int16_t)value;
}

static inline int32_t cached_sample(const uint8_t *p,uint8_t fmt) {
    if(fmt&1) { uint16_t v=p[0]|((uint16_t)p[1]<<8);return fmt==UG_FMT_U16LE?(int32_t)v-32768:(int16_t)v; }
    return fmt==UG_FMT_S8?(int32_t)(int8_t)*p*256:((int32_t)*p-128)*256;
}

/* Both interpolation taps normally live in the same cached line. Resolve it
 * once per lane/frame instead of looking up each byte of both S16 taps. Misses,
 * loop edges, unaligned S16 and bounds faults keep the normal checked path. */
static inline bool cached_pair(ug_mixer *m,ug_lane *l,uint32_t pos,uint32_t next,
                               bool interpolate,int32_t *s0,int32_t *s1) {
    if(pos>=l->len_samples || next>=l->len_samples || !m->mem.read) return false;
    unsigned bytes=(l->fmt&1)?2u:1u;
    uint32_t a=l->src_offset+pos*l->stride+l->ch_off*bytes;
    uint32_t b=interpolate?l->src_offset+next*l->stride+l->ch_off*bytes:a;
    if(a>=m->mem.size || bytes>m->mem.size-a || b>=m->mem.size || bytes>m->mem.size-b) return false;
    uint32_t tag=a&~(UG_CACHE_LINE-1u),ao=a-tag,bo=b-tag;
    /* b can precede tag at a loop wrap. Compare before adding bytes so a
     * wrapped unsigned offset cannot turn into a small in-line offset. */
    if(ao>UG_CACHE_LINE-bytes || bo>UG_CACHE_LINE-bytes) return false;
    ug_lane *cache=l->cache_peer<UG_LANES?&m->lanes[l->cache_peer]:l;
    for(unsigned i=0;i<UG_CACHE_LINES;i++) if(cache->cache_tag[i]==tag) {
        *s0=cached_sample(cache->cache[i]+ao,l->fmt);
        *s1=interpolate?cached_sample(cache->cache[i]+bo,l->fmt):*s0;
        unsigned hits=bytes*(interpolate?2u:1u);
        if(m->stats.cache_hits>UINT32_MAX-hits) m->stats.cache_hits=UINT32_MAX;
        else m->stats.cache_hits+=hits;
        cache->cache_victim=(uint8_t)(i^1u);
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

static void ug_finish_position(ug_lane *l,uint64_t pos,uint64_t lo) {
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
static void ug_advance(ug_lane *l) {
    uint64_t step=l->step;
    if (l->step_remainder) {
        l->step_residue += l->step_remainder;
        if (l->step_residue >= l->step_denominator) {
            l->step_residue -= l->step_denominator; ++step;
        }
    }
    uint64_t lo = (l->phase & 0xFFFFFFFFull) + (step & 0xFFFFFFFFull);
    uint64_t pos = (l->phase >> 32) + (step >> 32) + (lo >> 32);
    ug_finish_position(l,pos,lo);
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
    if(frac) s=interpolate(s0,s1,frac);

    ug_advance(l);
    return s;
}

void ug_lane_advance_silent(ug_lane *l,uint32_t frames) {
    while(frames-- && l->active) ug_advance(l);
}

/* ---- IMA ADPCM (WAV format 0x11) ----
 * Block = per channel {s16 first sample, u8 step index, u8 reserved}, then
 * 4-byte words per channel in turn; each word holds 8 nibbles, low first.
 * Decoding follows the IMA reference (shift-and-add difference). */
static const int16_t ima_steps[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767};
static const int8_t ima_adjust[8] = {-1, -1, -1, -1, 2, 4, 6, 8};

/* Block header of this lane's channel: first sample and step index. */
static int ima_header(ug_mixer *m, ug_lane *l, uint32_t block, int16_t *pred, uint8_t *index) {
    uint32_t off = l->src_offset + block * l->ima_block_align + 4u * l->ch_off;
    uint8_t b0, b1, b2;
    if (ug_fetch_byte(m, l, off, &b0) || ug_fetch_byte(m, l, off + 1, &b1) ||
        ug_fetch_byte(m, l, off + 2, &b2)) return -1;
    *pred = (int16_t)(b0 | ((uint16_t)b1 << 8));
    *index = b2 > 88 ? 88 : b2; /* out-of-range index: clamp, never fault */
    return 0;
}
/* Restart the decoder at a block header. keep: the current sample is the
 * one just before this block, retained as the previous interpolation tap. */
static int ima_seek_block(ug_mixer *m, ug_lane *l, uint32_t block, bool keep) {
    int16_t last = l->ima_pred, pred; uint8_t index;
    if (ima_header(m, l, block, &pred, &index)) { l->ima_valid = 0; return -1; }
    l->ima_prev = last; l->ima_prev_valid = keep;
    l->ima_pred = pred; l->ima_index = index;
    l->ima_bstart = block * l->ima_spb; l->ima_boff = block * l->ima_block_align;
    l->ima_n = l->ima_bstart; l->ima_valid = 1;
    return 0;
}
/* Decode sample ima_n+1, which must lie in the current block. Decoding in a
 * block always starts at its header, so an odd nibble reuses the byte that
 * its even partner fetched: one byte read per two samples, no division. */
static inline int ima_next(ug_mixer *m, ug_lane *l) {
    uint32_t j = l->ima_n - l->ima_bstart;
    unsigned nibble;
    if (!(j & 1u)) {
        uint32_t group = 4u * l->ima_channels;
        uint32_t off = l->src_offset + l->ima_boff + group + 4u * l->ch_off + (j >> 3) * group + ((j & 7u) >> 1);
        if (ug_fetch_byte(m, l, off, &l->ima_byte)) { l->ima_valid = 0; return -1; }
        nibble = l->ima_byte & 15u;
    } else nibble = l->ima_byte >> 4;
    int32_t step = ima_steps[l->ima_index], diff = step >> 3;
    if (nibble & 4) diff += step;
    if (nibble & 2) diff += step >> 1;
    if (nibble & 1) diff += step >> 2;
    int32_t pred = l->ima_pred + ((nibble & 8) ? -diff : diff);
    if (pred > 32767) pred = 32767;
    if (pred < -32768) pred = -32768;
    int32_t index = l->ima_index + ima_adjust[nibble & 7];
    l->ima_index = (uint8_t)(index < 0 ? 0 : index > 88 ? 88 : index);
    l->ima_prev = l->ima_pred; l->ima_prev_valid = 1;
    l->ima_pred = (int16_t)pred; ++l->ima_n;
    return 0;
}
/* Sample k (k < len_samples) of this lane's channel. A backward or
 * cross-block jump restarts at that block's header, so catch-up after any
 * phase jump is bounded by one block. */
static int32_t ima_sample(ug_mixer *m, ug_lane *l, uint32_t k) {
    if (l->ima_valid) {
        if (k == l->ima_n) return l->ima_pred;
        if (k + 1 == l->ima_n && l->ima_prev_valid) return l->ima_prev;
    }
    uint32_t spb = l->ima_spb;
    if (!l->ima_valid || k < l->ima_n || k - l->ima_bstart >= spb) {
        uint32_t block = k / spb;
        if (ima_seek_block(m, l, block, l->ima_valid && l->ima_n + 1 == block * spb)) return 0;
    }
    while (l->ima_n < k) if (ima_next(m, l)) return 0;
    return l->ima_pred;
}
static __attribute__((noinline)) void render_ima_samples(ug_mixer *m, ug_lane *l, unsigned count) {
    unsigned done = 0;
    const uint32_t len = l->len_samples, whole = (uint32_t)(l->step >> 32), step = (uint32_t)l->step;
    const uint32_t remainder = l->step_remainder, denominator = l->step_denominator;
    while (done < count && l->active) {
        uint32_t pos = (uint32_t)(l->phase >> 32), frac = (uint32_t)l->phase;
        if (whole <= 1) {
            /* Sequential run (source rate <= 48 kHz): the decoder stays at pos
             * or pos+1, and both taps are inside the object and its block. */
            uint32_t residue = l->step_residue;
            while (done < count && pos + 1 < len && l->ima_valid) {
                int32_t s0, s1;
                if (pos + 1 == l->ima_n && l->ima_prev_valid) { s0 = l->ima_prev; s1 = l->ima_pred; }
                else if (pos == l->ima_n && pos + 1 - l->ima_bstart < l->ima_spb) {
                    s0 = l->ima_pred;
                    if (ima_next(m, l)) break;
                    s1 = l->ima_pred;
                } else break;
                m->voice_samples[done++] = frac ? interpolate(s0, s1, frac) : s0;
                uint32_t advance = step, extra = 0;
                if (remainder) {
                    residue += remainder;
                    if (residue >= denominator) { residue -= denominator; ++advance; if (!advance) extra = 1; }
                }
                uint32_t next = frac + advance;
                pos += whole + extra + (next < frac); frac = next;
            }
            l->step_residue = residue;
            l->phase = ((uint64_t)pos << 32) | frac; /* pos <= len-1 here */
            if (l->failed) { l->active = 0; break; }
            if (done >= count) break;
        }
        /* One frame through the general path: block edges, object end and
         * whole-object wraps use the same second-tap rule as PCM. */
        if (pos >= len) { sat_inc(&m->stats.fetch_errors); l->failed = 1; m->last_error = -1; l->active = 0; break; }
        int32_t s = ima_sample(m, l, pos);
        if (frac && !l->failed) {
            int32_t s1 = s;
            if (pos + 1 < len) s1 = ima_sample(m, l, pos + 1);
            else if (l->repeats == 0 || l->repeats > 1) {
                int16_t first; uint8_t index;
                s1 = ima_header(m, l, 0, &first, &index) ? 0 : first;
            }
            s = interpolate(s, s1, frac);
        }
        if (l->failed) { l->active = 0; break; }
        m->voice_samples[done++] = s;
        ug_advance(l);
    }
    if (done < count) memset(m->voice_samples + done, 0, (count - done) * sizeof(m->voice_samples[0]));
}


void ug_mixer_init(ug_mixer *m, ug_mem_if mem) {
    memset(m, 0, sizeof(*m));
    m->mem = mem;
    m->vol_q15 = 32768;  /* unity */
    m->stats.checksum = 0x811c9dc5u;
    for (int i = 0; i < UG_LANES; i++) {
        m->lanes[i].cache_peer=UINT16_MAX;
        m->lanes[i].cache_tag[0] = UG_CACHE_TAG_INVALID;
        m->lanes[i].cache_tag[1] = UG_CACHE_TAG_INVALID;
    }
}

int ug_lane_set(ug_mixer *m, unsigned li, uint32_t src_offset,
                uint32_t len_samples, uint32_t loop_start, uint32_t loop_end,
                uint64_t step_q32, uint8_t gain, uint8_t pan,
                uint8_t fmt, uint8_t mode, uint8_t looped, uint8_t ch_off) {
    if(!m || li>=UG_LANES) return -1;
    return ug_lane_configure(m,&m->lanes[li],src_offset,len_samples,loop_start,loop_end,
                            step_q32,gain,pan,fmt,mode,looped,ch_off);
}
int ug_lane_configure(ug_mixer *m,ug_lane *l,uint32_t src_offset,
                uint32_t len_samples,uint32_t loop_start,uint32_t loop_end,
                uint64_t step_q32,uint8_t gain,uint8_t pan,
                uint8_t fmt,uint8_t mode,uint8_t looped,uint8_t ch_off) {
    if (!m || !l || !len_samples) return -1;
    if (fmt != UG_FMT_S8 && fmt != UG_FMT_S16LE && fmt != UG_FMT_U8 && fmt != UG_FMT_U16LE) return -1;
    if ((step_q32 >> 32) > UG_MAX_STEP_INT) return -1;
    if (looped && !(loop_start < loop_end && loop_end <= len_samples)) return -1;
    if (!looped) { loop_start = 0; loop_end = len_samples; }
    /* source range must fit inside declared pool (checked against byte len) */
    uint32_t bps = (fmt&1) ? 2u : 1u;
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
    l->stride = channels*bps;
    l->active = 1;
    l->ended = 0;
    l->cache_peer=UINT16_MAX;
    l->cache_tag[0] = l->cache_tag[1] = UG_CACHE_TAG_INVALID;
    return 0;
}

int ug_lane_set_ima(ug_mixer *m, unsigned li, uint32_t src_offset,
                    uint32_t data_bytes, uint32_t frames, uint16_t block_align,
                    uint16_t spb, uint8_t gain, uint8_t pan,
                    uint8_t mode, uint8_t ch_off) {
    if (!m || li >= UG_LANES || !frames || !data_bytes || !m->mem.read || gain > 64) return -1;
    if (mode != UG_LANE_MONO && mode != UG_LANE_LEFT && mode != UG_LANE_RIGHT) return -1;
    if ((mode == UG_LANE_MONO && ch_off != 0) || (mode == UG_LANE_LEFT && ch_off != 0) ||
        (mode == UG_LANE_RIGHT && ch_off != 1)) return -1;
    uint32_t channels = mode == UG_LANE_MONO ? 1u : 2u, header = 4u * channels;
    if (block_align <= header || (block_align - header) % header ||
        spb != 1u + 8u * ((block_align - header) / header)) return -1;
    if ((uint64_t)src_offset + data_bytes > m->mem.size) return -1;
    /* frames must be decodable from the bytes present, incl. a short last block */
    uint32_t tail = data_bytes % block_align;
    uint64_t capacity = (uint64_t)(data_bytes / block_align) * spb;
    if (tail >= header) capacity += 1u + 8u * ((tail - header) / header);
    if (frames > capacity) return -1;
    ug_lane *l = &m->lanes[li];
    memset(l, 0, sizeof(*l));
    l->src_offset = src_offset;
    l->len_samples = frames;
    l->loop_end = frames;
    l->gain = gain;
    l->class_gain = l->class_master = 64;
    l->repeats = 1;
    l->pan = pan;
    l->fmt = UG_FMT_IMA4;
    l->mode = mode;
    l->ch_off = ch_off;
    l->active = 1;
    l->cache_peer = UINT16_MAX;
    l->cache_tag[0] = l->cache_tag[1] = UG_CACHE_TAG_INVALID;
    l->ima_block_align = block_align;
    l->ima_spb = spb;
    l->ima_channels = (uint8_t)channels;
    return 0;
}

int ug_lane_share_cache(ug_mixer *m,unsigned right,unsigned left) {
    if(!m || right>=UG_LANES || left>=UG_LANES || right==left) return -1;
    ug_lane *r=&m->lanes[right],*l=&m->lanes[left];
    if(r->mode!=UG_LANE_RIGHT || l->mode!=UG_LANE_LEFT || r->src_offset!=l->src_offset ||
       r->len_samples!=l->len_samples || r->fmt!=l->fmt) return -1;
    r->cache_peer=(uint16_t)left;return 0;
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

/* Decode/resample a bounded cache run. The run cannot cross a loop, EOF or
 * cache line; phases and rational-rate residue stay in registers until its end.
 * Edge taps and unusual large steps use the checked generic scalar path. */
static __attribute__((noinline)) void render_voice_samples(ug_mixer *m,ug_lane *l,unsigned count) {
    if(l->fmt==UG_FMT_IMA4) { render_ima_samples(m,l,count); return; }
    unsigned done=0,bytes=(l->fmt&1)?2u:1u;
    unsigned stride=l->stride;
    while(done<count && l->active) {
        uint32_t pos=(uint32_t)(l->phase>>32),frac=(uint32_t)l->phase;
        uint32_t address=l->src_offset+pos*stride+l->ch_off*bytes;
        bool integer=!(uint32_t)l->step && !l->step_remainder && !frac;
        uint32_t limit=l->looped?l->loop_end:l->len_samples;
        unsigned run=0;
        if(pos<limit && address<m->mem.size && bytes<=m->mem.size-address && bytes<=UG_CACHE_LINE-(address&(UG_CACHE_LINE-1u))) {
            uint32_t available=(UG_CACHE_LINE-(address&(UG_CACHE_LINE-1u))-bytes)/stride;
            if(integer) ++available;
            if(limit-pos<available) available=limit-pos;
            if(!integer && available==limit-pos && available) --available;
            uint32_t max_step=(uint32_t)(l->step>>32)+((uint32_t)l->step!=0 || l->step_remainder!=0);
            run=max_step?available/max_step:available?count-done:0;
            if(run>count-done)run=count-done;
        }
        if(!run) { m->voice_samples[done++]=ug_lane_tick(m,l);continue; }
        ug_lane *cache=l->cache_peer<UG_LANES?&m->lanes[l->cache_peer]:l;
        uint32_t tag=address&~(UG_CACHE_LINE-1u);unsigned line=0;
        while(line<UG_CACHE_LINES && cache->cache_tag[line]!=tag) ++line;
        if(line==UG_CACHE_LINES) {
            uint8_t unused;
            if(ug_fetch_byte(m,l,address,&unused)) { l->active=0;break; }
            for(line=0;line<UG_CACHE_LINES && cache->cache_tag[line]!=tag;line++) {}
        }
        const uint8_t *data=cache->cache[line]+(address-tag);
        uint32_t start=pos,residue=l->step_residue,remainder=l->step_remainder,denominator=l->step_denominator;
        uint32_t step=(uint32_t)l->step,whole=(uint32_t)(l->step>>32);
        for(unsigned i=0;i<run;i++) {
            const uint8_t *p=data+(pos-start)*stride;
            int32_t first=cached_sample(p,l->fmt);
            m->voice_samples[done++]=frac?interpolate(first,cached_sample(p+stride,l->fmt),frac):first;
            uint32_t advance=step,extra=0;
            if(remainder) { residue+=remainder;if(residue>=denominator){residue-=denominator;++advance;if(!advance)extra=1;} }
            uint32_t next=frac+advance;pos+=whole+extra+(next<frac);frac=next;
        }
        l->step_residue=residue;ug_finish_position(l,pos,frac);cache->cache_victim=(uint8_t)(line^1u);
        unsigned hits=run*bytes*(integer?1u:2u);
        m->stats.cache_hits=m->stats.cache_hits>UINT32_MAX-hits?UINT32_MAX:m->stats.cache_hits+hits;
    }
    if(done<count)memset(m->voice_samples+done,0,(count-done)*sizeof(m->voice_samples[0]));
}
/* The decoded/gain-scaled voice is bounded to signed16-bit magnitude.
 * MOD headroom uses native32-bit shifts, retaining half-away rounding. */
static inline int32_t headroom(int32_t sample,unsigned shift) {
    uint32_t magnitude=(uint32_t)(sample<0?-sample:sample);
    int32_t rounded=(int32_t)((magnitude+(1u<<(shift-1)))>>shift);
    return sample<0?-rounded:rounded;
}
static __attribute__((noinline)) void mix_voice_samples(ug_mixer *m,const ug_lane *l,unsigned voice,unsigned count) {
    uint32_t gain=(uint32_t)l->gain*l->class_gain*l->class_master;
    uint32_t peak=m->lane_peak_current[voice];
    for(unsigned f=0;f<count;f++) {
        int32_t sample=m->voice_samples[f];
        if(gain!=262144u) sample=scale_gain(sample,gain);
        if(l->mix_shift) sample=headroom(sample,l->mix_shift);
        m->voice_samples[f]=sample;
        uint32_t magnitude=(uint32_t)(sample<0?-sample:sample);if(magnitude>peak)peak=magnitude;
    }
    m->lane_peak_current[voice]=(uint16_t)peak;
    unsigned pan=l->pan;
    if(l->mode==UG_LANE_LEFT || (!l->mode && !pan)) {
        if(pan<=128 || !l->mode) for(unsigned f=0;f<count;f++)m->accumulation[f][0]+=m->voice_samples[f];
        else for(unsigned f=0;f<count;f++)m->accumulation[f][0]+=balance127(m->voice_samples[f],255-pan);
    } else if(l->mode==UG_LANE_RIGHT || (!l->mode && pan==255)) {
        if(pan>=128 || !l->mode) for(unsigned f=0;f<count;f++)m->accumulation[f][1]+=m->voice_samples[f];
        else for(unsigned f=0;f<count;f++)m->accumulation[f][1]+=balance128(m->voice_samples[f],pan);
    } else for(unsigned f=0;f<count;f++) {
        int32_t sample=m->voice_samples[f],left=pan255(sample,255-pan);
        /* 255 is odd: the two independently rounded complementary weights
         * sum exactly to the integer sample, including negative samples. */
        m->accumulation[f][0]+=left;m->accumulation[f][1]+=sample-left;
    }
}

int ug_mixer_render_stream(ug_mixer *m,int16_t *out,uint32_t frames,
                            const int16_t *pcm,const uint16_t voices[2]) {
    if (!m || !out) return -1;
    uint32_t done=0;
    while(done<frames) {
        unsigned count=frames-done;
        if(count>128) count=128;
        if(count>960u-m->peak_frames) count=960u-m->peak_frames;
        memset(m->accumulation,0,count*sizeof(m->accumulation[0]));
        /* Voice-major blocks keep phase/cache hot. Inactive voices cost one
         * test per block; gains are invariant until the next event boundary. */
        for(unsigned i=0;i<UG_LANES;i++) {
            ug_lane *l=&m->lanes[i];
            if(pcm && (i==voices[0] || i==voices[1])) {
                unsigned ch=i==voices[1];
                for(unsigned f=0;f<count;f++)m->voice_samples[f]=pcm[2*(done+f)+ch];
            } else {
                if(!l->active) continue;
                render_voice_samples(m,l,count);
            }
            mix_voice_samples(m,l,i,count);
        }
        for(unsigned f=0;f<count;f++) {
            int32_t accL=m->accumulation[f][0],accR=m->accumulation[f][1];
        if(m->fm) { accL+=m->fm[done+f]; accR+=m->fm[done+f]; }
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
        out[2 * (done+f)] = (int16_t)accL;
        out[2 * (done+f) + 1] = (int16_t)accR;
        /* FNV-1a over both samples (LE order) */
        for (unsigned ch = 0; ch < 2; ch++) {
            uint16_t v = (uint16_t)out[2 * (done+f) + ch];
            m->stats.checksum = (m->stats.checksum ^ (v & 0xffu)) * 0x01000193u;
            m->stats.checksum = (m->stats.checksum ^ (v >> 8)) * 0x01000193u;
        }
        sat_inc(&m->stats.frames);
        }
        done+=count;
    }
    if(m->fm) m->fm+=frames;
    return 0;
}

int ug_mixer_render(ug_mixer *m,int16_t *out,uint32_t frames) {
    return ug_mixer_render_stream(m,out,frames,NULL,NULL);
}
