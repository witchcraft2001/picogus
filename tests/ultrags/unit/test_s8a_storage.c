/* SPDX-License-Identifier: GPL-2.0-or-later */
#define main s7_reference_main
#include "test_s7_storage.c"
#undef main
#include "ug_legacy.h"
static uint8_t eight[1084+2048+8*128];
static void make_eight(void) {
    memset(eight,0,sizeof(eight));eight[950]=1;memcpy(eight+1080,"8CHN",4);
    for(unsigned c=0;c<8;c++) {
        be16(eight+20+30*c+22,64);eight[20+30*c+25]=64;be16(eight+20+30*c+28,64);
        memset(eight+1084+2048+c*128,c+1,128);
        unsigned period=856-30*c;uint8_t *e=eight+1084+c*4;
        e[0]=period>>8;e[1]=period;e[2]=(c+1)<<4;
        e=eight+1084+32+c*4;e[2]=1;e[3]=c+1; /* independent portamento */
    }
}
static uint16_t asset(unsigned channels) {
    uint8_t data[8]={100,0,200,0,100,0,200,0},q[26]={0};
    unsigned h=upload(1,data,channels*4);put16(q,h);ug_put32(q+2,48000);q[6]=channels;q[7]=16;q[8]=2;ug_put32(q+14,channels*4);
    assert(!call(UG_OP_PCM_CONFIG,q,26));seal(h);return h;
}
static unsigned fx_start(unsigned h,unsigned preferred,unsigned priority,unsigned flags) {
    uint8_t q[8]={0};put16(q,h);put16(q+2,preferred);q[4]=priority;q[5]=64;q[6]=128;q[7]=flags;
    assert(!call(UG_OP_PLAY_FX,q,8));return get16(r);
}
static void free_obj(unsigned h){uint8_t q[2];put16(q,h);assert(!call(UG_OP_FREE,q,2));}
static void readback(unsigned h,const uint8_t *data,unsigned n,bool verified) {
    uint8_t q[12]={0},b[1024];
    for(unsigned off=0;off<n;) {
        unsigned k=n-off;if(k>1024)k=1024;put16(q,h);ug_put32(q+2,off);put16(q+6,k);q[8]=verified?128:0;
        unsigned limit=10000;uint8_t status,len;
        while(!ug_storage_command(UG_OP_READ_BEGIN,q,9,r,&len,&status,time_us_32())) {render(128);assert(limit--);}
        assert(!status);uint32_t token=ug_get32(r);if(verified)assert(ug_get32(r+4)==ug_crc32(data+off,k));
        ug_storage_grant_ack(time_us_32());for(unsigned j=0;j<k;j++)assert(!ug_storage_data_read(b+j,time_us_32()));
        assert(!memcmp(b,data+off,k));ug_put32(q,token);ug_put32(q+4,ug_crc32(b,k));assert(!call(UG_OP_READ_END,q,verified?8:4));off+=k;
    }
}
static uint8_t traces[2][100][8][10];
static void trace(unsigned pass,unsigned tick) {
    for(unsigned c=0;c<8;c++){voice(c);memcpy(traces[pass][tick][c],v+8,4);memcpy(traces[pass][tick][c]+4,v+14,6);}
}
static void concurrency(unsigned channels,bool verified) {
    bind();make_eight();unsigned h=upload(3,eight,sizeof(eight));seal(h);
    unsigned fh=asset(channels);play(h,1);render(0);
    assert(pins(h)==1);voice(7);assert(r[26]==8 && get16(r+52)==8 && v[18]==0);
    for(unsigned t=0;t<100;t++){frames(960);trace(0,t);}
    stop();play(h,1);render(0);
    for(unsigned i=0;i<4/channels;i++)fx_start(fh,65535,100,2);
    render(0);snapshot();assert(get16(r+52)==12);
    for(unsigned t=0;t<100;t++) {frames(960);trace(1,t);}
    assert(!memcmp(traces[0],traces[1],sizeof(traces[0])));
    readback(h,eight,sizeof(eight),verified);
    for(unsigned i=0;i<20;i++) {
        unsigned other=upload(3,eight,sizeof(eight));uint8_t q[7]={0};put16(q,other);q[2]=verified;if(verified)ug_put32(q+3,ug_crc32(eight,sizeof(eight)));
        unsigned steps=0;uint8_t status,len;
        while(!ug_storage_command(UG_OP_SEAL,q,7,r,&len,&status,time_us_32())) {render(128);steps++;}
        if(status || steps<13)fprintf(stderr,"seal status=%u steps=%u verified=%u\n",status,steps,verified);assert(!status && steps>=13);readback(other,eight,sizeof(eight),verified);free_obj(other);
    }
    uint8_t q[8]={0};put16(q,h);assert(call(UG_OP_FREE,q,2)==UG_ERR_PINNED);
    control(0,1);render(0);snapshot();unsigned order=get16(r+36),row=r[38],tick=r[39];frames(48000);snapshot();assert(get16(r+36)==order && r[38]==row && r[39]==tick && r[24]==2);
    assert(audio[0] && audio[1]);control(0,2);render(1);stop();assert(!pins(h) && pins(fh)==4/channels);
    assert(!call(UG_OP_STOP_FX,q+2,2));render(0);free_obj(h);free_obj(fh);
    assert(!call(UG_OP_MEM_INFO,NULL,0) && !get16(r+16) && ug_get32(r+8)==8u<<20);
    printf("S8a MOD8 + %u %s FX / %s: exact music trace, background CRC/SEAL/readback, pause/EOF/pins/free PASS\n",4/channels,channels==1?"mono":"stereo",verified?"VERIFIED":"FAST");
}
static void transport(void) {
    bind();make_eight();unsigned h=upload(3,eight,sizeof(eight));seal(h);uint8_t q[8]={0};put16(q,h);
    assert(!call(UG_OP_OBJECT_INFO,q,2)&&r[37]==8);assert(!call(UG_OP_CAPS,NULL,0)&&(ug_get32(r+4)&48)==16);
    unsigned four=mod(0,0,0);play(four,1);render(0);play(h,1);
    put16(q,four);q[2]=1;assert(call(UG_OP_PLAY_MOD,q,3)==UG_ERR_BUSY);render(1);
    assert(audio[0]==18*256 && audio[1]==18*256);voice(7);assert(v[16]!=127);
    q[0]=7;q[1]=0;q[2]=211;assert(!call(UG_OP_SET_PAN,q,3));render(0);voice(7);assert(v[18]==211);
    q[0]=8;assert(call(UG_OP_SET_PAN,q,3)==UG_ERR_RANGE);
    play(four,1);q[0]=7;assert(call(UG_OP_SET_PAN,q,3)==UG_ERR_RANGE);render(0);snapshot();assert(r[26]==4 && get16(r+52)==4);
    play(h,0);render(0);frames(64*6*960);snapshot();assert(r[24]==3 && !get16(r+52) && !pins(h));
    eight[1084+7*4]=0x20;unsigned bad=upload(3,eight,sizeof(eight));memset(q,0,sizeof(q));put16(q,bad);assert(call(UG_OP_SEAL,q,7)==UG_ERR_FORMAT);assert(!pins(bad));free_obj(bad);
    free_obj(four);free_obj(h);puts("S8a metadata, queued MOD4/MOD8, all-channel pan/EOF and malformed high-channel instrument PASS");
}

