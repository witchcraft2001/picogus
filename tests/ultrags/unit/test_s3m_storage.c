/* SPDX-License-Identifier: GPL-2.0-or-later */
#define S8A_MAIN s8a_reference_main
#include "test_s8a_storage.c"
static uint8_t *file(const char *dir,const char *name,unsigned *n) {
    char path[1024];snprintf(path,sizeof(path),"%s/%s.S3M",dir,name);FILE *f=fopen(path,"rb");assert(f);
    fseek(f,0,SEEK_END);*n=ftell(f);rewind(f);uint8_t *b=malloc(*n);assert(b && fread(b,1,*n,f)==*n);fclose(f);return b;
}
static void space(unsigned *free,unsigned *count) { assert(!call(UG_OP_MEM_INFO,NULL,0));*free=ug_get32(r+8);*count=get16(r+16); }
static uint8_t seal_status(unsigned h) {
    uint8_t q[7]={0},status,len;put16(q,h);unsigned limit=2000000;
    while(!ug_storage_command(UG_OP_SEAL,q,7,r,&len,&status,time_us_32()))assert(limit--);
    return status;
}
static void logical_pair(unsigned ch,uint8_t out[2][20]) {
    uint8_t key[16];snapshot();memcpy(key,r+4,8);memcpy(key+8,r,4);put16(key+14,1);unsigned n=0;
    for(unsigned i=0;i<32;i++) {put16(key+12,i);assert(!call(UG_OP_VOICE_STATUS,key,16));
        if(get16(r+26)==ch && !(r[39]&2)) { assert(n<2);memcpy(out[n++],r+20,20); }}
    assert(n==2);
}
int main(int argc,char **argv) {
    assert(argc==3);mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();
    assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=0xffff;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();
    const char *names[]={"MOU8","MOS8","MOU16","MOS16","STU8","STS8","STU16","STS16","M32","S16","LIMITS"};
    for(unsigned t=0;t<sizeof(names)/sizeof(*names);t++) {
        bind();unsigned n;uint8_t *b=file(argv[1],names[t],&n);unsigned h=upload(5,b,n),avail,count;
        assert(!seal_status(h));uint8_t q[8]={0};put16(q,h);assert(!call(UG_OP_OBJECT_INFO,q,2));
        assert(r[2]==5 && r[3]==1 && ug_get32(r+6)==n && ug_get32(r+14)==ug_crc32(b,n));
        space(&avail,&count);assert(count==1 && avail<((8u<<20)-((n+15)&~15u)));
        readback(h,b,n,true);
        if(t==10) { free_obj(h); }
        else {
            q[2]=2;assert(call(UG_OP_PLAY_MOD,q,3)==UG_ERR_BAD_ARGUMENT && !pins(h));
            play(h,0);render(128);snapshot();assert(r[25]==2 && get16(r+26)==(t==8?32:t==9?16:1));
            assert(get16(r+52)==(t==8 || t==9?32:t>=4?2:1));
            memset(q,0,5);put16(q+2,1);assert(call(UG_OP_SEEK_MOD,q,5)==UG_ERR_RANGE);
            snapshot();assert(r[24]==1 && pins(h));
            if(t==0 || t==6) {
                char path[1024];snprintf(path,sizeof(path),"%s/%s.s16le",argv[2],names[t]);FILE *f=fopen(path,"wb");assert(f);
                fwrite(audio,2,256,f);for(unsigned z=1;z<24;z++){render(128);fwrite(audio,2,256,f);}fclose(f);
            }
            q[0]=255;q[1]=200;assert(!call(UG_OP_SET_TEMPO,q,2));frames(960);snapshot();assert(r[40]==255 && r[41]==200);
            put16(q,t==8?31:0);q[2]=88;assert(!call(UG_OP_SET_PAN,q,3));render(0);voice(t==8?31:0);assert(v[18]==88);
            control(0,1);render(0);snapshot();unsigned tick=r[39];frames(4096);snapshot();assert(r[24]==2 && r[39]==tick);
            control(0,2);render(1);memset(q,0,5);q[4]=0;assert(!call(UG_OP_SEEK_MOD,q,5));render(0);
            if(t<8) {frames(60000);snapshot();assert(r[24]==3 && !pins(h));}else stop();
            free_obj(h);
        }
        space(&avail,&count);assert(!count && avail==8u<<20);free(b);
    }
    puts("S3M native all PCM encodings, source CRC/readback, private memory, 256 orders/254 patterns/255 instruments, tempo/pan/pause/seek/EOF PASS");
    bind();unsigned cut_size;uint8_t *cut=file(argv[1],"MOU8",&cut_size);
    unsigned pat=(cut[100]|cut[101]<<8)*16;cut[pat+3]=0x80;cut[pat+6]=6;cut[pat+7]=0x7f;
    unsigned cut_handle=upload(5,cut,cut_size);assert(!seal_status(cut_handle));play(cut_handle,1);
    frames(1920);render(128);for(unsigned i=0;i<256;i++)assert(!audio[i]);
    snapshot();assert(r[24]==1 && pins(cut_handle));stop();free_obj(cut_handle);free(cut);
    puts("S3M F slide to zero silences voice without DC output; invalid end-marker SEEK preserves playback PASS");
    bind();unsigned n;uint8_t *b=file(argv[1],"STU16",&n),q[8]={0};unsigned h=upload(5,b,n);assert(!seal_status(h));
    unsigned old=mod(0,0,0);play(old,1);render(0);unsigned fxh=asset(1);
    for(unsigned i=0;i<27;i++){fx_start(fxh,65535,100,2);render(0);}
    unsigned n32;uint8_t *b32=file(argv[1],"M32",&n32);unsigned full=upload(5,b32,n32);assert(!seal_status(full));
    put16(q,full);q[2]=0;assert(call(UG_OP_PLAY_MOD,q,3)==UG_ERR_NO_VOICE && !pins(full));snapshot();assert(get16(r+28)==old && pins(old));
    memset(q,0,2);assert(!call(UG_OP_STOP_FX,q,2));render(0);play(full,1);render(0);put16(q,fxh);put16(q+2,65535);q[4]=128;q[5]=64;q[6]=128;
    assert(call(UG_OP_PLAY_FX,q,8)==UG_ERR_NO_VOICE && !pins(fxh));stop();free_obj(full);free(b32);
    unsigned n17;uint8_t *b17=file(argv[1],"S17",&n17);unsigned many=upload(5,b17,n17);assert(!seal_status(many));put16(q,many);q[2]=0;
    play(h,1);render(0);assert(call(UG_OP_PLAY_MOD,q,3)==UG_ERR_NO_VOICE && pins(h));stop();free_obj(many);free(b17);free_obj(old);free_obj(fxh);free_obj(h);
    puts("S3M stereo reservation, full32, NO_VOICE preserves playing foreground, no stolen music/pins PASS");
    bind();h=upload(5,b,n);unsigned avail,count;space(&avail,&count);uint8_t alloc[5]={0};ug_put32(alloc+1,avail-16);assert(!call(UG_OP_ALLOC,alloc,5));unsigned blocker=get16(r);
    assert(seal_status(h)==UG_ERR_NO_MEMORY && !pins(h));free_obj(blocker);free_obj(h);space(&avail,&count);assert(avail==8u<<20 && !count);
    h=upload(5,b,n);put16(q,h);memset(q+2,0,5);uint8_t status,len;
    for(unsigned step=0;step<n/256+100;step++) {if(ug_storage_command(UG_OP_SEAL,q,7,r,&len,&status,time_us_32()))break;}
    assert(ug_storage_busy());assert(ug_storage_abort(time_us_32()));assert(!pins(h));space(&avail,&count);assert(avail==(8u<<20)-((n+15)&~15u));free_obj(h);
    h=upload(5,b,n);ug_psram_dma_fault=true;assert(seal_status(h)==UG_ERR_PSRAM && !pins(h));assert(!ug_psram_recover(&ps));free_obj(h);
    h=upload(5,b,n);put16(q,h);q[2]=1;ug_put32(q+3,123);assert(call(UG_OP_SEAL,q,7)==UG_ERR_CRC && !pins(h));free_obj(h);
    puts("S3M NO_MEMORY, cancelled preparation, CRC/PSRAM failure cleanup PASS");
    for(unsigned mode=0;mode<12;mode++) {
        bind();uint8_t *bad=malloc(n);assert(bad);memcpy(bad,b,n);unsigned sz=n;
        unsigned ih=(bad[98]|bad[99]<<8)*16,ph=(bad[100]|bad[101]<<8)*16;
        switch(mode) {
        case 0:sz=95;break;case 1:bad[98]=255;bad[99]=255;break;case 2:bad[ih]=2;break;
        case 3:bad[ih+30]=1;break;case 4:memset(bad+ih+16,255,4);break;case 5:memset(bad+ih+24,255,4);break;
        case 6:bad[ph+6]=13;break;case 7:bad[ph+4]=2;break;case 8:bad[ph+3]=0x4f;break;
        case 9:bad[ph+5]=65;break;case 10:bad[ph]=2;bad[ph+1]=0;break;case 11:sz=n-1;break;
        }
        h=upload(5,bad,sz);assert(seal_status(h)==UG_ERR_FORMAT && !pins(h));free_obj(h);space(&avail,&count);assert(!count && avail==8u<<20);free(bad);
    }
    puts("S3M truncated headers/samples, invalid pointers/loops/notes/instruments/volumes/effects, FM/packed rejection PASS");
    bind();assert(gs(0x30,0)==1);for(unsigned j=0;j<n;j++){uint8_t e=0;ug_legacy_data(b[j],&e);assert(!e);}
    assert(gs(0xd2,0)==1);assert(!call(UG_OP_LEGACY_INFO,NULL,0));h=get16(r);readback(h,b,n,true);
    put16(q,h);assert(!call(UG_OP_OBJECT_INFO,q,2) && r[2]==5);assert(gs(0x31,1)==1);render(0);
    gs(0x32,0);render(0);snapshot();assert(r[24]==2);gs(0x33,0);render(0);
    gs(0xf5,0);snapshot();unsigned row=r[38],tick=r[39];frames(2000);snapshot();assert(r[38]==row && r[39]==tick);
    gs(0x69,0);render(0);snapshot();assert(r[39]==tick+1);gs(0xf6,0);gs(0x65,0);render(0);
    uint8_t baseline[2][20],restored[2][20];frames(1000);logical_pair(0,baseline);gs(0x65,0);render(0);
    assert(gs(0x38,0)==1);for(unsigned j=0;j<256;j++){uint8_t e=0;ug_legacy_data(128,&e);assert(!e);}assert(gs(0xd2,0)==1);
    gs(0x65,0);render(0);gs(0x80,1);render(128);for(unsigned j=0;j<256;j++)assert(!audio[j]);frames(872);
    gs(0x3a,0x40);render(0);logical_pair(0,restored);
    assert(ug_get32(baseline[0]+8)==ug_get32(restored[0]+8) && ug_get32(baseline[1]+8)==ug_get32(restored[1]+8));
    stop();gs(0x37,0);space(&avail,&count);assert(!count && avail==8u<<20);free(b);
    puts("S3M GS detection/readback/PLAY/pause/resume/seek/manual ticks; stereo FX mute/advance/restore and cleanup PASS");return 0;
}
