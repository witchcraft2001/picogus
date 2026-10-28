/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_mod.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static uint8_t data[600+1024+64];
static unsigned calls, fail_at;
static int fail;
static int rd(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    (void)ctx;calls++;assert(n<=256);if(fail || calls==fail_at || off>sizeof(data) || n>sizeof(data)-off)return -1;
    memcpy(dst,data+off,n);return 0;
}
static int scan(ug_mod_info *i,uint32_t size) {
    ug_mod_parser p;ug_mod_parser_init(&p,i,size);int rc;
    do {unsigned before=calls;rc=ug_mod_parser_step(&p,i,rd,0);assert(calls-before<=1);}while(!rc);return rc;
}
static void setup(void) {
    memset(data,0,sizeof(data));data[470]=1;data[471]=120;
    data[42]=0;data[43]=4;data[45]=64;data[47]=2;data[49]=3;
    data[600]=1;data[601]=172;data[602]=0x11;data[603]=0x37;
}
int main(void) {
    ug_mod_info i;setup();assert(scan(&i,600+1024+8)==1);
    assert(i.profile==UG_MOD_UST && i.initial_bpm==120 && i.restart==0);
    assert(i.samples[0].sample_bytes==8 && i.samples[0].sample_skip==2 && i.samples[0].length==6 && i.samples[0].loop_length==6);
    ug_mod_player p;ug_mod_start(&p,&i,rd,0,0,0);assert(p.bpm==120 && p.channel[0].effect==0);
    ug_mod_tick(&p);assert(p.channel[0].period<428);
    assert(!ug_mod_seek(&p,0,0) && p.bpm==120);
    data[602]=0x1f;data[603]=0;assert(scan(&i,600+1024+8)==1 && i.profile==UG_MOD_ST_IX);
    ug_mod_start(&p,&i,rd,0,0,0);assert(!p.paused && p.speed==6 && p.bpm==125);
    assert(scan(&i,600+1024+7)==-1);
    data[45]=65;assert(scan(&i,sizeof(data))==-1);data[45]=64;
    data[47]=9;assert(scan(&i,sizeof(data))==-1);data[47]=2;
    data[600]=0x11;assert(scan(&i,sizeof(data))==-1);data[600]=1;
    fail=1;assert(scan(&i,sizeof(data))==-2);fail=0;
    setup();calls=0;assert(scan(&i,sizeof(data))==1);unsigned read_count=calls;
    for(unsigned at=1;at<=read_count;at++) {
        calls=0;fail_at=at;assert(scan(&i,sizeof(data))==-2);
    }
    fail_at=0;
    setup();data[472]=128;assert(scan(&i,sizeof(data))==-1);
    setup();data[601]=1;assert(scan(&i,sizeof(data))==-1); /* invalid period */
    setup();data[20+14*30+25]=65;assert(scan(&i,sizeof(data))==-1);
    setup();data[49]=4;assert(scan(&i,sizeof(data))==-1); /* loop exceeds playable part */
    setup();memcpy(data+1080,"M.K.",4); /* recognized modern tag has priority */
    assert(scan(&i,sizeof(data))==-1); /* invalid modern song length, no MOD15 retry */
    puts("MOD15 parser, sample bounds, classification, tempo, arpeggio, seek and failures PASS");
    return 0;
}
