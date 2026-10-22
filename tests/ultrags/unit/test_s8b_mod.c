/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_mod.h"
#include "ultrags_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct { uint8_t *b; unsigned size,calls,fail; } memory;
static int rd(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    memory *m=ctx;assert(n && n<=256 && off<=m->size && n<=m->size-off);
    m->calls++;if(off==m->fail)return -1;memcpy(dst,m->b+off,n);return 0;
}
static int scan(memory *m,ug_mod_info *i) {
    ug_mod_parser p;ug_mod_parser_init(&p,i,m->size);int rc;
    do {unsigned before=m->calls;rc=ug_mod_parser_step(&p,i,rd,m);assert(m->calls-before<=1);}while(!rc);
    return rc;
}
static memory file(const char *name) {
    FILE *f=fopen(name,"rb");assert(f);memory m={calloc(1,1084+128*2048+256),7484,0,~0u};assert(m.b);
    assert(fread(m.b,1,7484,f)==7484 && fgetc(f)==EOF);fclose(f);return m;
}
static void same(ug_mod_player *a,ug_mod_player *b) {
    assert(a->order==b->order && a->row==b->row && a->tick==b->tick && a->speed==b->speed && a->bpm==b->bpm && a->playing==b->playing && a->paused==b->paused);
    assert(!memcmp(a->channel,b->channel,sizeof(a->channel)));
}
int main(int argc,char **argv) {
    assert(argc==3);memory m=file(argv[1]),ref=file(argv[2]);uint8_t original[7484];memcpy(original,m.b,7484);
    ug_mod_info i,j;assert(scan(&m,&i)==1 && scan(&ref,&j)==1);
    assert(i.flt8 && !j.flt8 && i.channels==8 && i.sample_offset==7228);
    for(unsigned x=0;x<128;x++)assert(i.order[x]==(x<6?x/2:0));
    ug_mod_player a,b;ug_mod_start(&a,&i,rd,&m,0,0);ug_mod_start(&b,&j,rd,&ref,0,0);
    for(unsigned t=0;t<6*64*6;t++) {
        same(&a,&b);
        if(a.row==0 || a.row==63)for(unsigned c=0;c<8;c++){
            assert(a.channel[c].period==856-30*c-8*(a.order/2)-(a.row==63));
            assert(a.channel[c].sample==c && a.channel[c].volume==12);
        }
        ug_mod_tick(&a);ug_mod_tick(&b);
    }
    same(&a,&b);assert(!a.playing && !memcmp(original,m.b,7484));
    puts("FLT8 exact 2304 tick traces vs independent 8CHN; six even/odd orders, row0/63 all channels, EOF, immutable source PASS");
    /* Each half independently carries effects; fixed expectations catch a shared tracker error. */
    const unsigned bases[]={1084,2108};
    for(unsigned half=0;half<2;half++) {
        unsigned off=bases[half];m.b[off+2]=0x11;m.b[off+3]=3;
        ug_mod_start(&a,&i,rd,&m,0,0);ug_mod_tick(&a);
        assert(a.channel[half*4].period==856-120*half-3);
        memcpy(m.b,original,7484);
    }
    const struct {unsigned fx,param,tick,period,volume,pan,triggers;} vectors[]={
        {0,0x37,1,360,32,999,1},{1,3,1,425,32,999,1},{2,3,1,431,32,999,1},
        {4,0x23,3,430,32,999,1},{7,0x23,3,428,36,999,1},{8,127,0,428,32,127,1},
        {9,1,0,428,32,999,1},{10,0x21,1,428,34,999,1},{10,1,1,428,31,999,1},
        {12,255,0,428,64,999,1},{14,0x13,0,425,32,999,1},{14,0x23,0,431,32,999,1},
        {14,0x8a,0,428,32,170,1},{14,0x92,4,428,32,999,3},
        {14,0xa5,0,428,37,999,1},{14,0xb5,0,428,27,999,1},{14,0xc2,2,428,0,999,1},
        {14,0xe2,17,428,32,999,1},{14,0,1,428,32,999,1},{14,0xf3,1,428,32,999,1}
    };
    for(unsigned c=0;c<8;c++)for(unsigned k=0;k<sizeof(vectors)/sizeof(vectors[0]);k++) {
        memset(m.b+1084,0,6144);memset(ref.b+1084,0,6144);
        uint8_t e[4]={1,0xac,(uint8_t)(16|vectors[k].fx),(uint8_t)vectors[k].param};
        memcpy(m.b+1084+(c/4)*1024+(c%4)*4,e,4);
        memcpy(ref.b+1084+c*4,e,4);i.samples[0].volume=j.samples[0].volume=32;
        ug_mod_start(&a,&i,rd,&m,0,0);ug_mod_start(&b,&j,rd,&ref,0,0);
        for(unsigned t=0;t<vectors[k].tick;t++){ug_mod_tick(&a);ug_mod_tick(&b);same(&a,&b);}
        assert(a.channel[c].period==vectors[k].period && a.channel[c].mix_volume==vectors[k].volume && a.channel[c].trigger==vectors[k].triggers);
        assert(a.channel[c].pan==(vectors[k].pan==999?((c%4==1||c%4==2)?255:0):vectors[k].pan));
    }
    memcpy(m.b,original,7484);assert(scan(&m,&i)==1);
    puts("FLT8 160 independent all-channel effect expectations and equivalent 8CHN traces PASS");
    memset(m.b+1084,0,6144);
    m.b[1086]=15;m.b[1087]=2;m.b[2122]=15;m.b[2123]=4;
    ug_mod_start(&a,&i,rd,&m,0,0);assert(a.speed==4);
    m.b[1090]=11;m.b[1091]=1;m.b[2122]=11;m.b[2123]=4;m.b[2118]=13;m.b[2119]=0x12;
    ug_mod_start(&a,&i,rd,&m,0,0);ug_mod_tick(&a);ug_mod_tick(&a);assert(a.order==4 && a.row==12);
    memset(m.b+1084,0,6144);m.b[2122]=15;
    ug_mod_start(&a,&i,rd,&m,UG_MOD_PAUSE_F00,1);assert(a.paused);
    ug_mod_start(&a,&i,rd,&m,UG_MOD_IGNORE_F00,0);assert(!a.paused);
    memcpy(m.b,original,7484);
    puts("FLT8 last-channel F/B/D and explicit F00 policies PASS");
    /* Second-half failure must stop before changing first-half channels. */
    ug_mod_start(&a,&i,rd,&m,0,0);ug_mod_channel prior[8];memcpy(prior,a.channel,sizeof(prior));
    m.fail=2124;for(unsigned t=0;t<6;t++)ug_mod_tick(&a);
    assert(!a.playing && a.error==1 && !memcmp(prior,a.channel,sizeof(prior)));m.fail=~0u;
    m.size=1084+5*1024;assert(scan(&m,&i)==-1);m.size=7483;assert(scan(&m,&i)==-1);m.size=7484;
    m.b[950]=0;assert(scan(&m,&i)==-1);m.b[950]=129;assert(scan(&m,&i)==-1);m.b[950]=6;
    m.b[45]=65;assert(scan(&m,&i)==-1);m.b[45]=12;
    m.b[47]=32;assert(scan(&m,&i)==-1);m.b[47]=0;
    m.b[2108]=0x20;assert(scan(&m,&i)==-1);memcpy(m.b,original,7484);
    m.fail=2108;assert(scan(&m,&i)==-2);m.fail=~0u;
    m.b[1079]=255;assert(scan(&m,&i)==-1);
    m.size=1084+128*2048+256;memset(m.b+7228,0,m.size-7228);
    assert(scan(&m,&i)==1 && i.order[127]==127 && i.sample_offset==263228);
    m.b[952]=255;assert(scan(&m,&i)==1 && i.order[0]==127);
    m.b[263224]=1;m.b[263225]=0xac;m.b[263226]=16;
    ug_mod_start(&a,&i,rd,&m,0,0);assert(a.playing);
    assert(!ug_mod_seek(&a,0,63) && a.channel[7].period==428);
    m.size=263228+255;assert(scan(&m,&i)==-1);
    m.size=7484;memcpy(m.b,original,7484);m.b[950]=1;m.b[1079]=5;
    assert(scan(&m,&i)==1 && i.sample_offset==7228);
    puts("FLT8 bounded cooperative reads; truncated pairs/samples, volume/loop/instrument/song, second-half I/O error, tailFF/pattern127 PASS");
    free(m.b);free(ref.b);return 0;
}
