/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_mod.h"
#include <xmp.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static uint8_t *data;
static uint32_t size;
static int rd(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    (void)ctx;assert(n<=256);
    if(off>size || n>size-off)return -1;
    memcpy(dst,data+off,n);return 0;
}
int main(int argc,char **argv) {
    assert(argc==3 && !strcmp(xmp_version,"4.7.0"));
    FILE *file=fopen(argv[1],"rb");assert(file);
    assert(!fseek(file,0,SEEK_END));long length=ftell(file);assert(length>0 && length<=UINT32_MAX);
    size=(uint32_t)length;rewind(file);data=malloc(size);assert(data);
    assert(fread(data,1,size,file)==size);fclose(file);
    ug_mod_info info;ug_mod_parser parser;ug_mod_parser_init(&parser,&info,size);int rc;
    do {rc=ug_mod_parser_step(&parser,&info,rd,NULL);}while(!rc);assert(rc==1 && info.profile);
    ug_mod_player player;ug_mod_start(&player,&info,rd,NULL,0,0);
    xmp_context x=xmp_create_context();assert(x && !xmp_load_module(x,argv[1]));
    struct xmp_module_info reference_info;xmp_get_module_info(x,&reference_info);
    assert(reference_info.mod->ins==15 && reference_info.mod->chn==4);
    assert(!strcmp(reference_info.mod->type,info.profile==UG_MOD_UST?
        "Ultimate Soundtracker":"Soundtracker IX"));
    assert(!xmp_start_player(x,48000,0));
    unsigned expected=(unsigned)strtoul(argv[2],NULL,10),ticks=0,errors=0;
    uint8_t volume[4]={64,64,64,64},instrument[4]={255,255,255,255};uint8_t selected[4]={255,255,255,255};uint32_t triggers[4]={0};
    while(player.playing && ticks<100000) {
        assert(!xmp_play_frame(x));struct xmp_frame_info ref;xmp_get_frame_info(x,&ref);
        assert(!ref.loop_count);
        if(player.order!=ref.pos || player.row!=ref.row || player.tick!=ref.frame ||
           player.speed!=ref.speed || player.bpm!=ref.bpm)errors++;
        for(unsigned ch=0;ch<4;ch++) {
            const ug_mod_channel *c=&player.channel[ch];const struct xmp_channel_info *v=&ref.channel_info[ch];
            /* Independently decode source events: libxmp's public volume is zero
             * after sample EOF, while the tracker keeps its instrument volume. */
            if(!player.tick) {
                const uint8_t *e=data+600+info.order[player.order]*1024+player.row*16+ch*4;
                unsigned sample=(e[0]&0xf0)|(e[2]>>4),period=((e[0]&15)<<8)|e[1];
                if(sample) { selected[ch]=sample-1;volume[ch]=data[20+(sample-1)*30+25]; }
                if(period) { instrument[ch]=selected[ch];triggers[ch]++; }
                if((e[2]&15)==12)volume[ch]=e[3]>64?64:e[3];
            }
            int diff=(int)c->period-(int)((v->period+2048u)/4096u);
            bool bad=(v->period && (diff>1 || diff< -1 || (c->voice_sample!=255 && c->voice_sample!=v->instrument))) || c->mix_volume!=volume[ch] ||
                (instrument[ch]!=255 && c->voice_sample!=instrument[ch]) || c->trigger!=triggers[ch];
            if(bad && errors++<10)fprintf(stderr,"tick %u ch %u: period %u/%u volume %u/%u trigger %u/%u\n",
                ticks,ch,c->period,(v->period+2048u)/4096u,c->mix_volume,volume[ch],c->trigger,triggers[ch]);
        }
        ticks++;ug_mod_tick(&player);
    }
    /* The reference must reach the same first loop boundary, not merely share
     * a prefix with a prematurely stopped production player. */
    assert(!xmp_play_frame(x));struct xmp_frame_info end;xmp_get_frame_info(x,&end);
    if(!end.loop_count || player.error || ticks!=expected)errors++;
    printf("%s: profile %u, %u ticks, %u mismatches\n",argv[1],info.profile,ticks,errors);
    xmp_end_player(x);xmp_release_module(x);xmp_free_context(x);free(data);
    return errors?1:0;
}
