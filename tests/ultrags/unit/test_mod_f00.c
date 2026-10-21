/* SPDX-License-Identifier: GPL-2.0-or-later */
#define main s7_reference_main
#include "test_s7_storage.c"
#undef main
#include "ug_legacy.h"
static uint8_t gs(unsigned cmd,unsigned pre) {
    uint8_t out=0,error=0;bool db;unsigned limit=10000;
    while(!ug_legacy_command(cmd,true,pre,&out,&db,&error)){render(128);assert(limit--);}
    assert(!error);return out;
}
static void check(unsigned h,unsigned state,unsigned row,unsigned speed,unsigned bpm) {
    snapshot();if(r[24]!=state || r[38]!=row || r[40]!=speed || r[41]!=bpm) fprintf(stderr,"check handle=%u expected=%u,%u,%u,%u actual=%u,%u,%u,%u\n",h,state,row,speed,bpm,r[24],r[38],r[40],r[41]);assert(r[24]==state && r[38]==row && r[40]==speed && r[41]==bpm);
    assert(pins(h)==1);
}
static void seek_row(unsigned id,unsigned row) {
    uint8_t q[5]={0};put16(q,id);q[4]=row;assert(!call(UG_OP_SEEK_MOD,q,5));render(0);
}
static void fixture(const char *path,unsigned channels) {
    bind();FILE *f=fopen(path,"rb");assert(f);uint8_t b[4096];unsigned n=fread(b,1,sizeof(b),f);assert(feof(f));fclose(f);
    unsigned h=upload(3,b,n);seal(h);
    assert(!call(UG_OP_CAPS,NULL,0) && (ug_get32(r)&UG_MOD_F00_POLICY_FEATURE));
    unsigned fxh=pcm();uint8_t fx[8]={0};put16(fx,fxh);put16(fx+2,65535);fx[4]=128;fx[5]=64;fx[6]=255;fx[7]=2;
    assert(!call(UG_OP_PLAY_FX,fx,8));render(0);
    /* Explicit policies win over either initial and subsequent GS6A setting. */
    for(unsigned initial=0;initial<2;initial++)for(unsigned policy=2;policy<=4;policy+=2) {
        gs(0x6a,initial);unsigned id=play(h,policy);render(0);
        assert(gs(0x6a,!initial)==initial);frames(2400);
        check(h,policy==2?1:2,1,3,150);assert(pins(fxh)==1);
        unsigned position; snapshot();position=r[39];
        if(policy==4) {
            frames(48000);check(h,2,1,3,150);assert(audio[0]==0 && audio[1]==16384);
            snapshot();assert(r[39]==position);control(id,2);render(0);
        }
        frames(2400);check(h,1,2,3,150);voice(channels-1);assert(get16(v+14)==320);
        frames(4800);snapshot();assert(r[24]==3 && !pins(h) && pins(fxh)==1 && audio[1]==16384);
    }
    /* Zero policy keeps the live historical 6A setting. */
    for(unsigned initial=0;initial<2;initial++) {
        gs(0x6a,initial);play(h,0);render(0);assert(gs(0x6a,!initial)==initial);
        frames(2400);check(h,initial?2:1,1,3,150);stop();
    }
    /* PAUSE/RESUME and SEEK preserve explicit policy, including a paused seek. */
    for(unsigned policy=2;policy<=4;policy+=2) {
        gs(0x6a,policy==2?0:1);unsigned id=play(h,policy|UG_MOD_LOOP);render(0);
        control(id,1);render(0);seek_row(id,1);check(h,2,1,6,125);
        control(id,2);render(0);seek_row(id,0);frames(2400);check(h,policy==2?1:2,1,3,150);
        if(policy==4){control(id,2);render(0);}frames(7200);check(h,1,0,3,150);
        frames(2400);check(h,policy==2?1:2,1,3,150);stop();
    }
    /* 66 is a control command: its zero argument still uses global6A. */
    gs(0x6a,0);unsigned id=play(h,UG_MOD_IGNORE_F00);render(0);gs(0x66,0);render(0);check(h,2,0,3,150);
    control(id,2);render(0);stop();gs(0x6a,1);play(h,UG_MOD_PAUSE_F00);render(0);gs(0x66,0);render(0);check(h,1,0,3,150);stop();
    /* All invalid flag bytes are rejected without consuming/replacing PLAY. */
    id=play(h,UG_MOD_IGNORE_F00|UG_MOD_LOOP);render(0);
    for(unsigned flags=0;flags<256;flags++)if((flags&~7u)||(flags&6)==6) {
        uint8_t q[3];put16(q,h);q[2]=flags;assert(call(UG_OP_PLAY_MOD,q,3)==UG_ERR_BAD_ARGUMENT);
        render(0);snapshot();assert(get16(r+20)==id && r[24]==1 && pins(h)==1);
    }
    /* Check rejection also while a valid MOD PLAY is queued. */
    play(h,2);uint8_t q[3];put16(q,h);q[2]=6;assert(call(UG_OP_PLAY_MOD,q,3)==UG_ERR_BAD_ARGUMENT);render(0);stop();
    /* Explicit PAUSE applies already at the PLAY boundary on row0. */
    b[1084+3]=0;unsigned zero=upload(3,b,n);seal(zero);play(zero,4);render(0);check(zero,2,0,6,150);stop();
    /* Legacy GS LOAD/PLAY inherits6A (never the last native policy). */
    assert(gs(0x30,0)==1);for(unsigned i=0;i<n;i++){uint8_t e=0;ug_legacy_data(b[i],&e);assert(!e);}assert(gs(0xd2,0)==1);
    gs(0x6a,0);assert(gs(0x31,1)==1);render(0);snapshot();assert(r[24]==2);stop();
    gs(0x6a,1);assert(gs(0x31,1)==1);render(0);snapshot();assert(r[24]==1);stop();
    b[1084+3]=3;
    put16(q,h);assert(!call(UG_OP_OBJECT_INFO,q,2));assert(ug_get32(r+14)==ug_crc32(b,n));
    for(unsigned off=0;off<n;) {
        uint8_t req[9]={0};unsigned k=n-off>1024?1024:n-off;put16(req,h);ug_put32(req+2,off);put16(req+6,k);
        assert(!call(UG_OP_READ_BEGIN,req,9));uint32_t token=ug_get32(r);ug_storage_grant_ack(time_us_32());
        for(unsigned i=0;i<k;i++){uint8_t v;assert(!ug_storage_data_read(&v,time_us_32()) && v==b[off+i]);}
        ug_put32(req,token);assert(!call(UG_OP_READ_END,req,4));off+=k;
    }
    put16(q,0);assert(!call(UG_OP_STOP_FX,q,2));render(0);
    printf("MOD%u F00: policies/GS6A/66/legacy/seek/loop/FX/pins/invalid256/readback PASS\n",channels);
}
int main(int argc,char **argv) {
    assert(argc==3);mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=0xffff;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();fixture(argv[1],4);fixture(argv[2],8);return 0;
}
