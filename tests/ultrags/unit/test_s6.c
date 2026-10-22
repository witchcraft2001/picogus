/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "sdk_mock.h"
#include "ultrags/ug_storage.h"
#include "ultrags/ug_minimal.h"
#include "ultrags/ug_config.h"
#include "ultrags/ug_hwmap.h"
#include "ultrags/ug_psram.h"
#include "ultrags/ug_s4.h"
#include "ultrags/ug_render.h"
#include "ultrags_protocol.h"
#include "multifw/ug_catalog.h"
#include "picogus.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static FILE *vectors;
static void hex(FILE *f,const uint8_t *p,unsigned n) { for(unsigned i=0;i<n;i++) fprintf(f,"%02x",p[i]); }
static Settings settings;
static ug_psram_t ps;
static uint8_t response[128], wav[64], raw[512];
static bool pump_audio;
static unsigned background_quanta, background_frame;
static void audio_slice(void) {
    if(pump_audio) {
        int16_t samples[256]; assert(ug_storage_render(samples,128));
        /* Foreground U8 saw plus two constant stereo effects at fx master=16.
         * The sum stays below clipping, so every corruption or skipped frame is
         * observable, including during SEAL, transfer commits and readback. */
        for(unsigned i=0;i<128;i++) {
            assert(samples[2*i]==(int16_t)((64+(background_frame+i)%32)*256+8192));
            assert(samples[2*i+1]==-8192);
        }
        background_frame+=128;background_quanta++;
    }
}
void ug_storage_grant_ack(uint32_t now);
uint8_t ug_storage_data_write(uint8_t byte,uint32_t now);
static uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0]|((uint16_t)p[1]<<8)); }
static void put16(uint8_t *p,uint16_t v) { p[0]=v; p[1]=v>>8; }
static uint8_t call(uint8_t op,const uint8_t *req,uint8_t n,uint8_t *len) {
    uint8_t status=0,done=0; unsigned limit=10000;
    do { done=ug_storage_command(op,req,n,response,len,&status,time_us_32()); assert(limit--);if(!done) audio_slice(); }
    while(!done);
    if(vectors) { fprintf(vectors,"{\"op\":%u,\"q\":\"",op);hex(vectors,req,n);fprintf(vectors,"\",\"status\":%u,\"r\":\"",status);hex(vectors,response,*len);fprintf(vectors,"\"}\n"); }
    return status;
}
static uint16_t alloc_obj(uint8_t kind,uint32_t size) {
    uint8_t a[5]={kind,size,size>>8,size>>16,size>>24},len;
    assert(call(UG_OP_ALLOC,a,5,&len)==0 && len==6);
    return get16(response);
}
static void write_obj(uint16_t h,const uint8_t *data,uint16_t n) {
    for(unsigned offset=0;offset<n;) {
        uint16_t count=(uint16_t)(n-offset>1024?1024:n-offset);
        uint8_t a[9]={0},len;put16(a,h);ug_put32(a+2,offset);put16(a+6,count);a[8]=1;
        assert(call(UG_OP_WRITE_BEGIN,a,9,&len)==0&&len==4);
        uint32_t token=ug_get32(response);ug_storage_grant_ack(time_us_32());
        if(vectors){fputs("{\"data\":\"",vectors);hex(vectors,data+offset,count);fputs("\"}\n",vectors);}
        for(unsigned i=0;i<count;i++){assert(ug_storage_data_write(data[offset+i],time_us_32())==0);if(i%32==31)audio_slice();}
        uint8_t e[4];ug_put32(e,token);assert(call(UG_OP_WRITE_END,e,4,&len)==0&&len==0);offset+=count;
    }
}
static void seal_obj(uint16_t h) {
    uint8_t a[7]={0},len; put16(a,h);
    assert(!call(UG_OP_SEAL,a,7,&len) && len==4);
}
static uint16_t pcm_asset(const uint8_t *data,uint16_t size,uint32_t rate,uint8_t channels,uint8_t bits,uint8_t fmt,uint32_t ls,uint32_t le) {
    uint16_t h=alloc_obj(1,size); write_obj(h,data,size);
    uint8_t c[26]={0},len; put16(c,h); ug_put32(c+2,rate); c[6]=channels;c[7]=bits;c[8]=fmt;
    c[9]=le!=0;ug_put32(c+14,size);ug_put32(c+18,ls);ug_put32(c+22,le);
    assert(call(UG_OP_PCM_CONFIG,c,sizeof(c),&len)==0); seal_obj(h); return h;
}
static uint16_t raw_asset(void) {
    for(unsigned i=0;i<sizeof(raw);i++) raw[i]=(uint8_t)(192+(i%32));
    return pcm_asset(raw,sizeof(raw),48000,1,8,0,0,0);
}
static uint16_t mod_asset(void) {
    enum { MOD_SIZE=1084+1024+128 }; uint8_t data[MOD_SIZE]={0};
    data[950]=1;data[951]=0;memcpy(data+1080,"M.K.",4);
    data[42]=0;data[43]=64;data[45]=64;data[48]=0;data[49]=64;
    data[1084]=1;data[1085]=0xac;data[1086]=0x10; /* sample 1, period 428 */
    data[1087]=0;for(unsigned i=1084+1024;i<MOD_SIZE;i++)data[i]=(uint8_t)((i&127)*2-128);
    uint16_t h=alloc_obj(3,MOD_SIZE);write_obj(h,data,MOD_SIZE);seal_obj(h);return h;
}
static uint16_t play_pcm(uint16_t handle,uint16_t repeats,uint8_t gain,uint8_t pan) {
    uint8_t q[6],len;put16(q,handle);put16(q+2,repeats);q[4]=gain;q[5]=pan;
    assert(call(UG_OP_PLAY_PCM,q,6,&len)==0 && len==2);return get16(response);
}
static uint16_t play_mod(uint16_t handle,uint8_t flags) {
    uint8_t q[3],len;put16(q,handle);q[2]=flags;
    assert(call(UG_OP_PLAY_MOD,q,3,&len)==0&&len==2);return get16(response);
}
static void control(uint8_t op,uint16_t id,uint8_t action) {
    uint8_t q[3],len;put16(q,id);q[2]=action;assert(call(op,q,3,&len)==0);
}
static unsigned pins(uint16_t handle) {
    uint8_t q[2],len;put16(q,handle);assert(call(UG_OP_OBJECT_INFO,q,2,&len)==0);return get16(response+4);
}
static void snapshot(void) { uint8_t len;assert(call(UG_OP_SNAPSHOT,NULL,0,&len)==0 && len==64); }
static uint16_t play_fx(uint16_t handle,uint16_t preferred,uint8_t flags) {
    uint8_t q[8]={0},len;put16(q,handle);put16(q+2,preferred?preferred:UINT16_MAX);q[4]=100;q[5]=64;q[6]=128;q[7]=flags;
    assert(call(UG_OP_PLAY_FX,q,8,&len)==0 && len==4);return get16(response);
}
static void fx_status(uint8_t *len){
    uint8_t q[16]={0};snapshot();memcpy(q,response+4,8);memcpy(q+8,response,4);put16(q+14,6);
    assert(!call(UG_OP_FX_STATUS,q,16,len));
}
static void build_wav(void) {
    memset(wav,0,sizeof(wav)); memcpy(wav,"RIFF",4); memcpy(wav+8,"WAVE",4);
    memcpy(wav+12,"data",4); ug_put32(wav+16,4); wav[20]=0;wav[21]=64;wav[22]=128;wav[23]=255;
    memcpy(wav+24,"JUNK",4);ug_put32(wav+28,3);wav[32]=1;wav[33]=2;wav[34]=3;wav[35]=0;
    memcpy(wav+36,"fmt ",4);ug_put32(wav+40,16);put16(wav+44,1);put16(wav+46,1);
    ug_put32(wav+48,11025);ug_put32(wav+52,11025);put16(wav+56,1);put16(wav+58,8);
    ug_put32(wav+4,52);
}
static void vector_render(unsigned n) {
    int16_t out[256];assert(n<=128);ug_storage_render(out,n);
    fprintf(vectors,"{\"render\":%u}\n",n);
}
static void shared_vectors(const char *path) {
    vectors=fopen(path,"w");assert(vectors);
    uint8_t len,q[8]={0};
    uint16_t h=raw_asset();
    const uint8_t stereo[8]={0,64,0,192,0,64,0,192};
    uint16_t sh=pcm_asset(stereo,8,48000,2,16,2,0,0);
    build_wav();uint16_t wh=alloc_obj(2,60);write_obj(wh,wav,60);seal_obj(wh);
    put16(q,wh);assert(!call(UG_OP_OBJECT_INFO,q,2,&len));
    uint16_t id=play_pcm(h,0,64,128);vector_render(1);
    control(UG_OP_CONTROL,id,1);vector_render(128);
    put16(q,h);assert(!call(UG_OP_OBJECT_INFO,q,2,&len));
    control(UG_OP_CONTROL,id,2);vector_render(1);
    put16(q,h);q[4]=0;q[5]=64;q[6]=128;q[7]=2;
    assert(call(UG_OP_PLAY_FX,q,8,&len)==UG_ERR_BAD_ARGUMENT);
    q[4]=255;assert(call(UG_OP_PLAY_FX,q,8,&len)==UG_ERR_BAD_ARGUMENT);
    for(unsigned i=0;i<4;i++) play_fx(h,0,2);
    put16(q,h);q[4]=100;q[5]=64;q[6]=128;q[7]=2;
    put16(q+2,1);assert(call(UG_OP_PLAY_FX,q,8,&len)==UG_ERR_NO_VOICE);
    fx_status(&len); /* accepted events not live */
    vector_render(2);fx_status(&len);
    q[0]=q[1]=0;assert(!call(UG_OP_STOP_FX,q,2,&len));vector_render(1);
    uint16_t sid=play_fx(sh,0,2);play_fx(sh,0,2);vector_render(1);
    control(UG_OP_CONTROL_FX,sid,1);vector_render(1);
    fx_status(&len);
    put16(q,h);put16(q+2,1);q[4]=200;q[5]=64;q[6]=128;q[7]=1;
    assert(!call(UG_OP_PLAY_FX,q,8,&len));vector_render(1);
    fx_status(&len);
    memset(q,0,sizeof(q));assert(!call(UG_OP_STOP_FX,q,2,&len));control(UG_OP_CONTROL,id,0);vector_render(1);
    play_pcm(wh,1,64,128);vector_render(128);
    put16(q,wh);assert(!call(UG_OP_OBJECT_INFO,q,2,&len));
    fclose(vectors);vectors=NULL;
    uint8_t reset[5]={0};ug_put32(reset,UG_RESET_STORE_KEY);assert(!call(UG_OP_RESET_STORE,reset,5,&len));
}
int main(void) {
    mock_reset(); ug_hw_claim_audio();ug_hw_claim_psram_sm();
    assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100; settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=0xffff;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0); ug_minimal_init();
    ug_storage_bind(&ps,17);int16_t pre[4]={123,456,789,12};assert(!ug_storage_render(pre,2));for(unsigned j=0;j<4;j++) assert(!pre[j]);ug_storage_publish(8u<<20,0,0);
    uint8_t info[1]={0},len; assert(call(UG_OP_CAPS,info,0,&len)==0 && get16(response+24)==UG_LANES && ug_get32(response+4)==127);
    assert(ug_get32(response)&1u); /* Complete GS dispatcher shares the native renderer. */

    const char *vp=getenv("UG_S6_VECTORS");if(vp) shared_vectors(vp);
    uint16_t mh=mod_asset(),mid=play_mod(mh,1);assert(pins(mh)==1);
    int16_t mout[256];for(unsigned i=0;i<16;i++)assert(ug_storage_render(mout,128));
    bool nonzero=false;for(unsigned i=0;i<256;i++)nonzero|=mout[i]!=0;assert(nonzero);
    snapshot();assert(response[25]==2&&get16(response+20)==mid&&response[40]==6&&response[41]==125);
    uint8_t ctlmod[3],qseek[5]={0};put16(ctlmod,mid);ctlmod[2]=1;assert(!call(UG_OP_CONTROL,ctlmod,3,&len));
    uint8_t before[128];assert(!call(UG_OP_SNAPSHOT,NULL,0,&len));memcpy(before,response,128);
    for(unsigned i=0;i<8;i++)ug_storage_render(mout,128);
    assert(!call(UG_OP_SNAPSHOT,NULL,0,&len));assert(!memcmp(before+36,response+36,6));
    ctlmod[2]=2;assert(!call(UG_OP_CONTROL,ctlmod,3,&len));put16(qseek,mid);put16(qseek+2,0);qseek[4]=0;
    assert(!call(UG_OP_SEEK_MOD,qseek,5,&len));ug_storage_render(mout,128);
    ctlmod[2]=0;assert(!call(UG_OP_CONTROL,ctlmod,3,&len));ug_storage_render(mout,128);assert(pins(mh)==0);
    uint16_t h=raw_asset(); uint8_t p[6]={0};put16(p,h);put16(p+2,1);p[4]=64;p[5]=128;
    assert(call(UG_OP_PLAY_PCM,p,6,&len)==0 && len==2);uint16_t play=get16(response);
    int16_t out[256]; assert(ug_storage_render(out,128)); assert(out[0]!=0 && out[1]!=0);
    assert(call(UG_OP_PLAY_PCM,p,6,&len)==0 && len==2 && get16(response)!=play);
    assert(ug_storage_render(out,128) && out[0]!=0 && out[1]!=0);
    play=get16(response);
    uint8_t ctl[3];put16(ctl,play);ctl[2]=1;assert(call(UG_OP_CONTROL,ctl,3,&len)==0);
    assert(!ug_storage_render(out,128));ctl[2]=2;assert(call(UG_OP_CONTROL,ctl,3,&len)==0);
    ctl[2]=0;assert(call(UG_OP_CONTROL,ctl,3,&len)==0);
    uint8_t fxr[8]={0};put16(fxr,h);fxr[4]=100;fxr[5]=64;fxr[6]=128;
    const uint16_t voices[4]={8,9,10,11};
    for(unsigned i=0;i<4;i++) { put16(fxr+2,voices[i]);assert(call(UG_OP_PLAY_FX,fxr,8,&len)==0 && len==4);assert(get16(response+2)==1); }
    put16(fxr+2,8);
    assert(call(UG_OP_PLAY_FX,fxr,8,&len)==UG_ERR_NO_VOICE);
    uint8_t stop[2]={0,0};assert(call(UG_OP_STOP_FX,stop,2,&len)==0);

    build_wav(); uint16_t wh=alloc_obj(2,60);write_obj(wh,wav,60);seal_obj(wh);
    uint8_t oi[2];put16(oi,wh);assert(call(UG_OP_OBJECT_INFO,oi,2,&len)==0 && len==38);
    assert(response[3]==1 && ug_get32(response+26)==11025 && ug_get32(response+30)==4);
    /* Audio changes are admitted now, applied only at render boundaries. */
    ug_storage_render(out,1);
    uint8_t mix[4]={64,64,64,64};
    for(unsigned i=0;i<16;i++) assert(call(UG_OP_SET_MIX,mix,4,&len)==0);
    assert(call(UG_OP_SET_MIX,mix,4,&len)==UG_ERR_BUSY);
    assert(call(UG_OP_PLAY_PCM,p,6,&len)==UG_ERR_BUSY);
    ug_storage_render(out,1);assert(!ug_storage_playback_busy());
    play=play_pcm(h,1,64,0);snapshot();assert(response[24]==0);
    assert(ug_storage_playback_busy() && !ug_minimal_idle());
    ug_storage_render(out,1);assert(out[0]==16384 && out[1]==0);
    ug_config_select(&ug_cfg,CMD_SAVE);ug_config_write(&ug_cfg,true,0,ug_minimal_idle());assert(ug_cfg.result==UG_ERR_BUSY);
    ug_config_select(&ug_cfg,CMD_UG_BASE);ug_config_write(&ug_cfg,false,0x80,ug_minimal_idle());ug_config_write(&ug_cfg,true,2,ug_minimal_idle());
    assert(ug_cfg.result==UG_ERR_BUSY && settings.UltraGS.basePort==0x2a0);
    ug_storage_main_volume(0);ug_storage_render(out,1);assert(out[0]==0 && out[1]==0);
    ug_storage_main_volume(100);ug_storage_render(out,1);assert(out[0]==16896);
    control(UG_OP_CONTROL,play,1);ug_storage_render(out,1);snapshot();uint32_t paused=ug_get32(response+32);
    assert(response[24]==2 && !ug_minimal_idle());ug_storage_render(out,128);snapshot();assert(ug_get32(response+32)==paused);
    /* Background upload remains allowed while foreground is paused/playing. */
    uint16_t another=raw_asset();assert(another!=h);
    control(UG_OP_CONTROL,play,2);ug_storage_render(out,1);
    assert(pins(h)==1); control(UG_OP_CONTROL,play,0);ug_storage_render(out,1);assert(pins(h)==0);

    /* Repeats never pad to a quantum, and EOF retains ID/position. */
    const uint8_t tiny[3]={192,193,194};uint16_t short_h=pcm_asset(tiny,3,48000,1,8,0,0,0);
    play=play_pcm(short_h,2,64,0);ug_storage_render(out,128);
    for(unsigned j=0;j<6;j++) assert(out[2*j]==(64+(int)(j%3))*256 && out[2*j+1]==0);
    for(unsigned j=6;j<128;j++) assert(out[2*j]==0 && out[2*j+1]==0);
    snapshot();assert(response[24]==3 && get16(response+20)==play && ug_get32(response+32)==3 && pins(short_h)==0);
    uint8_t badctl[3];put16(badctl,play);badctl[2]=2;assert(call(UG_OP_CONTROL,badctl,3,&len)==UG_ERR_STATE);
    play=play_pcm(short_h,0,64,0);ug_storage_render(out,128);for(unsigned j=0;j<128;j++) assert(out[2*j]==(64+(int)(j%3))*256);
    control(UG_OP_CONTROL,play,0);ug_storage_render(out,1);
    uint16_t loop_h=pcm_asset(tiny,3,48000,1,8,0,1,3);play_pcm(loop_h,1,64,0);ug_storage_render(out,6);
    const int16_t loop_expected[]={16384,16640,16896,16640,16896,16640};
    for(unsigned j=0;j<6;j++) assert(out[2*j]==loop_expected[j]);
    control(UG_OP_CONTROL,0,0);ug_storage_render(out,1);

    /* Preserve precision through three gains and use the existing main taper. */
    mix[0]=mix[2]=4;assert(call(UG_OP_SET_MIX,mix,4,&len)==0);
    play=play_pcm(h,1,4,0);ug_storage_render(out,1);assert(out[0]==4);
    mix[0]=mix[2]=64;assert(call(UG_OP_SET_MIX,mix,4,&len)==0);play_pcm(h,1,64,0);
    ug_storage_main_volume(50);ug_storage_render(out,1);assert(out[0]==2048);ug_storage_main_volume(100);
    control(UG_OP_CONTROL,0,0);ug_storage_render(out,1);

    /* Paused lanes are reserved; stealing a stereo member stops its pair. */
    uint16_t ids[4];for(unsigned j=0;j<4;j++) ids[j]=play_fx(h,voices[j],0);
    ug_storage_render(out,1);control(UG_OP_CONTROL_FX,ids[0],1);ug_storage_render(out,1);
    assert(call(UG_OP_PLAY_FX,fxr,8,&len)==UG_ERR_NO_VOICE && pins(h)==4);
    fx_status(&len);assert(len==84 && response[26]==2);
    put16(badctl,0);badctl[2]=0;assert(call(UG_OP_CONTROL_FX,badctl,3,&len)==UG_ERR_HANDLE);
    control(UG_OP_CONTROL_FX,ids[0],2);ug_storage_render(out,1);
    assert(call(UG_OP_STOP_FX,stop,2,&len)==0);ug_storage_render(out,1);assert(pins(h)==0);
    const uint8_t stereo_data[8]={0,64,0,192,0,64,0,192};uint16_t stereo_h=pcm_asset(stereo_data,8,48000,2,16,2,0,0);
    uint16_t sid=play_fx(stereo_h,0,2),sid2=play_fx(stereo_h,0,2);assert(sid!=sid2);ug_storage_render(out,1);
    fx_status(&len);
    assert(len==52 && get16(response+20)==sid && get16(response+22)==2 && get16(response+36)==sid2 && get16(response+38)==2);
    fxr[7]=1;fxr[4]=200;put16(fxr+2,0);assert(call(UG_OP_PLAY_FX,fxr,8,&len)==0);ug_storage_render(out,1);
    assert(pins(stereo_h)==1);put16(badctl,sid);assert(call(UG_OP_CONTROL_FX,badctl,3,&len)==UG_ERR_HANDLE);
    assert(call(UG_OP_STOP_FX,stop,2,&len)==0);ug_storage_render(out,1);
    /* Production storage/SEAL/readback while foreground + two stereo FX run. */
    play=play_pcm(h,0,64,0);play_fx(stereo_h,0,2);play_fx(stereo_h,0,2);ug_storage_render(out,128);
    control(UG_OP_CONTROL,play,1);assert(ug_storage_render(out,1) && out[1]!=0);snapshot();assert(response[24]==2);
    control(UG_OP_CONTROL,play,0);assert(ug_storage_render(out,1) && pins(h)==0 && pins(stereo_h)==2);
    play=play_pcm(h,0,64,0);assert(ug_storage_render(out,1) && pins(stereo_h)==2);
    mix[1]=16;assert(!call(UG_OP_SET_MIX,mix,4,&len));
    background_frame=1;pump_audio=true;build_wav();uint16_t background=alloc_obj(2,60);write_obj(background,wav,60);seal_obj(background);
    uint8_t rd[9]={0};put16(rd,h);put16(rd+6,512);rd[8]=129;
    assert(call(UG_OP_READ_BEGIN,rd,9,&len)==0 && len==8);
    uint32_t token=ug_get32(response),crc=ug_get32(response+4);ug_storage_grant_ack(time_us_32());
    fx_status(&len);assert(len==52);
    for(unsigned j=0;j<512;j++) { uint8_t byte;assert(!ug_storage_data_read(&byte,time_us_32()) && byte==raw[j]);if(j%32==31)audio_slice(); }
    uint8_t end[8];ug_put32(end,token);ug_put32(end+4,crc);assert(call(UG_OP_READ_END,end,8,&len)==0);
    pump_audio=false;printf("S6 concurrent: %u exact stereo frames during upload/SEAL/playing readback PASS\n",background_quanta*128);assert(background_quanta>20 && pins(h)==1 && pins(stereo_h)==2);
    assert(call(UG_OP_STOP_FX,stop,2,&len)==0);control(UG_OP_CONTROL,play,0);ug_storage_render(out,1);
    /* IDs wrap without colliding with a still-live looped instance. */
    uint16_t kept=play_fx(h,8,2);ug_storage_render(out,1);uint16_t churn=0;
    for(unsigned j=0;j<65540;j++) {
        if(churn) control(UG_OP_CONTROL_FX,churn,0);
        churn=play_fx(h,9,0);assert(churn && churn!=kept);ug_storage_render(out,1);
    }
    assert(pins(h)==2);
    /* Advance to the last token before wrap, then leave STOP queued while
     * reserving another PLAY. The renderer still owns the old token. */
    uint16_t before_kept=kept==1?65535:(uint16_t)(kept-1);
    while(churn!=before_kept) {
        control(UG_OP_CONTROL_FX,churn,0);
        churn=play_fx(h,9,0);assert(churn && churn!=kept);ug_storage_render(out,1);
    }
    control(UG_OP_CONTROL_FX,kept,0);
    uint16_t after_stop=play_fx(h,8,2);assert(after_stop!=kept && after_stop!=churn);
    ug_storage_render(out,1);assert(pins(h)==2);
    assert(call(UG_OP_STOP_FX,stop,2,&len)==0);ug_storage_render(out,1);assert(pins(h)==0);

    /* Fault output is zero and releases both lanes/pins. */
    play=play_pcm(stereo_h,0,64,128);ps.up=false;ug_storage_render(out,128);ps.up=true;
    for(unsigned j=0;j<256;j++) assert(out[j]==0);
    snapshot();assert(response[24]==4 && response[50]==UG_ERR_PSRAM && get16(response+20)==play);
    assert(pins(stereo_h)==0);play_pcm(h,0,64,0);ug_storage_render(out,8);
    snapshot();uint32_t position=ug_get32(response+32);assert(call(UG_OP_CLEAR_STATS,NULL,0,&len)==0);snapshot();assert(ug_get32(response+32)==position);
    /* Destructive reset flushes accepted events and live playback before reuse. */
    play_fx(h,0,2);uint8_t reset[5]={0};ug_put32(reset,UG_RESET_STORE_KEY);
    assert(call(UG_OP_RESET_STORE,reset,5,&len)==0 && len==8);ug_storage_render(out,128);
    for(unsigned j=0;j<256;j++) assert(out[j]==0);assert(!ug_storage_playback_busy());
    /* Failed I2S must not advertise audio; successful memory recovery enables it. */
    ug_storage_bind(&ps,18);ug_storage_publish(8u<<20,0,3);
    assert(!call(UG_OP_CAPS,NULL,0,&len) && ug_get32(response+4)==0 && get16(response+24)==0);
    ug_storage_bind(&ps,19);ug_storage_publish(0,UG_ERR_PSRAM,0);
    uint8_t quick=0;assert(!call(UG_OP_MEM_TEST,&quick,1,&len));
    assert(!call(UG_OP_CAPS,NULL,0,&len) && ug_get32(response+4)==127 && get16(response+24)==UG_LANES);
    puts("S6 storage/playback: RAW config, WAV SEAL/read metadata, PCM controls/repeats/mix/queue, stereo/paused FX, ID wrap, reset/fault/pins PASS");
    return 0;
}
