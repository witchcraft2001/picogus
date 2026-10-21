/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_stream.h"
#include "ultrags_protocol.h"
int ug_stream_init(ug_stream *s,uint32_t offset,uint32_t capacity,
                   uint32_t prefill,uint32_t low,uint32_t rate,
                   uint8_t channels,uint8_t bits,uint8_t sample_format) {
    if(rate<8000 || rate>48000 || (channels!=1 && channels!=2) ||
       (bits==8?sample_format>1:bits!=16 || sample_format!=2)) return -1;
    unsigned frame_bytes=channels*(bits/8);
    if(!capacity || !prefill || prefill>capacity || low>=prefill ||
       ((capacity|prefill|low)&(frame_bytes-1))) return -1;
    memset(s,0,sizeof(*s));
    s->capacity=capacity;s->prefill=prefill;s->low=low;s->offset=offset;
    s->rate=rate;s->channels=channels;s->bits=bits;
    s->sample_format=sample_format;s->frame_bytes=frame_bytes;
    const uint64_t numerator=(uint64_t)rate<<32;
    s->step=numerator/48000;s->step_remainder=(uint32_t)(numerator%48000);
    s->next_sequence=1;s->buffering=1;return 0;
}
uint32_t ug_stream_fill(const ug_stream *s) { return (uint32_t)(s->published-s->consumed)*s->frame_bytes; }
uint32_t ug_stream_free(const ug_stream *s) { return s->capacity-ug_stream_fill(s); }
void ug_stream_publish(ug_stream *s,uint32_t bytes) {
    s->published+=bytes/s->frame_bytes;
    s->write_offset=(s->write_offset+bytes)%s->capacity;
    s->next_sequence++;
    /* A partially filled cache line may contain the previous lap or unpublished
     * bytes. Never keep such a line across a commit. Held taps are independent. */
    s->cache_length=0;
}
static bool take_frame(ug_stream *s,ug_mem_if mem,int16_t tap[2]) {
    if(s->consumed==s->published) return false;
    uint32_t off=s->read_offset;
    if(off<s->cache_offset || off-s->cache_offset>=s->cache_length) {
        uint32_t n=ug_stream_fill(s),tail=s->capacity-off;
        if(n>tail)n=tail;if(n>sizeof(s->cache))n=sizeof(s->cache);
        s->cache_length=0;
        if(!mem.read || mem.read(mem.ctx,s->offset+off,s->cache,n)) {
            s->error=UG_ERR_PSRAM;return false;
        }
        s->cache_offset=off;s->cache_length=n;
    }
    const uint8_t *p=s->cache+(off-s->cache_offset);
    for(unsigned ch=0;ch<s->channels;ch++) {
        if(s->bits==16)tap[ch]=(int16_t)(p[ch*2]|((uint16_t)p[ch*2+1]<<8));
        else tap[ch]=(int16_t)((s->sample_format==0?(int)p[ch]-128:(int)(int8_t)p[ch])*256);
    }
    if(s->channels==1)tap[1]=tap[0];
    ++s->consumed;s->read_offset+=s->frame_bytes;if(s->read_offset==s->capacity)s->read_offset=0;
    return true;
}
static int16_t lerp(int16_t first,int16_t next,uint32_t fraction) {
    int64_t value=(int64_t)first*INT64_C(4294967296)+(int64_t)(next-first)*fraction;
    uint64_t magnitude=(uint64_t)(value<0?-value:value);
    int32_t v=(int32_t)((magnitude+UINT64_C(2147483648))>>32);
    return (int16_t)(value<0?-v:v);
}
bool ug_stream_render(ug_stream *s,ug_mem_if mem,int16_t *out,uint32_t frames) {
    memset(out,0,(size_t)frames*2*sizeof(*out));
    if(s->error)return false;
    if(s->buffering) {
        uint64_t available=s->published-s->position;
        if(!s->eof && (available*s->frame_bytes<s->prefill ||
            (s->fraction && s->have_first && available<2)))return false;
        s->buffering=0;
    }
    for(uint32_t f=0;f<frames;f++) {
        if(s->eof && s->position==s->published)return true;
        if(!s->have_first)s->have_first=take_frame(s,mem,s->tap[0]);
        if(s->have_first && s->fraction && !s->have_next)
            s->have_next=take_frame(s,mem,s->tap[1]);
        if(!s->have_first || (s->fraction && !s->have_next && !s->eof)) {
            if(!s->error) { s->buffering=1;if(s->underruns!=UINT32_MAX)++s->underruns; }
            return false;
        }
        for(unsigned ch=0;ch<2;ch++)
            out[f*2+ch]=s->fraction?lerp(s->tap[0][ch],s->have_next?s->tap[1][ch]:s->tap[0][ch],s->fraction):s->tap[0][ch];
        uint64_t next=(uint64_t)s->fraction+s->step;
        s->residue+=s->step_remainder;
        if(s->residue>=48000) { s->residue-=48000;++next; }
        if(next>>32) {
            ++s->position;s->have_first=s->have_next;s->have_next=0;
            if(s->have_first)memcpy(s->tap[0],s->tap[1],sizeof(s->tap[0]));
        }
        s->fraction=(uint32_t)next;
    }
    return s->eof && s->position==s->published;
}
