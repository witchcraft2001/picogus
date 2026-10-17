/* SPDX-License-Identifier: GPL-2.0-or-later */
/* Independent scalar oracle: absolute rational time, no production helpers. */
#include "ug_render.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>

static uint8_t memory[8u<<20];
static int fail;
static int read_mem(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    (void)ctx; assert(n<=256 && off<=sizeof(memory) && n<=sizeof(memory)-off);
    memcpy(dst,memory+off,n);
    if(fail) { memset(dst,0xa5,n/2); return -7; }
    return 0;
}
static int64_t nearest(int64_t n,int64_t d) {
    int64_t magnitude=n<0?-n:n;
    int64_t result=magnitude/d+(magnitude%d>=((d+1)/2));
    return n<0?-result:result;
}
static int sample(unsigned idx,unsigned side,unsigned fmt) {
    int value=(int)((idx*53+side*117)%256)-128;
    return fmt==UG_FMT_S16LE ? value*251+(int)(idx%7) : value*256;
}
static void encode(uint32_t off,unsigned frames,unsigned channels,unsigned fmt) {
    for(unsigned i=0;i<frames;i++) for(unsigned side=0;side<channels;side++) {
        int v=sample(i,side,fmt);
        unsigned pos=off+(i*channels+side)*(fmt==UG_FMT_S16LE?2:1);
        if(fmt==UG_FMT_S16LE) { memory[pos]=(uint16_t)v; memory[pos+1]=(uint16_t)v>>8; }
        else memory[pos]=(v/256)+(fmt==UG_FMT_U8?128:0);
    }
}
static int reference(uint64_t frame,unsigned rate,unsigned frames,unsigned repeats,
                     unsigned loop,unsigned side,unsigned channels,unsigned fmt,
                     unsigned pan,unsigned gain,unsigned class_gain,unsigned master) {
    uint64_t numerator=frame*rate;
    if(!loop && repeats && numerator>=(uint64_t)frames*repeats*48000) return 0;
    uint64_t position=numerator/48000, pass=position/frames;
    unsigned fraction=(unsigned)(((numerator%48000)<<32)/48000);
    if(loop && position>=frames-2) position=3+(position-3)%(frames-5);
    else if(!loop) position%=frames;
    unsigned tap=(unsigned)position+1;
    if(loop && tap>=frames-2) tap=3;
    else if(!loop && tap>=frames) tap=(!repeats || pass+1<repeats)?0:frames-1;
    int64_t weighted=(int64_t)sample((unsigned)position,side,fmt)*(0x100000000ll-fraction)
                    +(int64_t)sample(tap,side,fmt)*fraction;
    int s=(int)nearest(weighted,0x100000000ll);
    s=(int)nearest((int64_t)s*gain*class_gain*master,64*64*64);
    if(channels==1) return (int)nearest((int64_t)s*(side?pan:255-pan),255);
    if(side==0 && pan>128) return (int)nearest((int64_t)s*(255-pan),127);
    if(side==1 && pan<128) return (int)nearest((int64_t)s*pan,128);
    return s;
}
static void matrix(void) {
    static const unsigned rates[]={8000,11025,16000,22050,24000,32000,44100,48000,12345};
    static const unsigned pans[]={0,1,127,128,129,254,255};
    ug_mem_if mem={read_mem,NULL,NULL,sizeof(memory)};
    unsigned cases=0;
    for(unsigned ri=0;ri<9;ri++) for(unsigned ch=1;ch<=2;ch++)
    for(unsigned fmt=0;fmt<3;fmt++) for(unsigned repeat=0;repeat<=3;repeat++)
    for(unsigned loop=0;loop<=1;loop++) for(unsigned pi=0;pi<7;pi++) {
        if(loop && repeat!=1) continue;
        unsigned frames=97,rate=rates[ri],pan=pans[pi];
        uint32_t offset=(4u<<20)+251; /* unaligned source beyond 4 MiB */
        encode(offset,frames,ch,fmt);
        ug_mixer m; ug_mixer_init(&m,mem);
        unsigned gain=pi==1?4:64,class_gain=pi==1?4:64,master=pi==1?4:64;
        for(unsigned side=0;side<ch;side++) {
            assert(!ug_lane_set(&m,side,offset,frames,3,frames-2,0,gain,pan,fmt,
                                ch==1?UG_LANE_MONO:side?UG_LANE_RIGHT:UG_LANE_LEFT,loop,side));
            ug_lane_pcm_rate(&m.lanes[side],rate,48000,repeat);
            m.lanes[side].class_gain=class_gain; m.lanes[side].class_master=master;
        }
        uint64_t duration=((uint64_t)frames*repeat*48000+rate-1)/rate;
        unsigned count=(repeat && !loop)?(unsigned)duration+17:2200;
        for(unsigned frame=0;frame<count;) {
            int16_t out[256]; unsigned n=count-frame; if(n>128)n=128;
            assert(!ug_mixer_render(&m,out,n));
            for(unsigned j=0;j<n;j++) for(unsigned side=0;side<2;side++) {
                /* Mono source channel is always zero; pan selects output side. */
                int expected=reference(frame+j,rate,frames,repeat,loop,ch==1?0:side,ch,fmt,
                                       pan,gain,class_gain,master);
                if(ch==1 && side==1) {
                    expected=reference(frame+j,rate,frames,repeat,loop,0,ch,fmt,
                                       255-pan,gain,class_gain,master);
                }
                if(out[2*j+side]!=expected) {
                    fprintf(stderr,"oracle rate=%u ch=%u fmt=%u repeats=%u loop=%u pan=%u frame=%u side=%u got=%d want=%d\n",
                            rate,ch,fmt,repeat,loop,pan,frame+j,side,out[2*j+side],expected);
                    abort();
                }
            }
            frame+=n;
        }
        assert((bool)m.lanes[0].active==(loop || !repeat)); cases++;
    }
    printf("S6 scalar oracle: %u rate/format/channel/pan/repeat/loop cases, exact samples/durations, source >4 MiB PASS\n",cases);
}
static void faults_and_peaks(void) {
    ug_mixer m; ug_mem_if mem={read_mem,NULL,NULL,sizeof(memory)};
    ug_mixer_init(&m,mem); memory[0]=255;
    for(unsigned i=0;i<12;i++) {
        assert(!ug_lane_set(&m,i,0,1,0,1,0,64,0,UG_FMT_U8,UG_LANE_MONO,0,0));
        ug_lane_pcm_rate(&m.lanes[i],48000,48000,0);
    }
    int16_t out[1920]; ug_mixer_render(&m,out,960);
    assert(out[0]==32767 && out[1]==0 && m.stats.clips==960);
    assert(m.peaks[0]==32768 && m.peaks[1]==0 && m.lane_peaks[0]==32512);
    m.stats.clips=m.stats.frames=UINT32_MAX; ug_mixer_render(&m,out,1);
    assert(m.stats.clips==UINT32_MAX && m.stats.frames==UINT32_MAX);
    ug_mixer_init(&m,mem);
    assert(!ug_lane_set(&m,0,0,800,0,0,1ull<<32,64,0,UG_FMT_U8,UG_LANE_MONO,0,0));
    ug_mixer_render(&m,out,1); assert(m.lanes[0].cache_tag[0]==0);
    m.lanes[0].phase=256ull<<32; ug_mixer_render(&m,out,1);
    fail=1; m.lanes[0].phase=512ull<<32; ug_mixer_render(&m,out,1); fail=0;
    assert(out[0]==0 && out[1]==0 && m.lanes[0].failed && !m.lanes[0].active);
    assert(m.lanes[0].cache_tag[0]==UG_CACHE_TAG_INVALID && m.stats.fetch_errors);
    puts("S6 clipping/20 ms peaks/saturating counters/partial cache read fault PASS");
}
int main(void) { matrix(); faults_and_peaks(); return 0; }
