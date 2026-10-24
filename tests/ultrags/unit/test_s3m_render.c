/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_render.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
static uint8_t data[1024];
static int rd(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    (void)ctx;assert(n<=256 && off<=sizeof(data) && n<=sizeof(data)-off);memcpy(dst,data+off,n);return 0;
}
int main(void) {
    ug_mixer m;int16_t out[32];
    for(unsigned fmt=0;fmt<4;fmt++) {
        unsigned bytes=fmt&1?2:1;
        const int16_t values[8]={-32768,-16384,0,16384,32512,-256,256,8192};
        memset(data,0,sizeof(data));
        for(unsigned side=0;side<2;side++)for(unsigned n=0;n<8;n++) {
            int v=values[(n+side)%8];unsigned off=250+side*8*bytes+n*bytes;
            if(fmt==UG_FMT_U8)v=v/256+128;else if(fmt==UG_FMT_S8)v/=256;else if(fmt==UG_FMT_U16LE)v+=32768;
            data[off]=(uint8_t)v;if(bytes==2)data[off+1]=(uint16_t)v>>8;
        }
        ug_mixer_init(&m,(ug_mem_if){rd,NULL,NULL,sizeof(data)});
        for(unsigned side=0;side<2;side++) {
            assert(!ug_lane_set(&m,side,250+side*8*bytes,8,2,7,(uint64_t)1<<32,64,128,fmt,UG_LANE_MONO,1,0));
            m.lanes[side].phase=0;m.lanes[side].mode=side?UG_LANE_RIGHT:UG_LANE_LEFT;
        }
        assert(!ug_mixer_render(&m,out,16));
        for(unsigned n=0;n<16;n++) { unsigned pos=n<7?n:2+(n-7)%5;
            assert(out[n*2]==values[pos] && out[n*2+1]==values[(pos+1)%8]); }
        assert(!m.stats.fetch_errors);
        /* Fractional interpolation and loop wrap: independent arithmetic. */
        m.lanes[0].phase=((uint64_t)6<<32)|0x80000000;m.lanes[0].step=(uint64_t)1<<31;m.lanes[1].active=0;
        assert(!ug_mixer_render(&m,out,1));assert(out[0]==128 && out[1]==0);
    }
    puts("S3M analytical S8/U8/S16/U16 planar L/R, cache boundary, intro/loop endpoint and interpolation PASS");return 0;
}
