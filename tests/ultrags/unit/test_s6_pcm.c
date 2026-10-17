/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_pcm.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static uint8_t file[256];
static int reads, bytes_read, fail_read;
static int rd(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    (void)ctx; assert(n<=16); assert(off<=sizeof(file) && n<=sizeof(file)-off);
    memcpy(dst,file+off,n); reads++; bytes_read+=(int)n; return fail_read?-1:0;
}
static void u16(uint8_t *p,uint16_t n) { p[0]=n; p[1]=n>>8; }
static void u32(uint8_t *p,uint32_t n) { p[0]=n; p[1]=n>>8; p[2]=n>>16; p[3]=n>>24; }
static unsigned chunk(unsigned p,const char *tag,const uint8_t *d,unsigned n) {
    memcpy(file+p,tag,4); u32(file+p+4,n); if(n) memcpy(file+p+8,d,n);
    if(n&1) file[p+8+n]=0; return p+8+n+(n&1);
}
static unsigned make_wav(int data_first,int duplicate_fmt,int bad_align) {
    memset(file,0,sizeof(file)); memcpy(file,"RIFF",4); memcpy(file+8,"WAVE",4);
    uint8_t pcm[4]={0,64,128,255}; uint8_t fmt[16]={0};
    u16(fmt,1); u16(fmt+2,1); u32(fmt+4,11025); u32(fmt+8,11025);
    u16(fmt+12,bad_align?2:1); u16(fmt+14,8);
    unsigned p=12;
    if(data_first) p=chunk(p,"data",pcm,sizeof(pcm));
    p=chunk(p,"JUNK",pcm,3); p=chunk(p,"fmt ",fmt,sizeof(fmt));
    if(duplicate_fmt) p=chunk(p,"fmt ",fmt,sizeof(fmt));
    if(!data_first) p=chunk(p,"data",pcm,sizeof(pcm));
    u32(file+4,p-8); return p;
}
static int parse(unsigned size,ug_pcm_info *out) {
    ug_wav_parser p; ug_wav_parser_init(&p,size); int r=0,guard=0;
    while(r==0 && guard++<100) {
        bytes_read=0; r=ug_wav_parser_step(&p,rd,NULL,out); assert(bytes_read<=24);
    }
    assert(guard<100); return r;
}
int main(void) {
    ug_pcm_info m; uint8_t d[24]={0};
    u32(d,48000); d[4]=2; d[5]=16; d[6]=2; u32(d+12,8);
    assert(!ug_pcm_raw_config(&m,8,d) && m.frames==2 && m.loop_end==2);
    d[7]=1; u32(d+16,1); u32(d+20,2);
    assert(!ug_pcm_raw_config(&m,8,d) && m.loop_start==1);
    d[7]=0; u32(d+16,1); assert(ug_pcm_raw_config(&m,8,d));
    d[7]=2; u32(d+16,0); assert(ug_pcm_raw_config(&m,8,d));
    d[7]=0; u32(d+16,0); d[4]=3; assert(ug_pcm_raw_config(&m,8,d));
    assert(make_wav(0,0,0)>0); reads=0;
    assert(parse(make_wav(0,0,0),&m)==1);
    assert(m.rate==11025 && m.channels==1 && m.bits==8 && m.sample_format==0);
    assert(m.frames==4 && m.data_length==4 && m.data_offset>12 && reads>=4);
    assert(parse(make_wav(1,0,0),&m)==1 && m.rate==11025);
    assert(parse(make_wav(0,1,0),&m)<0);
    assert(parse(make_wav(0,0,1),&m)<0);
    unsigned n=make_wav(0,0,0); assert(parse(n-1,&m)<0);
    file[0]='R'; file[1]='I'; file[2]='F'; file[3]='X'; assert(parse(n,&m)<0);
    n=make_wav(0,0,0); assert(parse(n+5,&m)==1 && m.data_length==4); /* trailing bytes retained */
    fail_read=1;assert(parse(n,&m)==-2);fail_read=0;
    make_wav(0,0,0);u32(file+4,UINT32_MAX);assert(parse(n,&m)==-1);
    make_wav(0,0,0);u32(file+16,UINT32_MAX);assert(parse(n,&m)==-1);
    /* fmt body starts at 32 after the odd JUNK chunk. */
    for(unsigned format=2;format<=0xfffe;format=format==2?3:0xfffe) {
        make_wav(0,0,0);u16(file+32,(uint16_t)format);assert(parse(n,&m)==-1);
        if(format==0xfffe) break;
    }
    make_wav(0,0,0);u32(file+36,0);assert(parse(n,&m)==-1);
    make_wav(0,0,0);u16(file+46,32);assert(parse(n,&m)==-1);
    make_wav(0,0,0);u32(file+40,11026);assert(parse(n,&m)==-1);
    make_wav(0,0,0);u32(file+52,0);assert(parse(n,&m)==-1);
    make_wav(0,0,0);unsigned end=chunk(n,"data",file+20,2);u32(file+4,end-8);assert(parse(end,&m)==-1);
    /* fmt extensions are skipped; required fields still validated. */
    make_wav(0,0,0);memmove(file+52,file+48,12);memset(file+48,0,4);u32(file+28,20);u32(file+4,n-8+4);
    assert(parse(n+4,&m)==1);
    static const uint32_t rates[]={8000,11025,16000,22050,24000,32000,44100,48000,12345};
    for(unsigned ri=0;ri<9;ri++)for(unsigned ch=1;ch<=2;ch++)for(unsigned fmt=0;fmt<=2;fmt++) {
        memset(d,0,sizeof(d));u32(d,rates[ri]);d[4]=ch;d[5]=fmt==2?16:8;d[6]=fmt;u32(d+12,12);
        assert(!ug_pcm_raw_config(&m,12,d) && m.frames==12/(ch*(fmt==2?2:1)));
    }
    u32(d,7999);assert(ug_pcm_raw_config(&m,12,d));u32(d,48001);assert(ug_pcm_raw_config(&m,12,d));
    u32(d,48000);u32(d+8,1);assert(ug_pcm_raw_config(&m,12,d));
    puts("S6 PCM parser: RAW descriptors, RIFF bounds/chunks/padding/data-before-fmt PASS");
    return 0;
}
