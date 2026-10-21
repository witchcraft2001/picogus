/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_stream.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
static uint8_t ring[524288];
static int read_mem(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    (void)ctx;assert(n<=256 && off+n<=sizeof(ring));memcpy(dst,ring+off,n);return 0;
}
static int16_t sample(uint64_t frame,unsigned ch) {
    return ch?(int16_t)(15000-(frame*31)%30000):(int16_t)((frame*73)%30000-15000);
}
static void feed(ug_stream *s,unsigned frames,uint64_t source) {
    assert(frames*4<=ug_stream_free(s));
    for(unsigned i=0;i<frames;i++)for(unsigned ch=0;ch<2;ch++) {
        uint16_t v=(uint16_t)sample(source+i,ch);
        unsigned off=(s->write_offset+i*4+ch*2)%s->capacity;
        ring[off]=v;ring[off+1]=v>>8;
    }
    ug_stream_publish(s,frames*4);
}
static int16_t oracle(uint64_t numerator,uint64_t total,unsigned ch) {
    uint64_t pos=numerator/48000;uint32_t frac=(uint32_t)(((numerator%48000)<<32)/48000);
    int32_t a=sample(pos,ch),b=sample(pos+1<total?pos+1:pos,ch);
    int64_t v=(int64_t)a*INT64_C(4294967296)+(int64_t)(b-a)*frac;
    return (int16_t)ug_rdiv(v,INT64_C(4294967296));
}
static int16_t matrix_sample(uint64_t frame,unsigned ch,unsigned format) {
    if(format==2)return sample(frame,ch);
    unsigned byte=(frame*73+ch*111)&255;
    return (int16_t)((format==0?(int)byte-128:byte<128?(int)byte:(int)byte-256)*256);
}
static void matrix(void) {
    const unsigned rates[]={8000,11025,16000,22050,24000,32000,44100,48000,12345,47999};
    ug_mem_if mem={.read=read_mem,.size=sizeof(ring)};
    for(unsigned r=0;r<10;r++)for(unsigned ch=1;ch<=2;ch++)for(unsigned fmt=0;fmt<3;fmt++)
    for(unsigned cap=1;cap<=3;cap+=2) {
        unsigned bytes=ch*(fmt==2?2:1),total=1031;ug_stream s;
        assert(!ug_stream_init(&s,0,cap*bytes,cap*bytes,0,rates[r],ch,fmt==2?16:8,fmt));
        uint64_t supplied=0,played=0;unsigned iterations=0;
        while(s.position<total) {
            assert(++iterations<100000);
            unsigned n=ug_stream_free(&s)/bytes;if(n>total-supplied)n=total-supplied;
            if(n && (s.buffering || iterations%5)) {
                for(unsigned f=0;f<n;f++)for(unsigned side=0;side<ch;side++) {
                    unsigned off=(s.write_offset+f*bytes+side*(fmt==2?2:1))%s.capacity;
                    int16_t v=matrix_sample(supplied+f,side,fmt);
                    if(fmt==2){ring[off]=(uint16_t)v;ring[off+1]=(uint16_t)v>>8;}
                    else ring[off]=(unsigned)((supplied+f)*73+side*111)&255;
                }
                ug_stream_publish(&s,n*bytes);supplied+=n;
            }
            s.eof=supplied==total;
            for(unsigned f=0;f<17;f++) {
                uint64_t before=s.position;uint32_t fraction=s.fraction,residue=s.residue;int16_t out[2];
                ug_stream_render(&s,mem,out,1);
                if(before!=s.position || fraction!=s.fraction) {
                    uint64_t numerator=played*rates[r],pos=numerator/48000;
                    uint32_t frac=(uint32_t)(((numerator%48000)<<32)/48000);
                    for(unsigned side=0;side<2;side++) {
                        unsigned c=ch==1?0:side;
                        int32_t a=matrix_sample(pos,c,fmt),b=matrix_sample(pos+1<total?pos+1:pos,c,fmt);
                        int64_t v=(int64_t)a*INT64_C(4294967296)+(int64_t)(b-a)*frac;
                        assert(out[side]==ug_rdiv(v,INT64_C(4294967296)));
                    }
                    played++;
                    assert(s.position==played*rates[r]/48000);
                    assert(s.fraction==(uint32_t)(((played*rates[r]%48000)<<32)/48000));
                    assert(s.residue==((played*rates[r]%48000)*UINT64_C(4294967296))%48000);
                } else {assert(!out[0] && !out[1]);assert(s.residue==residue);}
                assert(s.consumed<=s.published && ug_stream_fill(&s)<=s.capacity);
                if(s.position==total)break;
            }
        }
        assert(played==((uint64_t)total*48000+rates[r]-1)/rates[r]);
        assert(s.consumed==s.published);
        /* Repeat at a position crossing 2^32, preserving full counters. */
        assert(!ug_stream_init(&s,0,3*bytes,bytes,0,rates[r],ch,fmt==2?16:8,fmt));
        s.position=s.consumed=s.published=UINT64_C(0xffffffff);memset(ring,128,3*bytes);
        ug_stream_publish(&s,3*bytes);s.eof=1;int16_t out[64];
        assert(ug_stream_render(&s,mem,out,32));assert(s.position==UINT64_C(0x100000002));
    }
    ug_stream s;assert(!ug_stream_init(&s,0,1,1,0,48000,1,8,0));
    ring[0]=128;ug_stream_publish(&s,1);s.eof=1;int16_t out[2];
    assert(ug_stream_render(&s,mem,out,1));assert(!out[0] && !out[1]);
    puts("matrix 10 rates x mono/stereo x U8/S8/S16LE x minimal/arbitrary rings: samples/duration/phase/starvation/64-bit/U8-center PASS");
}
int main(void) {
    matrix();
    ug_mem_if mem={.read=read_mem,.size=sizeof(ring)};ug_stream s;
    assert(ug_stream_init(&s,0,12,8,8,44100,2,16,2));assert(ug_stream_init(&s,0,12,16,4,44100,2,16,2));
    assert(ug_stream_init(&s,0,12,0,0,44100,2,16,2));assert(ug_stream_init(&s,0,13,8,0,44100,2,16,2));
    const unsigned sizes[]={4,12,28,128*1024,256*1024,512*1024,192*1024};
    for(unsigned size=0;size<sizeof(sizes)/sizeof(*sizes);size++) {
        unsigned capacity=sizes[size],prefill=capacity==4?4:(capacity/8)*4;
        assert(!ug_stream_init(&s,0,capacity,prefill,0,44100,2,16,2));
        uint64_t total=capacity/4*3+1031,supplied=0,played=0;
        unsigned stalls=0;
        while(s.position<total) {
            /* Vary packet boundaries and starve often, including fractional
             * last-tap stalls, to compare resumed audio to a resident source. */
            unsigned grant=ug_stream_free(&s)/4;
            unsigned packet=1+(supplied*17)%256;if(grant>packet)grant=packet;
            if(grant>total-supplied)grant=(unsigned)(total-supplied);
            if(grant && (supplied<total/2 || s.buffering || supplied%7)) {
                feed(&s,grant,supplied);supplied+=grant;
            }
            if(supplied==total)s.eof=1;
            for(unsigned q=0;q<17;q++) {
                int16_t out[2];uint64_t before=s.position;uint32_t frac=s.fraction;
                ug_stream_render(&s,mem,out,1);
                if(s.position!=before || s.fraction!=frac) {
                    assert(out[0]==oracle(played*44100,total,0));
                    assert(out[1]==oracle(played*44100,total,1));++played;
                } else { assert(!out[0] && !out[1]);++stalls; }
                assert(s.published>=s.consumed && ug_stream_fill(&s)<=capacity);
                if(s.position==total)break;
            }
        }
        assert(played==(total*48000+44099)/44100);
        assert(s.consumed==total && ug_stream_free(&s)==capacity);
        printf("ring %u bytes: exact stereo/interpolation/EOF %llu frames, stalls %u, underruns %u PASS\n",capacity,(unsigned long long)played,stalls,s.underruns);
    }
    /* Position counters cross 2^32 without truncation. */
    assert(!ug_stream_init(&s,0,12,4,0,44100,2,16,2));
    s.position=s.consumed=s.published=UINT64_C(0x100000000)-1;
    feed(&s,3,s.published);s.eof=1;
    int16_t out[16];assert(ug_stream_render(&s,mem,out,8));
    assert(s.position==UINT64_C(0x100000002) && s.consumed==s.position);
    puts("stream 64-bit positions PASS");
}
