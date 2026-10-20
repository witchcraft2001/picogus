/* SPDX-License-Identifier: GPL-2.0-or-later */
#define main shared_voice_reference_main
#include "test_shared_voices.c"
#undef main
#include "ug_legacy.h"
static uint8_t gs_status_byte(void) { return ug_minimal_read_decoded(0x1b); }
static void gs_wait(unsigned mask,unsigned value) {
    unsigned limit=100000;
    while((gs_status_byte()&mask)!=value) { assert(limit--);ug_minimal_dispatch(); }
}
static void sc(uint8_t c) { gs_wait(1,0);ug_minimal_write_decoded(0x1b,c,time_us_32());gs_wait(1,0); }
static void pre(uint8_t v) { assert(!(gs_status_byte()&128));ug_minimal_write_decoded(0x13,v,time_us_32()); }
static void sd(uint8_t v) { pre(v);gs_wait(128,0); }
static uint8_t gd(void) { return ug_minimal_read_decoded(0x13); }
static void command(uint8_t c,uint8_t v) { pre(v);sc(c); }
static void bytes(uint8_t *data,unsigned n) { for(unsigned i=0;i<n;i++) sd(data[i]); }
static uint8_t gs_error_code(void){sc(0xf0);uint8_t e=gd();ug_minimal_dispatch();return e;}
static void reply(unsigned cmd,uint8_t *dst,unsigned count) {
    sc((uint8_t)cmd);for(unsigned i=0;i<count;i++){gs_wait(128,128);dst[i]=gd();ug_minimal_dispatch();}
}
static void basic_conformance(void) {
    uint8_t b[4];reply(0x63,b,4);for(unsigned i=0;i<4;i++)assert(b[i]==127);
    reply(0x63,b,4);for(unsigned i=0;i<4;i++)assert(b[i]==255);
    reply(0x64,b,4);for(unsigned i=0;i<4;i++)assert(b[i]==0);
    reply(0x64,b,4);for(unsigned i=0;i<4;i++)assert(b[i]==128);
    const uint8_t supported[]={0,8,0x20,0x21,0x23,0x2a,0x2b,0x2e,0x30,0x31,0x32,0x33,0x35,0x36,0x37,0x38,0x39,0x3a,0x3d,0x3e,
        0x40,0x41,0x42,0x45,0x46,0x47,0x48,0x49,0x60,0x61,0x62,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6a,0x6b,
        0x80,0x81,0x82,0x83,0x88,0x89,0x8a,0x8b,0x90,0x91,0x92,0x93,0x98,0x99,0x9a,0x9b,0xa0,0xa1,0xa2,0xa3,0xa8,0xa9,0xaa,0xab,0xd0,0xd1,0xd2,0xf0,0xf3,0xf4,0xf5,0xf6};
    for(unsigned cmd=0;cmd<256;cmd++) {
        bool known=false;for(unsigned i=0;i<sizeof(supported);i++)if(supported[i]==cmd)known=true;
        if(!known){sc(0);sc((uint8_t)cmd);uint8_t e=gs_error_code();if(e!=UG_ERR_BAD_OPCODE)fprintf(stderr,"GS opcode %02x error=%02x expected01\n",cmd,e);assert(e==UG_ERR_BAD_OPCODE);sc(8);assert(gs_error_code()==UG_ERR_BAD_OPCODE);}
    }
    sc(0);reply(0x20,b,3);assert(b[0]==0&&b[1]==0&&b[2]==128);
    command(0x2a,255);assert(gd()==64);command(0x2a,64);assert(gd()==64);
    command(0x6a,1);assert(gd()==0);sc(0x6b);sc(0xd0); /* short relooper form */
    sc(0xf3);ug_minimal_dispatch();command(0x6a,0);assert(gd()==1);
    sc(0xf4);ug_minimal_dispatch();command(0x6a,0);assert(gd()==0);
    /* Legacy namespace remains1..60; defaults and sign do not alter bytes. */
    for(unsigned id=1;id<=60;id++){
        sc(0x38);assert(gd()==id);sd(128);sc(0xd2);assert(gd()==id);
        if(id==1){
            for(unsigned fine=0;fine<256;fine++) { command(0x42,(uint8_t)fine);assert(gd()==(uint8_t)(fine?fine-1:0)); }
            command(0x40,60);assert(gd()==60);command(0x41,255);assert(gd()==64);
            command(0x46,0xf1);assert(gd()==15);command(0x46,15);assert(gd()==1);
        }
    }
    sc(0x38);assert(!gd()&&ug_legacy_loading());sd(3);sc(0xd2);assert(!gd());assert(gs_error_code()==0x11);
    command(0x2e,1);command(0x39,0);render(1);capture();pages(UG_OP_FX_STATUS,1);
    assert(!call(UG_OP_LEGACY_INFO,NULL,0));unsigned first=get16(r+2);assert(first);
    uint8_t play[6]={0};put16(play,first);play[4]=1;play[5]=128;assert(!call(UG_OP_PLAY_PCM,play,6));render(1);
    sc(0x37);assert(gs_error_code()==UG_ERR_PINNED);assert(pins(first)==2);
    control(0,0);render(0);sc(0x37);assert(call(UG_OP_OBJECT_INFO,(uint8_t[]){(uint8_t)first,(uint8_t)(first>>8)},2)==UG_ERR_HANDLE);
    sc(0); /* explicit clear after PINNED; success never clears sticky error */
}
static void bulk_conformance(void) {
    sc(0xf3);ug_minimal_dispatch();command(0x3e,0);assert(gd()==1);
    sd(128);sd(0);assert(!call(UG_OP_LEGACY_INFO,NULL,0));unsigned h=get16(r+4);assert(h&&ug_get32(r+6)==2);
    uint8_t q[26]={0};put16(q,h);assert(call(UG_OP_FREE,q,2)==UG_ERR_PINNED);
    assert(call(UG_OP_PCM_CONFIG,q,26)==UG_ERR_STATE);assert(call(UG_OP_SEAL,q,7)==UG_ERR_STATE);
    for(unsigned cmd=0;cmd<256;cmd++)if(cmd!=0xd2&&cmd!=0xf3&&cmd!=0xf4){sc((uint8_t)cmd);assert(ug_legacy_loading()&&gd()==1);}
    assert(!call(UG_OP_LEGACY_INFO,NULL,0));assert(ug_get32(r+6)==2);
    ug_put32(q+2,2);put16(q+6,3);q[8]=1;assert(call(UG_OP_WRITE_BEGIN,q,9)==UG_ERR_BUSY);
    q[8]=0;assert(!call(UG_OP_WRITE_BEGIN,q,9));uint32_t token=ug_get32(r);ug_storage_grant_ack(time_us_32());
    sc(8);assert(!ug_minimal_read_decoded(7)&&ug_legacy_loading());
    const uint8_t tail[]={127,64,192};for(unsigned i=0;i<3;i++)assert(!ug_storage_data_write(tail[i],time_us_32()));
    ug_minimal_write_decoded(0x13,91,time_us_32());sc(0xd2);assert(ug_legacy_loading()&&ug_minimal_read_decoded(7)==UG_ERR_BUSY);
    ug_put32(q,token);assert(!call(UG_OP_TRANSFER_CANCEL,q,4));
    assert(!call(UG_OP_LEGACY_INFO,NULL,0));assert(ug_get32(r+6)==2);
    put16(q,h);ug_put32(q+2,2);put16(q+6,3);q[8]=0;
    assert(!call(UG_OP_WRITE_BEGIN,q,9));token=ug_get32(r);ug_storage_grant_ack(time_us_32());
    for(unsigned i=0;i<3;i++)assert(!ug_storage_data_write(tail[i],time_us_32()));
    ug_put32(q,token);assert(!call(UG_OP_WRITE_END,q,4));
    ug_minimal_write_decoded(2,0xa0,time_us_32());ug_minimal_dispatch();ug_minimal_dispatch();assert(ug_legacy_loading());
    assert(!call(UG_OP_LEGACY_INFO,NULL,0));assert(ug_get32(r+6)==5);sd(32);sc(0xd2);assert(gd()==1);
    const uint8_t all[]={128,0,127,64,192,32};put16(q,h);assert(!call(UG_OP_OBJECT_INFO,q,2));assert(ug_get32(r+14)==ug_crc32(all,sizeof(all)));
    sc(0);sc(0x38);assert(gd()==2);sc(0xd2);assert(!gd()&&gs_error_code()==UG_ERR_FORMAT);
    assert(!call(UG_OP_LEGACY_INFO,NULL,0)&&get16(r+2)==h); /* failed LOAD preserves earlier FX */
    sc(0xf3);ug_minimal_dispatch();
    puts("GS LOAD whitelist, pending guards, BULK commit/cancel, GS DATA discard, D2 BUSY, transport reset and failed-close isolation PASS");
}
static void stream_failures(void) {
    sc(0xf3);ug_minimal_dispatch();ug_storage_publish(64,0,0);
    sc(0x38);assert(gd()==1);for(unsigned i=0;i<65;i++)sd((uint8_t)i);
    sc(0xd2);assert(!gd()&&gs_error_code()==UG_ERR_OVERFLOW);
    assert(!call(UG_OP_MEM_INFO,NULL,0)&&ug_get32(r+8)==64&&!get16(r+16));
    sc(0);sc(0x38);assert(gd()==1);sd(128);ps.up=false;sc(0xd2);ps.up=true;
    assert(!gd()&&gs_error_code()==0xe1);assert(!call(UG_OP_MEM_INFO,NULL,0)&&!get16(r+16));
    sc(0xf3);ug_minimal_dispatch();ug_storage_publish(8u<<20,0,0);
    puts("GS overflow ack/discard, failed PSRAM flush mapped E1, no leaked stream/pin PASS");
}
static void deferred_stream_failures(void) {
    /* A diagnostic flush or a BULK commit can fail between GS DATA and D2.
     * Recovery of the backend must not turn a truncated LOAD into success. */
    sc(0xf3);ug_minimal_dispatch();sc(0x38);sd(128);sc(0xd2);assert(gd()==1);
    assert(!call(UG_OP_LEGACY_INFO,NULL,0));unsigned kept=get16(r+2);
    for(unsigned bulk=0;bulk<3;bulk++) {
        sc(0);sc(0x38);assert(gd()==2);sd(192);
        uint8_t q[13]={0};
        if(!bulk) {
            ps.up=false;assert(call(UG_OP_LEGACY_INFO,NULL,0)==UG_ERR_PSRAM);ps.up=true;
        } else {
            assert(!call(UG_OP_LEGACY_INFO,NULL,0));put16(q,get16(r+4));ug_put32(q+2,1);put16(q+6,3);
            assert(!call(UG_OP_WRITE_BEGIN,q,9));uint32_t token=ug_get32(r);ug_storage_grant_ack(time_us_32());
            for(unsigned i=0;i<3;i++)assert(!ug_storage_data_write(128,time_us_32()));
            ug_put32(q,token);ps.up=false;assert(call(UG_OP_WRITE_END,q,4)==UG_ERR_PSRAM);ps.up=true;
        }
        if(bulk!=1) sd(64); /* also exercise D2 directly after a failed commit */
        sc(0xd2);assert(!gd() && gs_error_code()==0xe1 && !ug_legacy_loading());
        assert(!call(UG_OP_MEM_INFO,NULL,0)&&get16(r+16)==1&&ug_get32(r+8)==(8u<<20)-16);
        assert(!call(UG_OP_LEGACY_INFO,NULL,0)&&get16(r+2)==kept);
    }
    sc(0xf3);ug_minimal_dispatch();
    puts("GS diagnostic flush/BULK commit failures remain sticky through D2; no truncated READY or leaked pending object PASS");
}
int main(void) {
    mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=65535;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();bind();
    sc(0);assert(gs_status_byte()==0x7e);basic_conformance();bulk_conformance();stream_failures();deferred_stream_failures();sc(0);
    sc(0x20);assert((gs_status_byte()&128) && gd()==0);ug_minimal_dispatch();assert(gd()==0);ug_minimal_dispatch();assert(gd()==128);ug_minimal_dispatch();assert(!ug_legacy_busy());
    sc(0x23);assert(gd()==255);ug_minimal_dispatch();
    sc(0x01);sc(0xf0);assert(gd()==1);ug_minimal_dispatch();sc(8);sc(0xf0);assert(gd()==1);ug_minimal_dispatch();sc(0);
    /* PROPLAY's SC30/WC/GD, D1, byte stream, D2/WC/GD, SD0/SC31. */
    uint8_t module[1084+1024+4]={0};module[950]=1;memcpy(module+1080,"M.K.",4);be16(module+42,2);module[45]=64;
    event(module,0,0,428,0,0);module[2108]=64;module[2109]=32;module[2110]=192;module[2111]=224;
    sc(0x30);assert(gd()==1 && ug_legacy_loading());sc(0xd1);
    bytes(module,1024);sc(0);assert(ug_legacy_loading());sc(0x36);assert(ug_legacy_loading());
    mock_now+=65000000;bytes(module+1024,sizeof(module)-1024);
    assert(!call(UG_OP_LEGACY_INFO,NULL,0));unsigned mh=get16(r+4);assert(mh && get16(r+4) && ug_get32(r+6)==sizeof(module));
    sc(0xd2);assert(gd()==1 && !ug_legacy_loading());
    uint8_t q[2];put16(q,mh);assert(!call(UG_OP_OBJECT_INFO,q,2));assert(ug_get32(r+14)==ug_crc32(module,sizeof(module)));
    command(0x31,0);assert(gd()==1);render(1);snapshot();assert(r[25]==2 && r[24]==1 && get16(r+52)==4);
    sc(0xf5);snapshot();unsigned row=r[38],tick=r[39];frames(48000);snapshot();assert(r[38]==row && r[39]==tick);
    sc(0x69);render(1);snapshot();assert(r[39]==tick+1);sc(0xf6);
    sc(0x32);render(1);snapshot();assert(r[24]==2);sc(0x33);render(1);snapshot();assert(r[24]==1);
    /* Legacy FX carries original signed bytes and borrows logical music. */
    command(0x3e,0);assert(gd()==1);sd(64);sd(192);sd(32);sd(224);sc(0xd2);assert(gd()==1);
    command(0x48,0);sd(0);sc(0xd0); /* aborted post has no partial effect */
    command(0x48,0);sd(0);sd(0);command(0x49,4);sd(0);sd(0);
    command(0x81,0);render(1);capture();pages(UG_OP_FX_STATUS,1);assert(get16(r+16)==1);
    sc(0x32);render(1);snapshot();assert(r[24]==2&&get16(r+54)==1);
    control(0,0);render(1);snapshot();assert(!r[24]&&get16(r+54)==1); /* foreground STOP preserves GS FX */
    bool audible=false;for(unsigned i=0;i<2;i++)audible|=audio[i]!=0;assert(audible);
    command(0x31,0);assert(gd()==1);render(1);
    uint8_t mix[4]={64,64,0,64};assert(!call(UG_OP_SET_MIX,mix,4));render(1);
    assert(audio[0] || audio[1]); /* music mute does not mute the overriding GS FX */
    command(0x3a,64);render(1);assert(!audio[0]&&!audio[1]);capture();pages(UG_OP_FX_STATUS,0);
    mix[2]=64;assert(!call(UG_OP_SET_MIX,mix,4));render(0);
    /* Independent native objects survive legacy-free; external pins refuse
     * before partial deletion. Native readback sees the exact uploaded bytes. */
    unsigned independent=pcm();sc(0x37);assert(!call(UG_OP_OBJECT_INFO,(uint8_t[]){(uint8_t)independent,(uint8_t)(independent>>8)},2));
    assert(call(UG_OP_OBJECT_INFO,q,2)==UG_ERR_HANDLE);assert(!ug_legacy_loading());
    render(128);for(unsigned i=0;i<256;i++)assert(!audio[i]); /* no ghost voice after freeing the GS module */
    sc(0xf3);ug_minimal_dispatch();assert(gs_status_byte()==0x7e);assert(call(UG_OP_OBJECT_INFO,(uint8_t[]){(uint8_t)independent,0},2)==UG_ERR_HANDLE);
    puts("GS production latches/PROPLAY LOAD-D1-D2-PLAY, delayed stream, CRC, pause/busy/manual tick, FX override/post cancellation/reset PASS");
}
