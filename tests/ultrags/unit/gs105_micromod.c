/* SPDX-License-Identifier: GPL-2.0-or-later */
/* Include the unmodified, pinned independent reference in this test TU only. */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include "micromod.c"
int main(int argc,char **argv){
    assert(argc==3);FILE *f=fopen(argv[1],"rb");assert(f);fseek(f,0,SEEK_END);long n=ftell(f);rewind(f);
    signed char *b=malloc((size_t)n);assert(b&&fread(b,1,(size_t)n,f)==(size_t)n);fclose(f);
    assert(!micromod_initialise(b,48000));
    for(int i=0;i<atoi(argv[2]);i++){
        struct channel *c=&channels[0];
        long period=c->period+c->vibrato_add;
        period=period*arp_tuning[c->arpeggio_add]>>11;period=(period>>1)+(period&1);
        long v=c->volume+c->tremolo_add;if(v>64)v=64;if(v<0)v=0;
        printf("[%ld,%ld,%ld,%ld,%ld,%u,%ld]\n",pattern,row,((speed-tick)%speed+speed)%speed,speed,120000/tick_len,(unsigned)period,(long)v);
        sequence_tick();
    }
    free(b);return 0;
}
