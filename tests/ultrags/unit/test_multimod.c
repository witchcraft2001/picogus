/* SPDX-License-Identifier: GPL-2.0-or-later */
#define main flt8_reference_main
#include "test_s8b_mod.c"
#undef main
int main(int argc,char **argv) {
    assert(argc==3);
    for(unsigned channels=1;channels<=32;channels++) {
        memory m={calloc(1,1084+512*channels+4),1084+512*channels+4,0,~0u};assert(m.b);
        m.b[950]=2;m.b[953]=1;char tag[5];
        if(channels<10)snprintf(tag,5,"%uCHN",channels);else snprintf(tag,5,"%uCH",channels);
        memcpy(m.b+1080,tag,4);m.b[43]=2;m.b[45]=32;m.b[49]=2;
        for(unsigned p=0;p<2;p++)for(unsigned row=0;row<64;row++)for(unsigned c=0;c<channels;c++) {
            unsigned off=1084+((p*64+row)*channels+c)*4,n=856-c*12-p*4;
            m.b[off]=n>>8;m.b[off+1]=n;m.b[off+2]=0x11;m.b[off+3]=c+1;
        }
        ug_mod_info i;assert(scan(&m,&i)==1 && i.channels==channels && i.sample_offset==1084+512*channels);
        ug_mod_player a;ug_mod_start(&a,&i,rd,&m,0,0);
        for(unsigned t=0;t<768;t++) {
            for(unsigned c=0;c<channels;c++)assert(a.channel[c].period==856-c*12-a.order*4-a.tick*(c+1));
            ug_mod_tick(&a);
        }
        assert(!a.playing);
        m.b[1084+(128*channels-1)*4]=0x20;assert(scan(&m,&i)==-1);
        m.b[950]=1;assert(scan(&m,&i)==1 && i.sample_offset==1084+512*channels);
        m.b[952]=1;assert(scan(&m,&i)==-1);m.b[952]=0;m.b[950]=2;
        m.b[1084+(128*channels-1)*4]=1;
        m.size--;assert(scan(&m,&i)==-1);free(m.b);
    }
    FILE *f=fopen(argv[1],"rb");assert(f);assert(!fseek(f,0,SEEK_END));unsigned size=(unsigned)ftell(f);rewind(f);
    memory m={malloc(size),size,0,~0u};assert(m.b && fread(m.b,1,size,f)==size);fclose(f);
    uint8_t *original=malloc(size);assert(original);memcpy(original,m.b,size);
    ug_mod_info i;assert(scan(&m,&i)==1 && i.channels==28);
    unsigned max=0;for(unsigned n=0;n<128;n++)if(m.b[952+n]<128 && m.b[952+n]>max)max=m.b[952+n];
    assert(i.sample_offset==1084+(max+1)*28*256);
    ug_mod_player a;ug_mod_start(&a,&i,rd,&m,0,0);
    unsigned ticks=0;while(a.playing && !a.paused && ticks<200000){ug_mod_tick(&a);ticks++;}
    assert(!a.error && !a.playing && ticks && !memcmp(original,m.b,size));
    printf("MOD 1..32 all-channel independent effects/offsets/EOF/bounds; original 28CH %u bytes, %u ticks, sample offset %u, immutable EOF PASS\n",size,ticks,i.sample_offset);
    for(const char **tag=(const char *[]){"00CH","33CH","99CH","0CHN","1XCH",NULL};*tag;tag++){
        memcpy(m.b+1080,*tag,4);assert(scan(&m,&i)==-1);
    }
    free(original);free(m.b);return 0;
}
