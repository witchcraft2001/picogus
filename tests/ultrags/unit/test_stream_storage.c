/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "sdk_mock.h"
#include "ug_storage.h"
#include "ug_minimal.h"
#include "ug_config.h"
#include "ug_hwmap.h"
#include "ug_psram.h"
#include "ug_s4.h"
#include "ultrags_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
extern void ug_hw_test_reset(void);
static Settings settings;
static ug_psram_t ps;
static uint8_t r[128],len,status;
static uint16_t handle;
static uint32_t sequence;
static uint16_t get16(const uint8_t *p) { return p[0]|((uint16_t)p[1]<<8); }
static void put16(uint8_t *p,uint16_t n) {p[0]=n;p[1]=n>>8;}
static uint64_t get64(const uint8_t *p) {uint64_t v;memcpy(&v,p,8);return v;}
static uint8_t call(uint8_t op,const void *q,unsigned n) {
    unsigned limit=10000;
    while(!ug_storage_command(op,q,n,r,&len,&status,time_us_32()))assert(limit--);
    return status;
}
static void init(void) {
    mock_reset();ug_hw_test_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();
    assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    memset(&settings,0,sizeof(settings));settings.Volume.mainVol=100;
    settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=65535;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();
    ug_storage_bind(&ps,123);ug_storage_publish(8u<<20,0,0);ug_storage_main_volume(100);
}
static uint8_t create_format(unsigned cap,unsigned prefill,unsigned low,unsigned rate,unsigned channels,unsigned bits,unsigned fmt) {
    uint8_t q[20]={0};ug_put32(q,rate);q[4]=channels;q[5]=bits;q[6]=fmt;
    ug_put32(q+8,cap);ug_put32(q+12,prefill);ug_put32(q+16,low);
    uint8_t e=call(UG_OP_STREAM_CREATE,q,20);
    if(!e) {assert(len==2);handle=get16(r);sequence=1;}
    return e;
}
static uint8_t create(unsigned cap,unsigned prefill,unsigned low) {
    return create_format(cap,prefill,low,44100,2,16,2);
}
static void state(void) {uint8_t q[2];put16(q,handle);assert(!call(UG_OP_STREAM_STATE,q,2));assert(len==70);}
static void close_stream(void) {
    uint8_t q[2];put16(q,handle);assert(!call(UG_OP_STREAM_CLOSE,q,2));
    int16_t out[256];ug_storage_render(out,128);
    assert(call(UG_OP_STREAM_STATE,q,2)==UG_ERR_HANDLE);
}
static void start(void) {
    uint8_t q[4];put16(q,handle);q[2]=64;q[3]=128;
    assert(!call(UG_OP_STREAM_START,q,4) && len==2);
}
static void control(uint8_t action) {
    uint8_t q[3]={0,0,action};assert(!call(UG_OP_CONTROL,q,3));
}
static void feed_begin(unsigned count,bool verified,uint32_t crc) {
    uint8_t q[13]={0};put16(q,handle);ug_put32(q+2,sequence);put16(q+6,count);q[8]=verified?128:0;ug_put32(q+9,crc);
    assert(!ug_storage_command(UG_OP_STREAM_FEED,q,verified?13:9,r,&len,&status,time_us_32()));
    assert(ug_storage_grant()==8);
}
static void feed_data(unsigned count) {
    for(unsigned i=0;i<count/4;i++) {
        assert(!ug_storage_data_write(0xe8,time_us_32()));assert(!ug_storage_data_write(3,time_us_32()));
        assert(!ug_storage_data_write(0x30,time_us_32()));assert(!ug_storage_data_write(0xf8,time_us_32()));
    }
}
static uint8_t feed_end(void) {return call(UG_OP_STREAM_FEED,NULL,0);}
static void feed(unsigned count) {
    feed_begin(count,false,0);feed_data(count);assert(!ug_storage_grant());
    assert(!feed_end() && len==12);assert(ug_get32(r)==++sequence);
}
static void render(int16_t out[256]) {ug_storage_render(out,128);}
static void full_free(void) {
    assert(!call(UG_OP_MEM_INFO,NULL,0));assert(get16(r+16)==0 && ug_get32(r+8)==8u<<20);
}
static uint16_t fx_asset(unsigned channels,unsigned value) {
    uint8_t q[26]={0};q[0]=1;ug_put32(q+1,channels*2);assert(!call(UG_OP_ALLOC,q,5));
    uint16_t h=get16(r);memset(q,0,sizeof(q));put16(q,h);put16(q+6,channels*2);
    assert(!call(UG_OP_WRITE_BEGIN,q,9));uint32_t token=ug_get32(r);ug_storage_grant_ack(time_us_32());
    for(unsigned ch=0;ch<channels;ch++) {
        unsigned v=value+100*ch;
        assert(!ug_storage_data_write(v,time_us_32()));assert(!ug_storage_data_write(v>>8,time_us_32()));
    }
    ug_put32(q,token);assert(!call(UG_OP_WRITE_END,q,4));memset(q,0,sizeof(q));
    put16(q,h);ug_put32(q+2,48000);q[6]=channels;q[7]=16;q[8]=2;ug_put32(q+14,channels*2);
    assert(!call(UG_OP_PCM_CONFIG,q,26));memset(q+2,0,5);assert(!call(UG_OP_SEAL,q,7));return h;
}
static void concurrent_fx(unsigned channels) {
    uint16_t assets[4];unsigned count=4/channels;int16_t out[256];uint8_t q[8]={0};
    for(unsigned i=0;i<count;i++) {
        assets[i]=fx_asset(channels,(i+1)*100);put16(q,assets[i]);put16(q+2,65535);
        q[4]=100;q[5]=64;q[6]=channels==2?128:i%2?255:0;q[7]=2;
        assert(!call(UG_OP_PLAY_FX,q,8));
    }
    render(out);int16_t left=out[0],right=out[1];
    assert(!create(64,32,8));feed(64);start();render(out);
    for(unsigned i=0;i<128;i++) {
        bool music=out[2*i]==left+1000;
        assert(out[2*i]==left || music);assert(out[2*i+1]==right+(music?-2000:0));
    }
    state();assert(r[2]==5);control(1);render(out);
    for(unsigned i=0;i<128;i++)assert(out[2*i]==left && out[2*i+1]==right);
    feed(64);control(2);render(out);assert(out[0]==left+1000 && out[1]==right-2000);
    control(0);render(out);for(unsigned i=0;i<128;i++)assert(out[2*i]==left && out[2*i+1]==right);
    memset(q,0,2);assert(!call(UG_OP_STOP_FX,q,2));render(out);
    for(unsigned i=0;i<count;i++){put16(q,assets[i]);assert(!call(UG_OP_FREE,q,2));}full_free();
    printf("stream + %u %s FX: play/pause/starve/resume/STOP independence PASS\n",count,channels==1?"mono":"stereo");
}
static void formats(void) {
    const unsigned rates[]={8000,11025,16000,22050,24000,32000,44100,48000,12345,47999};
    int16_t out[256];uint8_t q[16]={0};
    for(unsigned r0=0;r0<10;r0++)for(unsigned ch=1;ch<=2;ch++)for(unsigned fmt=0;fmt<3;fmt++) {
        unsigned fb=ch*(fmt==2?2:1);
        assert(!create_format(fb,fb,0,rates[r0],ch,fmt==2?16:8,fmt));state();
        assert(ug_get32(r+48)==rates[r0] && r[54]==ch && r[55]==(fmt==2?16:8) && !r[57]);
        feed_begin(fb,false,0);
        for(unsigned i=0;i<fb;i++)assert(!ug_storage_data_write(128,time_us_32()));
        assert(!feed_end());sequence++;start();put16(q,handle);
        assert(!call(UG_OP_STREAM_EOF,q,2));render(out);state();assert(r[2]==3 && get64(r+62)==1);
        close_stream();full_free();
    }
    for(unsigned pan=0;pan<=255;pan+=255) {
        assert(!create_format(2,2,0,48000,1,16,2));
        feed_begin(2,false,0);assert(!ug_storage_data_write(0x10,time_us_32()));
        assert(!ug_storage_data_write(0x27,time_us_32()));assert(!feed_end());
        put16(q,handle);q[2]=64;q[3]=pan;assert(!call(UG_OP_STREAM_START,q,4));
        put16(q,handle);assert(!call(UG_OP_STREAM_EOF,q,2));render(out);
        assert(out[0]==(pan?0:10000) && out[1]==(pan?10000:0));close_stream();full_free();
    }
    assert(create_format(4,4,0,7999,1,8,0)==UG_ERR_FORMAT);
    assert(create_format(4,4,0,48001,1,8,0)==UG_ERR_FORMAT);
    assert(create_format(4,4,0,22050,1,16,0)==UG_ERR_FORMAT);
    assert(create_format(4,4,0,22050,1,8,2)==UG_ERR_FORMAT);
    assert(!create_format(2,2,0,22050,1,16,2));put16(q,handle);ug_put32(q+2,1);put16(q+6,1);q[8]=0;
    assert(call(UG_OP_STREAM_FEED,q,9)==UG_ERR_LENGTH);close_stream();full_free();
    puts("stream descriptors/state/minimum FEED/EOF all 60 formats, mono pan, invalid descriptors and partial frames PASS");
}
int main(void) {
    init();formats();assert(!call(UG_OP_CAPS,NULL,0));assert(ug_get32(r)&UG_STREAM_FEATURE);
    assert(create(0,4,0)==UG_ERR_BAD_ARGUMENT);assert(create(16,0,0)==UG_ERR_BAD_ARGUMENT);
    assert(create(16,20,0)==UG_ERR_BAD_ARGUMENT);assert(create(16,8,8)==UG_ERR_BAD_ARGUMENT);
    assert(create(18,8,0)==UG_ERR_BAD_ARGUMENT);assert(create(8u<<20,4,0)==0);close_stream();full_free();
    assert(create((8u<<20)+4,4,0)==UG_ERR_NO_MEMORY);
    const unsigned cap[]={128*1024,256*1024,512*1024,192*1024};
    for(unsigned k=0;k<4;k++) {
        assert(!create(cap[k],cap[k]/2,cap[k]/8));state();
        assert(ug_get32(r+4)==cap[k] && ug_get32(r+8)==cap[k]/2 && ug_get32(r+12)==cap[k]/8);
        close_stream();full_free();
    }
    /* Contiguous allocation failure with enough total free memory. */
    uint16_t blob[4];for(unsigned i=0;i<4;i++) {
        uint8_t q[5]={0};ug_put32(q+1,2u<<20);assert(!call(UG_OP_ALLOC,q,5));blob[i]=get16(r);
    }
    for(unsigned i=0;i<4;i+=2){uint8_t q[2];put16(q,blob[i]);assert(!call(UG_OP_FREE,q,2));}
    assert(create(3u<<20,4,0)==UG_ERR_NO_MEMORY);
    for(unsigned i=1;i<4;i+=2){uint8_t q[2];put16(q,blob[i]);assert(!call(UG_OP_FREE,q,2));}
    full_free();
    assert(!create(192*1024,1024,128));uint8_t q[16]={0};put16(q,handle);
    assert(call(UG_OP_FREE,q,2)==UG_ERR_PINNED);
    assert(call(UG_OP_READ_BEGIN,q,9)==UG_ERR_LENGTH);put16(q+6,4);
    assert(call(UG_OP_READ_BEGIN,q,9)==UG_ERR_STATE);
    int16_t out[256];start();render(out);state();assert(r[2]==5 && get64(r+62)==0 && ug_get32(r+44)==0);
    feed(512);render(out);state();assert(r[2]==5 && get64(r+62)==0);
    feed(512);render(out);for(unsigned i=0;i<128;i++){assert(out[2*i]==1000 && out[2*i+1]==-2000);}
    control(1);render(out);state();uint64_t paused=get64(r+62);assert(r[2]==2);
    feed(1024);render(out);state();assert(get64(r+62)==paused && r[2]==2);
    control(2);for(unsigned i=0;i<20;i++)render(out);
    state();assert(r[2]==5 && ug_get32(r+44)==1);uint64_t stalled=get64(r+62);uint32_t fraction=ug_get32(r+58);
    for(unsigned i=0;i<10;i++)render(out);state();assert(ug_get32(r+44)==1 && get64(r+62)==stalled && ug_get32(r+58)==fraction);
    feed(512);render(out);state();assert(get64(r+62)==stalled);
    feed(512);render(out);assert(out[0]==1000 && out[1]==-2000);
    /* Feed ACK lost after COMMITTING: reset discards response only. */
    feed_begin(8,false,0);feed_data(8);assert(!ug_storage_command(UG_OP_STREAM_FEED,NULL,0,r,&len,&status,time_us_32()));
    assert(ug_storage_abort(time_us_32()));++sequence;state();assert(ug_get32(r+40)==sequence);
    /* Pre-commit cancellation/CRC/overflow never publish. */
    uint64_t published=get64(r+24);
    feed_begin(8,false,0);assert(!ug_storage_data_write(1,time_us_32()));ug_storage_request_cancel();ug_storage_tick(time_us_32());
    assert(feed_end()==UG_ERR_CANCELLED);state();assert(get64(r+24)==published);
    feed_begin(8,true,0);feed_data(8);assert(feed_end()==UG_ERR_CRC);state();assert(get64(r+24)==published);
    feed_begin(8,false,0);feed_data(8);assert(ug_storage_data_write(0,time_us_32())==UG_ERR_OVERFLOW);
    assert(feed_end()==UG_ERR_OVERFLOW);state();assert(get64(r+24)==published);
    feed_begin(8,false,0);mock_now+=5000001;ug_storage_tick(time_us_32());assert(feed_end()==UG_ERR_TIMEOUT);
    state();assert(get64(r+24)==published);
    feed_begin(8,false,0);mock_now+=5000001;ug_storage_tick(time_us_32());
    assert(ug_storage_abort(time_us_32()));state();assert(get64(r+24)==published);
    put16(q,handle);assert(!call(UG_OP_STREAM_EOF,q,2));
    for(unsigned i=0;i<20;i++)render(out);state();assert(r[2]==3 && get64(r+24)==get64(r+62));
    control(0);render(out);full_free();
    /* Repeated START/STOP/CLOSE and EOF before prefill, including minimum ring. */
    for(unsigned i=0;i<1000;i++) {
        assert(!create(i%2?4:28,i%2?4:24,0));feed(i%2?4:8);start();
        put16(q,handle);assert(!call(UG_OP_STREAM_EOF,q,2));render(out);state();assert(r[2]==3);
        close_stream();full_free();
    }
    assert(!create(1028,512,4));feed(1024);start();render(out);
    feed(256);render(out);for(unsigned i=0;i<128;i++)assert(out[2*i]==1000 && out[2*i+1]==-2000);
    control(0);render(out);full_free();
    concurrent_fx(1);concurrent_fx(2);
    puts("stream storage: config/fragmentation, single-RPC grant/commit, pause/starve/resume, lost ACK/cancel/CRC/timeout/overflow, EOF, 1000 lifecycles PASS");
}
