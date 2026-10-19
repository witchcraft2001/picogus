/* SPDX-License-Identifier: GPL-2.0-or-later
 * Optional private-file regression: production storage/MOD/PCM/mixer under
 * peripheral mocks. Output equality is useful; host speed is not RP2040 timing.
 */
#include "sdk_mock.h"
#include "ultrags/ug_storage.h"
#include "ultrags/ug_minimal.h"
#include "ultrags/ug_config.h"
#include "ultrags/ug_hwmap.h"
#include "ultrags/ug_psram.h"
#include "ultrags/ug_s4.h"
#include "ug_wire.h"
#include "system/flash_settings.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static ug_psram_t ps;
static Settings settings;
static uint8_t response[128];
static uint64_t frames;
static uint32_t checksum=2166136261u;
static void render(unsigned n) {
    int16_t audio[256];assert(n<=128);assert(ug_storage_render(audio,n));
    for(unsigned i=0;i<2*n;i++) {
        uint16_t v=(uint16_t)audio[i];checksum=(checksum^(v&255))*16777619u;checksum=(checksum^(v>>8))*16777619u;
    }
    frames+=n;
}
static void advance(unsigned n) {while(n){unsigned k=n>128?128:n;render(k);n-=k;}}
static uint8_t call(uint8_t op,const uint8_t *q,unsigned n) {
    uint8_t len,status;unsigned budget=100000;
    while(!ug_storage_command(op,q,(uint8_t)n,response,&len,&status,time_us_32())) {assert(budget--);if(frames)render(128);}
    return status;
}
static unsigned get16(const uint8_t *p){return p[0]|((unsigned)p[1]<<8);}
static void put16(uint8_t *p,unsigned v){p[0]=(uint8_t)v;p[1]=(uint8_t)(v>>8);}
static unsigned upload(unsigned kind,const uint8_t *data,unsigned n,bool background) {
    uint8_t q[13]={0};q[0]=(uint8_t)kind;ug_put32(q+1,n);assert(!call(UG_OP_ALLOC,q,5));unsigned h=get16(response);
    for(unsigned off=0;off<n;) {
        unsigned k=n-off>1024?1024:n-off;put16(q,h);ug_put32(q+2,off);put16(q+6,k);q[8]=1;
        assert(!call(UG_OP_WRITE_BEGIN,q,9));uint32_t token=ug_get32(response);ug_storage_grant_ack(time_us_32());
        for(unsigned i=0;i<k;i++)assert(!ug_storage_data_write(data[off+i],time_us_32()));
        ug_put32(q,token);assert(!call(UG_OP_WRITE_END,q,4));off+=k;if(background)render(128);
    }
    memset(q,0,sizeof(q));put16(q,h);assert(!call(UG_OP_SEAL,q,7));return h;
}
static uint8_t *file(const char *path,unsigned *size) {
    FILE *f=fopen(path,"rb");assert(f);assert(!fseek(f,0,SEEK_END));long n=ftell(f);assert(n>0&&n<(8<<20));rewind(f);
    uint8_t *data=malloc((size_t)n);assert(data&&fread(data,1,(size_t)n,f)==(size_t)n);fclose(f);*size=(unsigned)n;return data;
}
static void stage(const char *name) {
    assert(!call(UG_OP_SNAPSHOT,NULL,0));
    uint8_t stats[64];ug_stats_copy(stats);
    printf("{\"stage\":\"%s\",\"frames\":%llu,\"checksum\":%u,\"state\":%u,\"clips\":%u,\"psramErrors\":%u}\n",name,(unsigned long long)frames,checksum,response[24],ug_get32(stats+60),ug_get32(stats+40));
    assert(!ug_get32(stats+40));
}
int main(int argc,char **argv) {
    assert(argc==3);unsigned mn,wn;uint8_t *mod=file(argv[1],&mn),*wav=file(argv[2],&wn);
    mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=0xffff;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();ug_storage_bind(&ps,17);ug_storage_publish(8u<<20,0,0);
    unsigned mh=upload(3,mod,mn,false);uint8_t q[13]={0};put16(q,mh);q[2]=1;assert(!call(UG_OP_PLAY_MOD,q,3));advance(5*48000);stage("MOD");
    unsigned wh=upload(2,wav,wn,true);stage("WAV_UPLOAD_DURING_MOD");
    memset(q,0,sizeof(q));put16(q,wh);q[4]=128;q[5]=16;q[6]=128;q[7]=2;
    assert(!call(UG_OP_PLAY_FX,q,8));assert(get16(response+2)==0x300);advance(5*48000);stage("ONE_STEREO_FX");
    assert(!call(UG_OP_PLAY_FX,q,8));assert(get16(response+2)==0xc00);advance(5*48000);stage("TWO_STEREO_FX");
    assert(call(UG_OP_PLAY_FX,q,8)==UG_ERR_NO_VOICE);advance(128);stage("THIRD_STEREO_REJECTED");
    uint8_t *blob=malloc(65536);assert(blob);for(unsigned i=0;i<65536;i++)blob[i]=(uint8_t)(i*73+(i>>8));
    unsigned bh=upload(0,blob,65536,true);
    for(unsigned off=0;off<65536;off+=1024) {
        memset(q,0,sizeof(q));put16(q,bh);ug_put32(q+2,off);put16(q+6,1024);q[8]=1;
        assert(!call(UG_OP_READ_BEGIN,q,9));uint32_t token=ug_get32(response);ug_storage_grant_ack(time_us_32());
        for(unsigned i=0;i<1024;i++){uint8_t b;assert(!ug_storage_data_read(&b,time_us_32()));assert(b==blob[off+i]);}
        ug_put32(q,token);assert(!call(UG_OP_READ_END,q,4));render(128);
    }
    put16(q,bh);assert(!call(UG_OP_FREE,q,2));stage("BACKGROUND_ROUNDTRIP");
    memset(q,0,sizeof(q));q[2]=1;assert(!call(UG_OP_CONTROL,q,3));advance(5*48000);stage("PAUSED_MOD_TWO_STEREO");
    memset(q,0,sizeof(q));assert(!call(UG_OP_STOP_FX,q,2));q[2]=0;assert(!call(UG_OP_CONTROL,q,3));
    int16_t silence[256];ug_storage_render(silence,128);
    put16(q,wh);assert(!call(UG_OP_FREE,q,2));put16(q,mh);assert(!call(UG_OP_FREE,q,2));
    assert(!call(UG_OP_MEM_INFO,NULL,0));assert(ug_get32(response+8)==8u<<20 && !get16(response+16));
    puts("{\"stage\":\"CLEANUP\",\"free\":8388608,\"objects\":0}");free(blob);free(mod);free(wav);
}