static uint8_t gs(unsigned cmd,unsigned pre) {
    uint8_t out=0,error=0;bool db;unsigned limit=10000;
    while(!ug_legacy_command(cmd,true,pre,&out,&db,&error)){render(128);assert(limit--);}
    assert(!error);return out;
}
static void legacy_mapping(void) {
    bind();make_eight();assert(gs(0x30,0)==1);
    for(unsigned i=0;i<sizeof(eight);i++){uint8_t e=0;ug_legacy_data(eight[i],&e);assert(!e);}
    assert(gs(0xd2,0)==1);assert(gs(0x31,1)==1);render(1);snapshot();assert(r[26]==8);
    uint8_t notes[4];notes[0]=gs(0x63,0);for(unsigned c=1;c<4;c++)assert(ug_legacy_reply(notes+c));ug_legacy_reply_consumed();
    for(unsigned c=0;c<4;c++){voice(c);assert((notes[c]&127)==v[16]);}
    assert(gs(0x38,0)==1);for(unsigned i=0;i<256;i++){uint8_t e=0;ug_legacy_data(178,&e);assert(!e);}
    assert(gs(0xd2,0)==1);gs(0x81,1);render(1);assert(audio[0]==16384 && audio[1]==18*256);
    for(unsigned c=4;c<8;c++){voice(c);assert(get16(v+14)==856-30*c && !(v[19]&2));}
    gs(0x3a,0x40);render(1);assert(audio[0]==18*256 && audio[1]==18*256);
    gs(0x32,0);render(1);for(unsigned i=0;i<2;i++)assert(!audio[i]);gs(0x33,0);render(1);assert(audio[0] && audio[1]);
    stop();gs(0x37,0);assert(!call(UG_OP_MEM_INFO,NULL,0) && !get16(r+16));
    puts("S8a legacy LOAD/D2/PLAY, GS63 natural first4, GS1 overrides MOD3 only, high4 untouched, restore/pause/free PASS");
}
static void allocation(void) {
    bind();make_eight();unsigned h=upload(3,eight,sizeof(eight));seal(h);play(h,1);render(0);
    unsigned mono=asset(1),stereo=asset(2);for(unsigned i=0;i<24;i++){fx_start(mono,65535,100,2);render(0);}
    uint8_t q[8]={0};put16(q,stereo);put16(q+2,65535);q[4]=100;q[5]=64;q[6]=128;q[7]=2;
    assert(call(UG_OP_PLAY_FX,q,8)==UG_ERR_NO_VOICE && pins(stereo)==0 && pins(mono)==24 && pins(h)==1);
    q[4]=254;q[7]=3;put16(q+2,7);assert(call(UG_OP_PLAY_FX,q,8)==UG_ERR_NO_VOICE);
    put16(q+2,65535);assert(!call(UG_OP_PLAY_FX,q,8));render(0);
    assert(pins(stereo)==1 && pins(mono)==22);snapshot();assert(r[26]==8 && get16(r+52)==32);
    memset(q,0,2);assert(!call(UG_OP_STOP_FX,q,2));render(0);stop();free_obj(h);free_obj(mono);free_obj(stereo);
    puts("S8a full shared32 pool, atomic stereo NO_VOICE, music-protected preferred ID/FX-only steal/pins PASS");
}
int main(void) {
    s7_reference_main();transport();legacy_mapping();allocation();
    for(unsigned ch=1;ch<=2;ch++)for(unsigned verified=0;verified<2;verified++)concurrency(ch,verified);
    return 0;
}
