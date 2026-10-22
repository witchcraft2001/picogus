/* SPDX-License-Identifier: GPL-2.0-or-later */
#define S8A_MAIN s8a_reference_main
#include "test_s8a_storage.c"

int main(int argc,char **argv) {
    assert(argc==3);uint8_t data[7484];FILE *f=fopen(argv[1],"rb");assert(f);
    unsigned size=(unsigned)fread(data,1,sizeof(data),f);assert(size==7484 || size==4284);fclose(f);
    unsigned channels=size==4284?4:8;
    mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=0xffff;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();
    bind();unsigned h=upload(3,data,size);seal(h);play(h,0);render(1);
    for(unsigned c=0;c<channels;c++){voice(c);assert(get16(v+14)==856-30*c);}
    control(0,1);render(1);assert(!audio[0] && !audio[1]);control(0,2);render(1);
    for(unsigned order=0;order<6;order++){
        uint8_t q[5]={0,0,0,0,63};put16(q+2,order);assert(!call(UG_OP_SEEK_MOD,q,5));render(0);
        for(unsigned c=0;c<channels;c++){voice(c);assert(get16(v+14)==855-30*c-8*(channels==4?data[952+order]:order/2));}
        frames(6*960);snapshot();assert(order==5?r[24]==3:get16(r+36)==order+1);
    }
    readback(h,data,size,true);free_obj(h);
    assert(gs(0x30,0)==1);for(unsigned n=0;n<size;n++){uint8_t e=0;ug_legacy_data(data[n],&e);assert(!e);}
    assert(gs(0xd2,0)==1 && gs(0x31,1)==1);render(1);
    for(unsigned c=0;c<channels;c++){voice(c);assert(get16(v+14)==856-30*c);}
    assert(!call(UG_OP_LEGACY_INFO,NULL,0));h=get16(r);readback(h,data,size,true);
    stop();gs(0x37,0);
    puts("FLT4/FLT8 production storage SEAL/GS D2/PLAY, distinct channels, transitions, pause/resume, full post-play readback/free PASS");return 0;
}
