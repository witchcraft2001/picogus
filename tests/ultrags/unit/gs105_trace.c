/* SPDX-License-Identifier: GPL-2.0-or-later */
/* Tracker traces plus byte-exact native/GS rendering of independently built fixtures. */
#define main shared_voice_reference_main
#include "test_shared_voices.c"
#undef main
#include "ug_legacy.h"
#include "ug_mod.h"
static void wait_gs(unsigned mask,unsigned value) {
    unsigned left=100000;
    while((ug_minimal_read_decoded(0x1b)&mask)!=value){assert(left--);ug_minimal_dispatch();}
}
static void gs(unsigned cmd){wait_gs(1,0);ug_minimal_write_decoded(0x1b,(uint8_t)cmd,time_us_32());wait_gs(1,0);}
static void data(unsigned v){ug_minimal_write_decoded(0x13,(uint8_t)v,time_us_32());wait_gs(128,0);}
static int memory(void *ctx,uint32_t off,uint8_t *dst,uint32_t len){memcpy(dst,(uint8_t*)ctx+off,len);return 0;}
static void collect(int16_t *dst,unsigned n){while(n){unsigned count=n>128?128:n;render(count);memcpy(dst,audio,count*4);dst+=count*2;n-=count;}}
int main(int argc,char **argv){
    assert(argc==3||argc==4);unsigned ticks=(unsigned)atoi(argv[2]);assert(ticks&&ticks<1000);
    FILE *f=fopen(argv[1],"rb");assert(f);assert(!fseek(f,0,SEEK_END));unsigned n=(unsigned)ftell(f);rewind(f);
    uint8_t *b=malloc(n);assert(b&&fread(b,1,n,f)==n);fclose(f);
    ug_mod_info mi;ug_mod_player p;assert(!ug_mod_parse(&mi,memory,b,n));ug_mod_start(&p,&mi,memory,b,1,0);
    for(unsigned i=0;i<ticks;i++){
        ug_mod_channel *c=&p.channel[0];
        printf("[%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%d,%u,%u,%u,%u,%u]\n",p.order,p.row,p.tick,p.speed,p.bpm,c->period,c->volume,c->mix_volume,c->pan,c->sample_offset,c->trigger,c->fine,c->glissando,c->wave_vibrato,c->wave_tremolo,c->vibrato_pos,c->tremolo_pos);
        ug_mod_tick(&p);
    }
    mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=65535;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();bind();
    unsigned h=upload(3,b,n);seal(h);play(h,1);
    unsigned length=ticks*960;int16_t *native=malloc(length*4),*legacy=malloc(length*4);assert(native&&legacy);
    collect(native,length);
    if(argc==4)for(unsigned i=6*960*2;i<length*2;i++)assert(native[i]==0);
    stop();
    gs(0x30);assert(ug_minimal_read_decoded(0x13)==1);gs(0xd1);
    for(unsigned i=0;i<n;i++)data(b[i]);gs(0xd2);assert(ug_minimal_read_decoded(0x13)==1);
    ug_minimal_write_decoded(0x13,0,time_us_32());gs(0x31);assert(ug_minimal_read_decoded(0x13)==1);
    collect(legacy,length);assert(!memcmp(native,legacy,length*4));
    fprintf(stderr,"NATIVE_GS exact %u stereo frames PASS\n",length);
    free(native);free(legacy);free(b);return 0;
}
