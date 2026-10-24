/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_s3m.h"
#include <stdio.h>
#include <stdlib.h>
#include <assert.h>
#include <string.h>
#include <inttypes.h>
static uint8_t *source,*aux;static uint32_t size,aux_size;
static int rd(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    int priv=ctx!=NULL;assert(n<=256);uint32_t limit=priv?aux_size:size;
    if(off>limit || n>limit-off)return -1;memcpy(dst,(priv?aux:source)+off,n);return 0;
}
static int wr(void *ctx,uint32_t off,const uint8_t *src,uint32_t n) {
    (void)ctx;assert(n<=256 && off<=aux_size && n<=aux_size-off);memcpy(aux+off,src,n);return 0;
}
int main(int argc,char **argv) {
    assert(argc==2);FILE *f=fopen(argv[1],"rb");assert(f);fseek(f,0,SEEK_END);size=ftell(f);rewind(f);
    source=malloc(size);assert(source && fread(source,1,size,f)==size);fclose(f);
    ug_s3m_parser parser;ug_s3m_parser_init(&parser,size);int rc;
    do { rc=ug_s3m_parser_step(&parser,rd,NULL,NULL,NULL); }while(!rc);assert(rc==1);
    aux_size=parser.info.aux_size;aux=calloc(1,aux_size);assert(aux);ug_s3m_parser_init(&parser,size);
    do { rc=ug_s3m_parser_step(&parser,rd,NULL,wr,NULL); }while(!rc);assert(rc==1);
    ug_s3m_player player;ug_s3m_start(&player,&parser.info,rd,aux,0);
    for(unsigned t=0;t<20000 && player.playing;t++,ug_s3m_tick(&player)) {
        printf("%u %u %u %u %u",player.order,player.row,player.row_tick,player.speed,player.bpm);
        for(unsigned ch=0;ch<parser.info.channels;ch++) {
            const ug_s3m_channel *c=&player.channel[ch];
            printf(" %u %" PRIu64 " %u %u %u %u",c->note,c->period,c->mix_volume,c->pan,c->trigger,c->sample_offset);
        }
        puts("");
    }
    assert(!player.error);free(aux);free(source);return 0;
}
