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
    l->cache_peer=UINT16_MAX;
    l->cache_tag[0] = l->cache_tag[1] = UG_CACHE_TAG_INVALID;
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
    unsigned done=0,bytes=l->fmt==UG_FMT_S16LE?2u:1u;
    unsigned stride=bytes*(l->mode==UG_LANE_MONO?1u:2u);
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
static __attribute__((noinline)) void mix_voice_samples(ug_mixer *m,const ug_lane *l,unsigned voice,unsigned count) {
    uint32_t gain=(uint32_t)l->gain*l->class_gain*l->class_master;
    uint32_t peak=m->lane_peak_current[voice];
    for(unsigned f=0;f<count;f++) {
        int32_t sample=m->voice_samples[f];
        if(gain!=262144u) { sample=scale_gain(sample,gain);m->voice_samples[f]=sample; }
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
    return 0;
}

int ug_mixer_render(ug_mixer *m,int16_t *out,uint32_t frames) {
    return ug_mixer_render_stream(m,out,frames,NULL,NULL);
}
