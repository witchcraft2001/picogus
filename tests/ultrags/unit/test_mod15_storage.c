/* SPDX-License-Identifier: GPL-2.0-or-later */
#define S8A_MAIN s8a_reference_main
#include "test_s8a_storage.c"
int main(int argc,char **argv) {
    assert(argc==3);mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();
    assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=0xffff;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();
    /* Physical sample 1 has a two-byte transient followed by a six-byte loop;
     * sample 2 must start after the full eight bytes, not after six. */
    uint8_t fixture[600+1024+16]={0};fixture[470]=1;fixture[471]=120;
    be16(fixture+42,4);fixture[45]=64;be16(fixture+46,2);be16(fixture+48,3);
    be16(fixture+72,4);fixture[75]=64;be16(fixture+78,1);
    fixture[600]=1;fixture[601]=172;fixture[602]=0x10;
    fixture[604]=1;fixture[605]=172;fixture[606]=0x20;
    memset(fixture+1624,100,2);memset(fixture+1626,32,6);memset(fixture+1632,16,8);
    bind();unsigned fixture_handle=upload(3,fixture,sizeof(fixture));seal(fixture_handle);
    play(fixture_handle,1);render(1);assert(audio[0]==32*256 && audio[1]==16*256);
    frames(4800);assert(audio[0]==32*256 && audio[1]==0);
    stop();readback(fixture_handle,fixture,sizeof(fixture),true);free_obj(fixture_handle);
    puts("MOD15 production C sample skip, loop and next physical sample PASS");
    for(int file=1;file<argc;file++) {
        FILE *f=fopen(argv[file],"rb");assert(f);assert(!fseek(f,0,SEEK_END));unsigned size=ftell(f);rewind(f);
        uint8_t *b=malloc(size);assert(b && fread(b,1,size,f)==size);fclose(f);
        bind();unsigned h=upload(3,b,size);seal(h);play(h,0);render(1);snapshot();assert(get16(r+26)==4);
        frames(48000);control(0,1);render(0);control(0,2);render(1);readback(h,b,size,true);stop();free_obj(h);
        assert(gs(0x30,0)==1);for(unsigned n=0;n<size;n++){uint8_t e=0;ug_legacy_data(b[n],&e);assert(!e);if((n&255)==255)render(0);}
        assert(gs(0xd2,0)==1 && gs(0x31,1)==1);render(1);snapshot();assert(get16(r+26)==4);
        assert(!call(UG_OP_LEGACY_INFO,NULL,0));h=get16(r);readback(h,b,size,true);stop();gs(0x37,0);free(b);
        printf("MOD15 native/GS load, play, controls, full readback, free: %s PASS\n",argv[file]);
    }return 0;
}
