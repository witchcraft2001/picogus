/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_storage.h"
#include "ug_s4.h"
#include "ug_psram.h"
#include "ug_hwmap.h"
#include "ug_minimal.h"
#include "ug_config.h"
#include "ug_wire.h"
#include "system/flash_settings.h"
#include "sdk_mock.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static ug_psram_t ps;
static Settings settings;
static uint8_t r[128];
static int16_t audio[256];
static FILE *vectors;
static void put16(uint8_t *p,unsigned v){p[0]=(uint8_t)v;p[1]=(uint8_t)(v>>8);}
static unsigned get16(const uint8_t *p){return p[0]|((unsigned)p[1]<<8);}
static void hex(FILE *f,const uint8_t *p,unsigned n){while(n--)fprintf(f,"%02x",*p++);}
static uint8_t call(uint8_t op,const uint8_t *q,uint8_t n){
    uint8_t status,len;unsigned limit=10000;
    while(!ug_storage_command(op,q,n,r,&len,&status,time_us_32()))assert(limit--);
    if(vectors){fprintf(vectors,"{\"op\":%u,\"q\":\"",op);hex(vectors,q,n);fprintf(vectors,"\",\"status\":%u,\"r\":\"",status);hex(vectors,r,len);
        if(op==UG_OP_SNAPSHOT){
            uint8_t mask[128];memset(mask,255,128);memset(mask,0,4);memset(mask+42,0,4);
            for(unsigned i=0;i<8;i++)memset(mask+62+8*i,0,2);
            fprintf(vectors,"\",\"mask\":\"");hex(vectors,mask,128);
        }
        fputs("\"}\n",vectors);
    }
    return status;
}
static void render(unsigned n){assert(n<=128);ug_storage_render(audio,n);if(vectors)fprintf(vectors,"{\"render\":%u}\n",n);}
static void frames(unsigned n){while(n){unsigned k=n>128?128:n;render(k);n-=k;}}
static unsigned upload(unsigned kind,const uint8_t *data,unsigned n){
    uint8_t q[13]={0};q[0]=(uint8_t)kind;ug_put32(q+1,n);assert(!call(UG_OP_ALLOC,q,5));unsigned h=get16(r);
    for(unsigned off=0;off<n;){unsigned count=n-off>1024?1024:n-off;put16(q,h);ug_put32(q+2,off);put16(q+6,count);q[8]=1;
        assert(!call(UG_OP_WRITE_BEGIN,q,9));uint32_t token=ug_get32(r);ug_storage_grant_ack(time_us_32());
        if(vectors){fputs("{\"data\":\"",vectors);hex(vectors,data+off,count);fputs("\"}\n",vectors);}
        for(unsigned i=0;i<count;i++)assert(!ug_storage_data_write(data[off+i],time_us_32()));
        ug_put32(q,token);assert(!call(UG_OP_WRITE_END,q,4));off+=count;
    }
    return h;
}
static void seal(unsigned h){uint8_t q[7]={0};put16(q,h);assert(!call(UG_OP_SEAL,q,7));}
static unsigned pins(unsigned h){uint8_t q[2];put16(q,h);assert(!call(UG_OP_OBJECT_INFO,q,2));return get16(r+4);}
static void snapshot(void){assert(!call(UG_OP_SNAPSHOT,NULL,0));}
static void control(unsigned id,unsigned action){uint8_t q[3];put16(q,id);q[2]=(uint8_t)action;assert(!call(UG_OP_CONTROL,q,3));}
static void stop(void){control(0,0);render(0);}
static unsigned play(unsigned h,unsigned flags){uint8_t q[3];put16(q,h);q[2]=(uint8_t)flags;assert(!call(UG_OP_PLAY_MOD,q,3));return get16(r);}
static void be16(uint8_t *p,unsigned v){p[0]=(uint8_t)(v>>8);p[1]=(uint8_t)v;}
static void event(uint8_t *b,unsigned row,unsigned ch,unsigned period,unsigned fx,unsigned param){uint8_t *e=b+1084+row*16+ch*4;e[0]=(uint8_t)(period>>8);e[1]=(uint8_t)period;e[2]=(uint8_t)(0x10|fx);e[3]=(uint8_t)param;}
static unsigned mod(unsigned channel,unsigned fx,unsigned param){
    uint8_t b[1084+1024+1024]={0};b[950]=1;memcpy(b+1080,"M.K.",4);be16(b+42,512);b[45]=64;
    be16(b+46,256);be16(b+48,64);event(b,0,channel,428,fx,param);
    memset(b+1084+1024,64,1024);b[1084+1024+256]=(uint8_t)-64;b[1084+1024+512]=32;
    unsigned h=upload(3,b,sizeof(b));seal(h);return h;
}
static unsigned pcm(void){
    const uint8_t data[4]={192,192,192,192};unsigned h=upload(1,data,4);
    uint8_t q[26]={0};put16(q,h);ug_put32(q+2,48000);q[6]=1;q[7]=8;ug_put32(q+14,4);
    assert(!call(UG_OP_PCM_CONFIG,q,26));seal(h);return h;
}
static void bind(void){ug_storage_bind(&ps,17);ug_storage_publish(8u<<20,0,0);ug_storage_main_volume(100);}
static void shared(const char *path){
    bind();vectors=fopen(path,"w");assert(vectors);unsigned h=mod(0,0,0),id=play(h,1);render(1);snapshot();
    uint8_t tempo[2]={3,150};assert(!call(UG_OP_SET_TEMPO,tempo,2));render(0);snapshot();frames(959);snapshot();
    uint8_t pan[2]={0,88};assert(!call(UG_OP_SET_PAN,pan,2));render(0);snapshot();
    uint8_t seek[5]={0};put16(seek,id);seek[4]=63;assert(!call(UG_OP_SEEK_MOD,seek,5));render(0);snapshot();
    control(id,1);render(0);snapshot();control(id,2);render(1);snapshot();stop();
    unsigned fh=mod(0,15,0);id=play(fh,0);render(1);snapshot();control(id,2);render(1);snapshot();stop();
    assert(call(UG_OP_LEGACY_INFO,NULL,0)==UG_ERR_BAD_OPCODE);
    fclose(vectors);vectors=NULL;
}
int main(void){
    mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=0xffff;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();bind();
    assert(call(UG_OP_LEGACY_INFO,NULL,0)==UG_ERR_BAD_OPCODE);
    unsigned h=mod(0,0,0),id=play(h,1);assert(pins(h)==1);render(1);assert(audio[0]==16384 && audio[1]==0);
    snapshot();assert(r[25]==2 && r[39]==0 && r[56]==48 && get16(r+60)==428 && r[57]==64 && r[58]==0 && get16(r+52)==1);
    uint8_t seek[5]={0};put16(seek,id);seek[4]=63;
    uint8_t pan[2]={0,44};assert(!call(UG_OP_SET_PAN,pan,2));render(0);
    assert(!call(UG_OP_SEEK_MOD,seek,5));render(1);assert(!audio[0] && !audio[1]);snapshot();assert(r[38]==63 && !get16(r+52) && r[58]==0 && !get16(r+60));
    control(id,1);render(0);control(id,2);render(1);assert(!audio[0] && !audio[1]);stop();assert(!pins(h));
    h=mod(0,9,1);play(h,0);render(1);assert(audio[0]==-16384);stop();
    h=mod(0,9,15);play(h,0);render(128);snapshot();assert(!get16(r+52));stop();
    puts("S7 storage: immediate intro/9xx, correct snapshot, seek/pan reset, silent resume, retained handles PASS");
    unsigned fxh=pcm();uint8_t fx[8]={0};put16(fx,fxh);fx[4]=128;fx[5]=64;fx[6]=255;fx[7]=2;
    assert(!call(UG_OP_PLAY_FX,fx,8));render(0);
    h=mod(0,15,0);id=play(h,0);render(128);snapshot();assert(r[24]==2 && !r[39] && get16(r+52)==0x100 && pins(h)==1);
    control(id,2);render(128);snapshot();assert(r[24]==1 && pins(h)==1 && pins(fxh)==1);stop();
    uint8_t fxstop[2]={0};assert(!call(UG_OP_STOP_FX,fxstop,2));render(0);
    h=mod(0,0,0);id=play(h,0);put16(seek,id);assert(!call(UG_OP_SEEK_MOD,seek,5));render(0); /* seek admitted before first PLAY render */
    assert(!call(UG_OP_PLAY_FX,fx,8));render(0);frames(5760-1);snapshot();assert(r[24]==1 && r[38]==63 && r[39]==5);
    render(2);snapshot();assert(r[24]==3 && r[25]==2 && get16(r+52)==0x100 && !pins(h) && pins(fxh)==1);
    assert(call(UG_OP_CONTROL,(uint8_t[]){(uint8_t)id,(uint8_t)(id>>8),2},3)==UG_ERR_STATE);
    assert(!call(UG_OP_STOP_FX,fxstop,2));render(0);
    puts("S7 storage: F00 PAUSE/resume/pins with independent FX, exact finite EOF and FX continuation PASS");
    h=mod(2,0,0);play(h,0);render(0);ug_psram_dma_fault=true;render(1);snapshot();
    assert(r[24]==4 && r[50]==UG_ERR_PSRAM && !pins(h));assert(!ug_psram_recover(&ps));
    unsigned raw=pcm();uint8_t q[6]={0};put16(q,raw);put16(q+2,0);q[4]=64;q[5]=128;
    assert(!call(UG_OP_PLAY_PCM,q,6));render(1);snapshot();assert(r[25]==1 && r[56]==127 && !get16(r+60));stop();
    h=mod(0,0,0);id=play(h,1);uint8_t playq[3]={0};put16(playq,h);assert(call(UG_OP_PLAY_MOD,playq,3)==UG_ERR_BUSY);
    put16(q,raw);assert(!call(UG_OP_PLAY_PCM,q,6));assert(get16(r)!=id);render(0);assert(!pins(h) && pins(raw)==1);stop();
    puts("S7 storage: non-first-channel PSRAM failure, PCM kind regression, queued ownership/ID isolation PASS");
    const char *path=getenv("UG_S7_VECTORS");if(path)shared(path);
    return 0;
}
