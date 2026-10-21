/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_mod.h"
#include "ug_wire.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static uint8_t *data;static size_t size;
static int read_mod(void *ctx,uint32_t off,uint8_t *dst,uint32_t n){(void)ctx;if(off+n>size)return -1;memcpy(dst,data+off,n);return 0;}
int main(int argc,char **argv) {
    assert(argc==3);FILE *f=fopen(argv[1],"rb");assert(f);assert(!fseek(f,0,SEEK_END));size=ftell(f);rewind(f);data=malloc(size);assert(data && fread(data,1,size,f)==size);fclose(f);
    ug_mod_info info;assert(!ug_mod_parse(&info,read_mod,NULL,size));ug_mod_player p;
    ug_mod_start(&p,&info,read_mod,NULL,atoi(argv[2]),0);uint64_t frames=0;
    while(p.playing && frames<48000*600u) {
        printf("{\"order\":%u,\"pattern\":%u,\"row\":%u,\"tick\":%u,\"speed\":%u,\"bpm\":%u,\"frames\":%llu,\"paused\":%u}\n",p.order,p.info.order[p.order],p.row,p.tick,p.speed,p.bpm,(unsigned long long)frames,p.paused);
        if(p.paused)break;
        uint32_t n=ug_mod_frames_to_tick(&p);ug_mod_advance_frames(&p,n);frames+=n;
    }
    printf("{\"end_frames\":%llu,\"playing\":%u,\"paused\":%u}\n",(unsigned long long)frames,p.playing,p.paused);free(data);return 0;
}
