/* SPDX-License-Identifier: GPL-2.0-or-later */
/* Full original MOD through production SEAL/tracker/mixer. */
#define S8A_MAIN s8a_reference_main
#include "test_s8a_storage.c"
int main(int argc,char **argv) {
    assert(argc==4);FILE *f=fopen(argv[1],"rb");assert(f && !fseek(f,0,SEEK_END));
    unsigned n=(unsigned)ftell(f);rewind(f);uint8_t *data=malloc(n);assert(data && fread(data,1,n,f)==n);fclose(f);
    assert(n==957334 && !memcmp(data+1080,"28CH",4));
    mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=0xffff;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();bind();
    unsigned h=upload(3,data,n);seal(h);play(h,0);render(0);ug_stats_clear();
    FILE *prefix=fopen(argv[3],"wb");assert(prefix);
    uint32_t maximum=0;unsigned nonzero=0;uint64_t energy=0;
    for(unsigned second=0;second<515;second++) {
        for(unsigned frame=0;frame<48000;frame+=128) {
            render(128);
            if(!second && frame<3072)assert(fwrite(audio,4,128,prefix)==128);
            for(unsigned i=0;i<256;i++) {
                int sample=audio[i];unsigned magnitude=(unsigned)(sample<0?-sample:sample);
                if(magnitude>maximum)maximum=magnitude;
                energy+=(uint64_t)(sample*sample);nonzero+=sample!=0;
            }
        }
        uint8_t stats[64];ug_stats_copy(stats);
        assert(!ug_get32(stats+60) && !ug_get32(stats+40));
    }
    fclose(prefix);
    snapshot();assert(r[24]==3 && get16(r+26)==28 && !pins(h));
    assert(nonzero>48000*100 && energy && maximum>16000 && maximum<32767);
    readback(h,data,n,true);free_obj(h);free(data);
    printf("DOPE full515s production audio: zero clips/fetch errors, peak=%u, nonzero=%u, energy=%llu; EOF/pins/full immutable readback PASS\n",maximum,nonzero,(unsigned long long)energy);
    return 0;
}
