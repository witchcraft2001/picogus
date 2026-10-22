/* SPDX-License-Identifier: GPL-2.0-or-later */
/* Entire FLT8 song with inactive physical pairs, through the real object API. */
#define S8A_MAIN s8a_reference_main
#include "test_s8a_storage.c"
int main(int argc,char **argv) {
    assert(argc==4);FILE *f=fopen(argv[1],"rb");assert(f && !fseek(f,0,SEEK_END));
    unsigned n=(unsigned)ftell(f);rewind(f);uint8_t *data=malloc(n);
    assert(data && fread(data,1,n,f)==n);fclose(f);
    assert(!memcmp(data+1080,"FLT8",4));
    mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=0xffff;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();
    FILE *prefix=fopen(argv[3],"wb");assert(prefix);
    for(unsigned gs_path=0;gs_path<2;gs_path++) {
        bind();unsigned h;
        if(!gs_path) { h=upload(3,data,n);seal(h);play(h,0); }
        else {
            assert(gs(0x30,0)==1);
            for(unsigned i=0;i<n;i++){uint8_t error=0;ug_legacy_data(data[i],&error);assert(!error);}
            assert(gs(0xd2,0)==1 && gs(0x31,1)==1);render(0);
            assert(!call(UG_OP_LEGACY_INFO,NULL,0));h=get16(r);
        }
        render(0);control(0,1);render(128);assert(!audio[0] && !audio[1]);control(0,2);render(0);
        ug_stats_clear();unsigned nonzero=0,frame=0;
        /* Native reaches EOF; GS repeats, so render the same whole first pass. */
        unsigned duration=data[950]*64u*6u*960u;
        for(;frame<duration;frame+=128) {
            render(128);
            if(!gs_path && frame<3072)assert(fwrite(audio,4,128,prefix)==128);
            for(unsigned i=0;i<256;i++)nonzero+=audio[i]!=0;
        }
        snapshot();assert(nonzero && get16(r+26)==8 && r[24]==(gs_path?1:3));
        uint8_t stats[64];ug_stats_copy(stats);
        fprintf(stderr,"FLT8 stats: fetch_errors=%u clips=%u\n",ug_get32(stats+40),ug_get32(stats+60));
        assert(!ug_get32(stats+40));
        readback(h,data,n,true);if(gs_path)stop();assert(!pins(h));
        if(gs_path)gs(0x37,0);else free_obj(h);
        assert(!call(UG_OP_MEM_INFO,NULL,0) && !get16(r+16));
        printf("FLT8 tail %u bytes %s: %u frames, clips=%u, no read errors, full immutable readback and cleanup PASS\n",n,gs_path?"GS":"native",frame,ug_get32(stats+60));
    }
    fclose(prefix);free(data);return 0;
}
