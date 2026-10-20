/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_storage.h"
#include "ug_render.h"
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
    ug_storage_tick(time_us_32());
    while(!ug_storage_command(op,q,n,r,&len,&status,time_us_32()))assert(limit--);
    if(vectors){fprintf(vectors,"{\"op\":%u,\"q\":\"",op);hex(vectors,q,n);fprintf(vectors,"\",\"status\":%u,\"r\":\"",status);hex(vectors,r,len);
        if(op==UG_OP_SNAPSHOT){
            uint8_t mask[64];memset(mask,255,64);memset(mask,0,4);memset(mask+42,0,4);
            fprintf(vectors,"\",\"mask\":\"");hex(vectors,mask,64);
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

static uint8_t key[16];
static void capture(void) { snapshot();memcpy(key,r+4,8);memcpy(key+8,r,4); }
static unsigned effect(unsigned h,unsigned preferred,unsigned flags,uint8_t expected) {
    uint8_t q[8];put16(q,h);put16(q+2,preferred);q[4]=128;q[5]=64;q[6]=128;q[7]=(uint8_t)flags;
    assert(call(UG_OP_PLAY_FX,q,8)==expected);return get16(r);
}
static void pages(unsigned op,unsigned expected) {
    unsigned first=0,size=op==UG_OP_VOICE_STATUS?20:16;
    do {
        put16(key+12,first);put16(key+14,65535);assert(!call((uint8_t)op,key,16));
        unsigned count=get16(r+14);assert(get16(r+16)==expected && get16(r+18)==size);
        assert(count<=108/size);assert(get16(r+12)==first);
        if(op==UG_OP_VOICE_STATUS) for(unsigned i=0;i<count;i++)assert(get16(r+20+i*size)==first+i);
        first+=count;
    } while(first<expected);
    put16(key+12,expected);assert(!call((uint8_t)op,key,16));assert(!get16(r+14));
    put16(key+12,expected+1);assert(call((uint8_t)op,key,16)==UG_ERR_RANGE);
}
int main(void) {
    mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=65535;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();bind();
    assert(!call(UG_OP_CAPS,NULL,0));assert(get16(r+20)==UG_LANES && get16(r+22)==UG_LANES && get16(r+24)==UG_LANES && r[27]==1);
    unsigned h=pcm(),ids[UG_LANES];
    for(unsigned i=0;i<UG_LANES;i++) { ids[i]=effect(h,65535,2,0);assert(get16(r+2)==1);if(i%8==7)render(0); }
    effect(h,65535,2,UG_ERR_NO_VOICE);assert(pins(h)==UG_LANES);
    render(1);assert(ug_minimal_read_status()&128);capture();assert(get16(r+52)==UG_LANES && get16(r+54)==UG_LANES);
    pages(UG_OP_VOICE_STATUS,UG_LANES);pages(UG_OP_FX_STATUS,UG_LANES);
    /* Held snapshot is stable across renders and new public state. */
    frames(128);put16(key+12,0);assert(!call(UG_OP_VOICE_STATUS,key,16));
    ug_storage_latch();assert(call(UG_OP_VOICE_STATUS,key,16)==UG_ERR_STATE);
    uint8_t q[3];put16(q,ids[0]);q[2]=1;assert(!call(UG_OP_CONTROL_FX,q,3));
    effect(h,65535,2,UG_ERR_NO_VOICE);render(0);q[2]=2;assert(!call(UG_OP_CONTROL_FX,q,3));render(0);
    put16(q,ids[UG_LANES-1]);assert(!call(UG_OP_STOP_FX,q,2));effect(h,UG_LANES-1,2,0);render(0);
    put16(q,0);assert(!call(UG_OP_STOP_FX,q,2));render(0);assert(!pins(h));assert(!(ug_minimal_read_status()&128));
    /* MOD takes any four IDs and leaves all remaining voices for FX. */
    unsigned mh=mod(0,0,0);play(mh,1);render(1);
    for(unsigned i=0;i<UG_LANES-4;i++){effect(h,65535,2,0);if(i%8==7)render(0);}render(0);
    effect(h,65535,2,UG_ERR_NO_VOICE);capture();assert(get16(r+52)==UG_LANES);
    assert(!call(UG_OP_STOP_FX,q,2));render(0);stop();assert(!pins(mh) && !pins(h));
    /* Two voices are reserved atomically for stereo, including pending plays. */
    const uint8_t stereo[4]={128,128,128,128};unsigned sh=upload(1,stereo,4);
    uint8_t d[26]={0};put16(d,sh);ug_put32(d+2,48000);d[6]=2;d[7]=8;ug_put32(d+14,4);assert(!call(UG_OP_PCM_CONFIG,d,26));seal(sh);
    for(unsigned i=0;i<UG_LANES/2;i++){effect(sh,65535,2,0);assert(get16(r+2)==2);if(i%8==7)render(0);}render(0);
    effect(sh,65535,2,UG_ERR_NO_VOICE);assert(pins(sh)==UG_LANES/2);
    assert(!call(UG_OP_STOP_FX,q,2));render(0);assert(!pins(sh));
    for(unsigned i=0;i<UG_LANES-1;i++){effect(h,65535,2,0);if(i%8==7)render(0);}render(0);
    effect(sh,65535,2,UG_ERR_NO_VOICE);assert(!pins(sh));
    effect(sh,65535,3,UG_ERR_NO_VOICE); /* equal priority cannot be stolen */
    assert(!call(UG_OP_STOP_FX,q,2));render(0);assert(!pins(h));
    puts("Shared voice pool, atomic mono/stereo, MOD+FX, pending/pause reservations, coherent pages and IDs beyond31 PASS");
    return 0;
}
