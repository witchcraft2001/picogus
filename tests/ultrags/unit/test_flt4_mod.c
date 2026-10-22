/* SPDX-License-Identifier: GPL-2.0-or-later */
#define main flt8_reference_main
#include "test_s8b_mod.c"
#undef main

static memory file4(const char *name) {
    FILE *f=fopen(name,"rb");assert(f);
    memory m={calloc(1,1084+128*1024+128),4284,0,~0u};assert(m.b);
    assert(fread(m.b,1,4284,f)==4284 && fgetc(f)==EOF);fclose(f);return m;
}
int main(int argc,char **argv) {
    assert(argc==3);memory m=file4(argv[1]),ref=file4(argv[2]);
    uint8_t original[4284];memcpy(original,m.b,sizeof(original));
    ug_mod_info i,j;assert(scan(&m,&i)==1 && scan(&ref,&j)==1);
    assert(!i.flt8 && i.channels==4 && i.sample_offset==4156);
    const unsigned order[]={0,1,2,1,0,2};
    for(unsigned n=0;n<128;n++)assert(i.order[n]==(n<6?order[n]:0));
    ug_mod_player a,b;ug_mod_start(&a,&i,rd,&m,0,0);ug_mod_start(&b,&j,rd,&ref,0,0);
    for(unsigned t=0;t<2304;t++) {
        same(&a,&b);
        if(a.row==0 || a.row==63)for(unsigned c=0;c<4;c++)
            assert(a.channel[c].period==856-30*c-8*order[a.order]-(a.row==63) && a.channel[c].sample==c);
        ug_mod_tick(&a);ug_mod_tick(&b);
    }
    same(&a,&b);assert(!a.playing && !memcmp(original,m.b,sizeof(original)));
    puts("FLT4 independent M.K. equivalent: 2304 ticks, four channels, unshifted odd orders, row0/63, EOF and immutable source PASS");
    for(unsigned c=0;c<4;c++) {
        memset(m.b+1084,0,3072);m.b[1084+c*4]=1;m.b[1085+c*4]=0xac;m.b[1086+c*4]=0x11;m.b[1087+c*4]=3;
        ug_mod_start(&a,&i,rd,&m,0,0);ug_mod_tick(&a);assert(a.channel[c].period==425);
        m.b[1086+c*4]=0x1e;m.b[1087+c*4]=0x92;
        ug_mod_start(&a,&i,rd,&m,0,0);for(unsigned t=0;t<4;t++)ug_mod_tick(&a);
        assert(a.channel[c].trigger==3);
    }
    memcpy(m.b,original,sizeof(original));
    m.size=4155;assert(scan(&m,&i)==-1);m.size=4283;assert(scan(&m,&i)==-1);m.size=4284;
    m.b[950]=0;assert(scan(&m,&i)==-1);m.b[950]=6;
    m.b[952]=128;assert(scan(&m,&i)==-1);m.b[952]=0;
    m.b[45]=65;assert(scan(&m,&i)==-1);m.b[45]=12;
    m.b[47]=32;assert(scan(&m,&i)==-1);m.b[47]=0;
    m.b[4152]=0x20;assert(scan(&m,&i)==-1);memcpy(m.b,original,sizeof(original));
    m.fail=2108;assert(scan(&m,&i)==-2);m.fail=~0u;
    /* Ordinary MOD4 tail policy, unlike FLT8: inactive FF is ignored. */
    m.b[1079]=255;assert(scan(&m,&i)==1 && i.sample_offset==4156);
    m.b[950]=1;m.b[1079]=2;assert(scan(&m,&i)==1 && i.sample_offset==4156);
    m.b[1079]=127;assert(scan(&m,&i)==-1);
    m.size=1084+128*1024+128;memset(m.b+4156,0,m.size-4156);
    m.b[952]=127;assert(scan(&m,&i)==1 && i.sample_offset==132156);
    m.b[132152]=1;m.b[132153]=0xac;m.b[132154]=16;
    ug_mod_start(&a,&i,rd,&m,0,0);assert(!ug_mod_seek(&a,0,63) && a.channel[3].period==428);
    m.size=4284;memcpy(m.b,original,sizeof(original));assert(scan(&m,&i)==1);
    ug_mod_start(&a,&i,rd,&m,0,0);m.fail=1100;
    for(unsigned t=0;t<6;t++)ug_mod_tick(&a);
    assert(!a.playing && a.error && !memcmp(original,m.b,sizeof(original)));
    puts("FLT4 native effects, bounded cooperative reads, truncation/song/volume/loop/instrument/read failures, inactive orders and pattern127 PASS");
    free(m.b);free(ref.b);return 0;
}
