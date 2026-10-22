/* SPDX-License-Identifier: GPL-2.0-or-later */
#define S8A_MAIN s8a_reference_main
#include "test_s8a_storage.c"
int main(int argc,char **argv) {
    assert(argc==3);mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();
    assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=0xffff;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();
    for(unsigned channels=1;channels<=32;channels++) {
        bind();unsigned size=1084+256*channels+4;uint8_t *b=calloc(1,size);assert(b);
        char tag[5];if(channels<10)snprintf(tag,5,"%uCHN",channels);else snprintf(tag,5,"%uCH",channels);memcpy(b+1080,tag,4);b[950]=1;b[43]=2;b[45]=64;b[49]=2;
        memset(b+size-4,1,4);
        for(unsigned c=0;c<channels;c++){unsigned n=856-c*12;uint8_t *e=b+1084+c*4;e[0]=n>>8;e[1]=n;e[2]=16;}
        unsigned h=upload(3,b,size);seal(h);play(h,1);render(1);
        unsigned shift=channels>16?3:channels>8?2:channels>4?1:0;
        int amplitude=256>>shift,left=0,right=0;for(unsigned c=0;c<channels;c++)if(c%4==1 || c%4==2)right+=amplitude;else left+=amplitude;
        assert(audio[0]==left && audio[1]==right);
        for(unsigned c=0;c<channels;c++){voice(c);assert(get16(v+14)==856-c*12 && get16(v+6)==c);}
        unsigned mono=asset(1),stereo=asset(2);
        for(unsigned c=channels;c<32;c++){fx_start(mono,65535,100,2);render(0);}
        snapshot();assert(get16(r+26)==channels && get16(r+52)==32);
        uint8_t q[8]={0};put16(q,stereo);put16(q+2,65535);q[4]=254;q[5]=64;q[6]=128;q[7]=3;
        if(channels>=31)assert(call(UG_OP_PLAY_FX,q,8)==UG_ERR_NO_VOICE && !pins(stereo));
        put16(q+2,channels-1);assert(call(UG_OP_PLAY_FX,q,8)==UG_ERR_NO_VOICE && pins(h)==1);
        control(0,1);render(1);control(0,2);render(1);readback(h,b,size,true);
        q[0]=q[1]=0;assert(!call(UG_OP_STOP_FX,q,2));render(0);stop();
        free_obj(h);free_obj(mono);free_obj(stereo);free(b);
    }
    FILE *f=fopen(argv[1],"rb");assert(f);assert(!fseek(f,0,SEEK_END));unsigned size=(unsigned)ftell(f);rewind(f);
    uint8_t *b=malloc(size);assert(b && fread(b,1,size,f)==size);fclose(f);
    bind();unsigned h=upload(3,b,size);seal(h);play(h,0);render(1);snapshot();assert(get16(r+26)==28);
    frames(48000);readback(h,b,size,true);stop();free_obj(h);
    assert(gs(0x30,0)==1);for(unsigned n=0;n<size;n++){uint8_t e=0;ug_legacy_data(b[n],&e);assert(!e);if((n&255)==255)render(0);}
    assert(gs(0xd2,0)==1 && gs(0x31,1)==1);render(1);snapshot();assert(get16(r+26)==28);
    assert(!call(UG_OP_LEGACY_INFO,NULL,0));h=get16(r);readback(h,b,size,true);stop();gs(0x37,0);free(b);
    puts("MOD1..32 exact samples, all voices/status, shared-pool limits, no music stealing; original28 native+GS load/play/full readback/free PASS");return 0;
}
