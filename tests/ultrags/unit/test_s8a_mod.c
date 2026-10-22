/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_mod.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct { uint8_t *p; uint32_t n; int fail; } mem_t;
static int read_mem(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    assert(n<=256);mem_t *m=ctx;if(m->fail || off>m->n || n>m->n-off)return -1;
    memcpy(dst,m->p+off,n);return 0;
}
static void be16(uint8_t *p,unsigned n) { p[0]=(uint8_t)(n>>8);p[1]=(uint8_t)n; }
static void event(mem_t *m,unsigned row,unsigned ch,unsigned smp,unsigned period,unsigned fx,unsigned param) {
    uint8_t *e=m->p+1084+row*32+(ch==0?7:ch)*4;
    e[0]=(uint8_t)((smp&0xf0)|(period>>8));e[1]=(uint8_t)period;
    e[2]=(uint8_t)((smp<<4)|fx);e[3]=(uint8_t)param;
}
static void clear(mem_t *m) { memset(m->p+1084,0,65*2048); }
static void ticks(ug_mod_player *p,unsigned n) { while(n--)ug_mod_tick(p); }
int main(void) {
    uint32_t size=1084+65*2048+1024;mem_t m={calloc(1,size),size,0};assert(m.p);
    uint8_t *b=m.p;b[950]=65;
    for(unsigned i=0;i<65;i++)b[952+i]=(uint8_t)i;
    memcpy(b+1080,"8CHN",4);be16(b+42,512);b[45]=64;be16(b+46,16);be16(b+48,32);
    ug_mod_info info;assert(!ug_mod_parse(&info,read_mem,&m,size));
    assert(info.song_length==65 && info.sample_offset==1084+65*2048);
    memcpy(b+1080,"8CHN",4);assert(!ug_mod_parse(&info,read_mem,&m,size));
    memcpy(b+1080,"FLT9",4);assert(ug_mod_parse(&info,read_mem,&m,size)==-1);
    memcpy(b+1080,"8CHN",4);b[952]=128;assert(ug_mod_parse(&info,read_mem,&m,size)==-1);
    b[952]=0;b[45]=65;assert(ug_mod_parse(&info,read_mem,&m,size)==-1);b[45]=64;
    m.fail=1;assert(ug_mod_parse(&info,read_mem,&m,size)==-2);m.fail=0;
    assert(ug_mod_parse(&info,read_mem,&m,1084+65*2048-1)==-1);
    b[950]=1;assert(!ug_mod_parse(&info,read_mem,&m,size)); /* inactive patterns retain sample offset */
    assert(info.sample_offset==1084+65*2048);
    b[1079]=255;assert(!ug_mod_parse(&info,read_mem,&m,size));b[1079]=0;
    b[950]=65;assert(!ug_mod_parse(&info,read_mem,&m,size));
    puts("S8a channel7 parser: signatures, active/tail orders, 65 patterns, loops, volume, truncation, read error PASS");

    ug_mod_player p;event(&m,0,0,1,428,0,0);ug_mod_start(&p,&info,read_mem,&m,false,0);
    assert(p.tick==0 && p.channel[7].period==428 && p.channel[7].note==48 && p.channel[7].trigger==1);
    ug_mod_advance_frames(&p,959);assert(p.tick==0);ug_mod_advance_frames(&p,1);assert(p.tick==1);
    /* Exact natural duration includes tick zero, also beyond pattern 63. */
    ug_mod_start(&p,&info,read_mem,&m,false,0);
    ug_mod_advance_frames(&p,65*64*6*960-1);assert(p.playing && p.order==64 && p.row==63 && p.tick==5);
    ug_mod_advance_frames(&p,1);assert(!p.playing);
    clear(&m);event(&m,0,0,1,428,15,1);ug_mod_start(&p,&info,read_mem,&m,false,0);
    assert(p.speed==1 && p.row==0);ug_mod_tick(&p);assert(p.row==1);
    clear(&m);event(&m,0,0,1,428,15,0);ug_mod_start(&p,&info,read_mem,&m,false,0);
    assert(p.paused && p.speed==6);ug_mod_advance_frames(&p,48000);assert(p.row==0 && p.tick==0);
    p.paused=0;ug_mod_tick(&p);assert(p.tick==1 && !p.paused);
    ug_mod_start(&p,&info,read_mem,&m,false,1);assert(!p.paused && p.speed==6 && p.bpm==125);
    clear(&m);ug_mod_start(&p,&info,read_mem,&m,false,0);ug_mod_tempo(&p,3,150);
    assert(p.speed==6 && p.bpm==125);ug_mod_advance_frames(&p,960);assert(p.speed==3 && p.bpm==150 && p.tick==1);
    ug_mod_advance_frames(&p,800);assert(p.tick==2);ug_mod_advance_frames(&p,800);assert(p.row==1 && p.tick==0);
    puts("S8a channel7 clock: immediate tick0, exact 65-pattern EOF, F01/F00 modes, staged tempo PASS");

    clear(&m);event(&m,0,0,1,428,14,0xd2);ug_mod_start(&p,&info,read_mem,&m,false,0);
    assert(p.channel[7].sample==255 && p.channel[7].trigger==0);
    ug_mod_tick(&p);assert(p.channel[7].trigger==0);ug_mod_tick(&p);
    assert(p.channel[7].trigger==1 && p.channel[7].period==428 && p.channel[7].sample==0);
    clear(&m);event(&m,0,0,1,428,14,0xd9);ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,9);
    assert(p.channel[7].trigger==0 && p.channel[7].sample==255);
    clear(&m);event(&m,0,0,1,428,14,0xc0);ug_mod_start(&p,&info,read_mem,&m,false,0);assert(!p.channel[7].volume);
    clear(&m);event(&m,0,0,1,428,9,1);event(&m,1,0,0,428,9,0);ug_mod_start(&p,&info,read_mem,&m,false,0);
    assert(p.channel[7].sample_offset==256);ticks(&p,6);assert(p.channel[7].sample_offset==256);
    clear(&m);event(&m,0,0,1,428,14,0xe2);ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,17);
    assert(p.row==0 && p.channel[7].trigger==1);ug_mod_tick(&p);assert(p.row==1);
    clear(&m);event(&m,0,0,1,428,14,0x60);event(&m,1,0,0,0,14,0x63);
    ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,48);
    assert(p.row==2 && p.channel[7].trigger==4 && p.channel[7].loop_count==0);
    puts("S8a channel7 row effects: deferred instrument/note, EC0, 900 memory, finite EE2/E63 PASS");

    clear(&m);event(&m,0,0,1,428,14,0x17);ug_mod_start(&p,&info,read_mem,&m,false,0);assert(p.channel[7].period==421);
    clear(&m);event(&m,0,0,1,428,14,0x57);ug_mod_start(&p,&info,read_mem,&m,false,0);assert(p.channel[7].period==407);
    clear(&m);event(&m,0,0,1,428,8,123);ug_mod_start(&p,&info,read_mem,&m,false,0);assert(p.channel[7].pan==123);
    clear(&m);event(&m,0,0,1,428,0,0x37);ug_mod_start(&p,&info,read_mem,&m,false,0);ug_mod_tick(&p);assert(p.channel[7].period==360);
    ticks(&p,5);assert(p.channel[7].period==428);
    clear(&m);event(&m,0,0,1,5,0,0);event(&m,1,0,0,1,3,255);ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,7);
    assert(p.channel[7].period==1 && p.channel[7].trigger==1);
    event(&m,2,0,0,0,5,0xf1);ticks(&p,5);assert(p.channel[7].porta_speed==255);
    clear(&m);event(&m,0,0,1,244,14,0x31);event(&m,1,0,0,214,3,30);
    ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,7);
    assert(p.channel[7].period==214); /* E3 covers C-3 and higher, not just periods >=226. */
    clear(&m);event(&m,0,0,1,428,4,0x23);event(&m,1,0,0,0,6,0x91);
    ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,6);assert(p.channel[7].vibrato_speed==2 && p.channel[7].vibrato_depth==3);
    clear(&m);event(&m,0,0,1,428,7,0x3f);ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,5);assert(p.channel[7].volume==64);
    p.channel[7].vibrato_pos=23;event(&m,1,0,1,428,14,0x44);ug_mod_tick(&p);assert(p.channel[7].vibrato_pos==23);
    event(&m,2,0,1,428,14,0x40);ticks(&p,6);assert(p.channel[7].vibrato_pos==0);
    p.channel[7].pan=99;p.pattern_delay=3;p.channel[7].loop_count=5;
    assert(!ug_mod_seek(&p,0,0) && p.channel[7].pan==0 && !p.pattern_delay && !p.channel[7].loop_count);
    m.fail=1;assert(!ug_mod_seek(&p,1,0) && !p.playing && p.error==1);m.fail=0;
    puts("S8a channel7 channel effects: finetune, pan, arpeggio reset, porta clamp/memory, tremolo base, no-retrigger, seek PASS");
    /* Explicit arithmetic vectors applied separately to every natural channel.
     * Expected values follow the published effect rules, not a tracker dump. */
    const struct {unsigned fx,param,tick,period,volume,pan,triggers;} vectors[]={
        {0,0x37,1,360,32,999,1},{1,3,1,425,32,999,1},{2,3,1,431,32,999,1},
        {4,0x23,3,430,32,999,1},{7,0x23,3,428,36,999,1},{8,127,0,428,32,127,1},
        {9,1,0,428,32,999,1},{10,0x21,1,428,34,999,1},{10,1,1,428,31,999,1},
        {12,255,0,428,64,999,1},{14,0x13,0,425,32,999,1},{14,0x23,0,431,32,999,1},
        {14,0x8a,0,428,32,170,1},{14,0x92,4,428,32,999,3},
        {14,0xa5,0,428,37,999,1},{14,0xb5,0,428,27,999,1},{14,0xc2,2,428,0,999,1},
        {14,0xe2,17,428,32,999,1},{14,0,1,428,32,999,1},{14,0xf3,1,428,32,999,1}
    };
    assert(!ug_mod_parse(&info,read_mem,&m,size));info.samples[0].volume=32;
    for(unsigned c=0;c<8;c++)for(unsigned k=0;k<sizeof(vectors)/sizeof(vectors[0]);k++) {
        clear(&m);uint8_t *e=b+1084+c*4;e[0]=1;e[1]=0xac;e[2]=16|vectors[k].fx;e[3]=vectors[k].param;
        ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,vectors[k].tick);
        const ug_mod_channel *v=&p.channel[c];
        assert(v->period==vectors[k].period && v->mix_volume==vectors[k].volume && v->trigger==vectors[k].triggers);
        assert(v->pan==(vectors[k].pan==999?((c%4==1 || c%4==2)?255:0):vectors[k].pan));
        assert(e[3]==vectors[k].param); /* E0/EF cannot modify source samples. */
    }
    clear(&m);event(&m,0,0,1,428,0,0);event(&m,1,0,0,214,3,4);event(&m,2,0,0,0,5,1);
    ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,13);assert(p.channel[7].period==404 && p.channel[7].volume==31 && p.channel[7].trigger==1);
    clear(&m);event(&m,0,0,1,428,4,0x23);event(&m,1,0,0,0,6,1);
    ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,7);assert(p.channel[7].period==432 && p.channel[7].volume==31);
    clear(&m);event(&m,0,0,1,428,14,0x42);event(&m,1,0,1,428,4,0x13);
    ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,7);assert(p.channel[7].period==433);
    clear(&m);event(&m,0,0,1,428,14,0x71);event(&m,1,0,1,428,7,0x12);
    ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,7);assert(p.channel[7].mix_volume==39 && p.channel[7].volume==32);
    clear(&m);event(&m,0,0,1,428,14,0x60);event(&m,1,0,0,0,14,0xe1);event(&m,2,0,0,0,14,0x62);
    ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,72);assert(p.row==3 && p.channel[7].trigger==3);
    clear(&m);event(&m,0,0,1,428,15,150);ug_mod_start(&p,&info,read_mem,&m,false,0);assert(p.bpm==150 && ug_mod_frames_to_tick(&p)==800);
    info.samples[0].volume=64;
    puts("S8a 160 independent per-channel effect vectors; 3/5/6 memory, E4/E7 waveform, E6+EE and Fxx BPM PASS");

    /* Independent layout and per-channel expectations, not a golden generated
     * by the tracker. One distinct period/volume/instrument in every channel. */
    clear(&m);b[950]=1;memset(b+952,0,128);b[1079]=64;
    for(unsigned c=0;c<8;c++) {
        uint8_t *e=b+1084+c*4;unsigned period=856-30*c;
        e[0]=(uint8_t)(period>>8);e[1]=(uint8_t)period;e[2]=(uint8_t)(((c+1)<<4)|12);e[3]=(uint8_t)(20+c);
    }
    assert(!ug_mod_parse(&info,read_mem,&m,size));assert(info.channels==8 && info.sample_offset==1084+65*2048);
    ug_mod_start(&p,&info,read_mem,&m,false,0);
    for(unsigned c=0;c<8;c++) {
        assert(p.channel[c].period==856-30*c && p.channel[c].volume==20+c && p.channel[c].sample==c);
        assert(p.channel[c].pan==((c%4==1 || c%4==2)?255:0));
    }
    /* Last assignment wins, even beyond legacy's first four channels. */
    clear(&m);event(&m,0,1,0,0,15,2);event(&m,0,0,0,0,15,4);
    ug_mod_start(&p,&info,read_mem,&m,false,0);assert(p.speed==4);
    clear(&m);b[950]=3;event(&m,0,1,0,0,11,1);event(&m,0,0,0,0,11,2);event(&m,0,6,0,0,13,0x12);
    assert(!ug_mod_parse(&info,read_mem,&m,size));ug_mod_start(&p,&info,read_mem,&m,false,0);ticks(&p,6);
    assert(p.order==2 && p.row==12);
    ug_mod_parser scan;ug_mod_parser_init(&scan,&info,size);int rc,steps=0;
    do {rc=ug_mod_parser_step(&scan,&info,read_mem,&m);steps++;}while(rc==0);
    assert(rc==1 && steps==5+65*8);
    b[1084+7*4]=0x20;ug_mod_parser_init(&scan,&info,size);
    do {rc=ug_mod_parser_step(&scan,&info,read_mem,&m);}while(rc==0);assert(rc==-1);
    b[1084+7*4]=0;ug_mod_parser_init(&scan,&info,size);m.fail=1;
    assert(ug_mod_parser_step(&scan,&info,read_mem,&m)==-2);m.fail=0;
    puts("S8a independent eight-channel layout/pan/instruments/global F/B/D and cooperative validation PASS");
    free(b);return 0;
}
