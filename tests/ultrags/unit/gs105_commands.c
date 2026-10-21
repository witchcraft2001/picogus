/* SPDX-License-Identifier: GPL-2.0-or-later */
/* GS wire/state assertions and an independent floating-point FX oracle. */
#define main shared_voice_reference_main
#include "test_shared_voices.c"
#undef main
#include "ug_legacy.h"
#include <math.h>
static bool seen[256];
static uint8_t status(void){return ug_minimal_read_decoded(0x1b);}
static void gs_wait(unsigned mask,unsigned expected){unsigned n=10000;while((status()&mask)!=expected){assert(n--);ug_minimal_dispatch();}}
static void sc(unsigned c){gs_wait(1,0);ug_minimal_write_decoded(0x1b,(uint8_t)c,time_us_32());assert(status()&1);gs_wait(1,0);seen[c]=true;}
static void sd(unsigned v){ug_minimal_write_decoded(0x13,(uint8_t)v,time_us_32());assert(status()&128);gs_wait(128,0);}
static void pre(unsigned c,unsigned v){ug_minimal_write_decoded(0x13,(uint8_t)v,time_us_32());sc(c);}
static unsigned gd(void){return ug_minimal_read_decoded(0x13);}
static unsigned err(void){sc(0xf0);unsigned e=gd();ug_minimal_dispatch();return e;}
static void reply(unsigned c,uint8_t *b,unsigned n){sc(c);while(n--){*b++=(uint8_t)gd();ug_minimal_dispatch();}}
static void post(unsigned c,unsigned lo,unsigned mid,unsigned hi){pre(c,lo);sd(mid);sd(hi);}
static unsigned fx_asset(unsigned sign){pre(0x3e,sign);assert(gd());for(unsigned i=0;i<8;i++){
    int v=(int[]){-16,-8,0,8,16,8,0,-8}[i];sd((uint8_t)(v+(sign?128:0)));}
    sc(0xd2);assert(gd());assert(!err());assert(!call(UG_OP_LEGACY_INFO,NULL,0));return get16(r+2);
}
static void init(void){mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();assert(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
 settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=65535;
 ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();bind();}
static void pauses_and_abort(void){
 const unsigned seconds[]={0,1,5,60,120};
 for(unsigned p=0;p<5;p++){
  sc(0x38);unsigned handle=gd();assert(handle);sd(128);mock_now+=seconds[p]*1000000u;ug_minimal_dispatch();sd(192);sc(0xd2);assert(gd()==handle);
  pre(0x48,0);sd(0);mock_now+=seconds[p]*1000000u;ug_minimal_dispatch();sd(0);
  post(0x49,2,0,0);assert(!err());
  for(unsigned c=0;c<5;c++)for(unsigned abort=0xd0;abort<=0xd1;abort++){
   const unsigned commands[]={0x48,0x49,0x88,0x90,0x98};sc(0);pre(commands[c],c<2?0:handle);
   if(c<2||c==4)sd(0);
   mock_now+=seconds[p]*1000000u;ug_minimal_dispatch();sc(abort);assert(!err());
   snapshot();assert(!get16(r+54));
  }
 }
 sc(0x37);puts("G02/G09 LOAD and incomplete POST pause 0/1/5/60/120s, D0/D1 abort atomic PASS");
}
/* Independent PAL-rate interpolation and gain oracle for command families.
 * Phase is carried across pitch/gain changes, reset only by a new PLAY. */
static long double note_step(unsigned note) {
 long double period=(unsigned[]){856,808,762,720,678,640,604,570,538,508,480,453}[note%12];
 return 3546895.0L/(ldexpl(period,3-(int)(note/12))*48000);
}
static long double wave_check(unsigned note,unsigned gain,unsigned lane,long double phase,unsigned frames) {
 long double step=note_step(note);
 while(frames){unsigned count=frames>128?128:frames;render(count);
  for(unsigned i=0;i<count;i++,phase+=step){unsigned at=(unsigned)floorl(phase)%8;long double f=phase-floorl(phase);
   int a=(int[]){-16,-8,0,8,16,8,0,-8}[at]*256,z=(int[]){-16,-8,0,8,16,8,0,-8}[(at+1)%8]*256;
   int want=(int)llroundl((a+(z-a)*f)*gain/64);
   assert(abs(audio[2*i+lane]-want)<=96);assert(!audio[2*i+1-lane]);
  }frames-=count;
 }return phase;
}
static void fx_oracle(void){
 const unsigned fine_values[]={0,1,2,0x1e,0x1f,0xfe,0xff};unsigned cases=0;
 for(unsigned sign=0;sign<2;sign++){
  unsigned h=fx_asset(sign);post(0x48,0,0,0);post(0x49,8,0,0);
  uint8_t q[2];put16(q,h);assert(!call(UG_OP_OBJECT_INFO,q,2));assert(r[36]==(sign?0:1));
  for(unsigned note=0;note<96;note++)for(unsigned fi=0;fi<7;fi++){
   unsigned fine=fine_values[fi];pre(0x40,note);pre(0x42,fine);pre(0x80,0);
   int index=(int)((fine>>1)&15);if(index>=8)index-=16;
   /* Published PAL note/period definition, independently evaluated as real
    * rational octave shifts and an exponential eighth-semitone tuning. */
   long double period=(long double)(unsigned[]){856,808,762,720,678,640,604,570,538,508,480,453}[note%12];
   period=ldexpl(period,3-(int)(note/12))*exp2l(-(long double)index/96);
   long double step=3546895.0L/period/48000;
   unsigned frame=0;
   while(frame<1024){render(128);for(unsigned i=0;i<128;i++,frame++){
    long double position=step*frame;unsigned at=(unsigned)floorl(position)%8;long double fraction=position-floorl(position);
    int a=(int[]){-16,-8,0,8,16,8,0,-8}[at]*256,b=(int[]){-16,-8,0,8,16,8,0,-8}[(at+1)%8]*256;
    int want=(int)llroundl(a+(b-a)*fraction);
    /* Q16 period constants + Q32 phase quantization are bounded within
     * 96 signed16 units over this 1024-frame, full96-note/fine matrix. */
    if(abs(audio[2*i]-want)>96){fprintf(stderr,"FX oracle note%u fine%02x frame%u got%d want%d\n",note,fine,frame,audio[2*i],want);abort();}
    assert(!audio[2*i+1]);
   }}
   pre(0x3a,0x80);cases++;
  }
  sc(0x37);
 }
 /* Two independently signed/unsigned assets mix additively at GS DAC0/2.
  * Direct lane0 is left, lane2 right; 3A uses historical high bits. */
 unsigned a=fx_asset(0);(void)a;post(0x48,0,0,0);post(0x49,8,0,0);pre(0x40,60);pre(0x41,16);
 unsigned z=fx_asset(1);(void)z;post(0x48,0,0,0);post(0x49,8,0,0);pre(0x40,60);pre(0x41,16);
 pre(0x80,1);pre(0x82,2);render(128);for(unsigned i=0;i<128;i++){
  long double phase=note_step(60)*i;unsigned at=(unsigned)floorl(phase)%8;long double f=phase-floorl(phase);
  int a=(int[]){-16,-8,0,8,16,8,0,-8}[at]*256,z=(int[]){-16,-8,0,8,16,8,0,-8}[(at+1)%8]*256;
  int want=(int)llroundl((a+(z-a)*f)/4);
  assert(abs(audio[2*i]-want)<=96&&abs(audio[2*i+1]-want)<=96);
 }
 pre(0x3a,0xff);pre(0x80,1);pre(0x81,2);wave_check(60,32,0,0,128);
 pre(0x3a,0xff);render(128);for(unsigned i=0;i<256;i++)assert(!audio[i]);sc(0x37);
 printf("G05/G06/F01 independent FX pitch/sign/loop/mix oracle %u profiles PASS\n",cases);
}
static void legacy_ids(uint16_t ids[4]) {
 capture();put16(key+12,0);put16(key+14,4);assert(!call(UG_OP_FX_STATUS,key,16));assert(get16(r+14)==4);
 for(unsigned i=0;i<4;i++)ids[i]=get16(r+20+16*i);
}
static void commands(void){
 unsigned independent=pcm();unsigned h=fx_asset(1);(void)h;fx_asset(1);post(0x48,0,0,0);post(0x49,8,0,0);
 pre(0x2b,12);assert(gd()==64);pre(0x2b,64);assert(gd()==12);
 pre(0x3d,17);assert(gd()==64);pre(0x3d,64);assert(gd()==17);
 pre(0x45,128);assert(gd()==128);pre(0x46,15);assert(gd()==15);pre(0x47,15);assert(gd()==15);
 /* 39 lower free first, equal priority refuses; higher wins lowest tie. */
 for(unsigned c=0;c<4;c++){pre(0x39,0);assert(!err());render(0);}
 uint16_t before[4],after[4];legacy_ids(before);
 pre(0x39,0);assert(err()==UG_ERR_NO_VOICE);render(0);legacy_ids(after);assert(!memcmp(before,after,sizeof(before)));
 sc(0);pre(0x45,129);pre(0x39,0);assert(!err());render(0);legacy_ids(after);
 assert(after[0]!=before[0]);for(unsigned i=1;i<4;i++)assert(after[i]==before[i]);
 pre(0x3a,0xff);
 for(unsigned c=0;c<4;c++){
  pre(0x3a,0xff);pre(0x40,60);pre(0x41,64);pre(0x42,0);
  unsigned lane=c<2?0:1;pre(0x80+c,0);long double phase=wave_check(60,64,lane,0,128);
  pre(0x40,24);pre(0x41,1);pre(0x42,0x1e);phase=wave_check(60,64,lane,phase,128);
  pre(0x40,60);pre(0x41,64);pre(0x42,0);
  pre(0xa0+c,48+c);phase=wave_check(48+c,64,lane,phase,128);
  pre(0xa8+c,8+c);wave_check(48+c,8+c,lane,phase,128);assert(!err());
  pre(0x88+c,0);sd(60+c);wave_check(60+c,64,lane,0,128);assert(!err());
  pre(0x90+c,0);sd(32+c);wave_check(60,32+c,lane,0,128);assert(!err());
  pre(0x98+c,0);sd(36+c);sd(16+c);wave_check(36+c,16+c,lane,0,128);assert(!err());
 }
 pre(0x3a,0xff);pre(0x46,0);pre(0x47,4);pre(0x39,0);render(1);snapshot();assert(get16(r+54)==1);pre(0x3a,0x20);render(0);snapshot();assert(!get16(r+54));
 uint8_t b[4];reply(0x20,b,3);assert(b[0]==0&&b[1]==0&&b[2]==128);sc(0x23);assert(gd()==255);pre(0x2a,32);assert(!(status()&128));assert(gd()==64);pre(0x2a,64);assert(gd()==32);reply(0x21,b,3);assert((unsigned)(b[0]|b[1]<<8|b[2]<<16)<(8u<<20));
 sc(0x36);assert(gd()==255);pre(0x2e,1);assert(gd()==2);pre(0x2e,0);assert(gd()==1);
 sc(0x32);assert(!gd());sc(0x33);assert(!gd());
 sc(0x37);uint8_t q[2];put16(q,independent);assert(!call(UG_OP_OBJECT_INFO,q,2));
 /* Native cleanup of a published GS FX invalidates its legacy reference. */
 unsigned discarded=fx_asset(1);put16(q,discarded);assert(!call(UG_OP_FREE,q,2));
 assert(!call(UG_OP_LEGACY_INFO,NULL,0));assert(!get16(r+2));
 puts("G01/G03/G06 optional latches, direct families, note/volume overrides, masks/priority, EXT ownership PASS");
}
static void mod_commands(void){
 uint8_t b[1084+2048+32]={0};b[950]=2;b[953]=1;memcpy(b+1080,"M.K.",4);be16(b+42,16);be16(b+48,16);b[45]=32;
 for(unsigned c=0;c<4;c++)event(b,0,c,(unsigned[]){856,678,538,428}[c],12,8+c*8);
 memset(b+3132,16,32);sc(0x30);assert(gd()==1);for(unsigned i=0;i<sizeof(b);i++)sd(b[i]);sc(0xd2);assert(gd()==1);
 pre(0x31,0);assert(gd()==1);render(0);uint8_t n[4],v[4];reply(0x63,n,4);reply(0x64,v,4);
 for(unsigned c=0;c<4;c++){assert((n[c]&127)==36+c*4);assert((v[c]&127)==8+c*8);}
 snapshot();reply(0x63,n,4);for(unsigned c=0;c<4;c++)assert(n[c]&128);
 sc(0x60);assert(!gd());sc(0x61);assert(!gd());sc(0x62);assert(!gd());
 pre(0x35,16);assert(gd()==64);pre(0x35,64);assert(gd()==16);
 pre(0x65,1);render(0);sc(0x60);assert(gd()==1);
 pre(0x66,3);frames(960);sc(0x67);assert(gd()==3);pre(0x66,150);frames(960);sc(0x68);assert(gd()==150);
 pre(0x6a,1);assert(!gd());pre(0x66,0);render(1);snapshot();assert(r[24]==1);
 pre(0x6a,0);assert(gd()==1);pre(0x66,0);render(1);snapshot();assert(r[24]==2);sc(0x33);render(1);
 sc(0xf5);snapshot();unsigned tick=r[39],row=r[38];frames(48000);snapshot();assert(r[39]==tick&&r[38]==row);
 sc(0x69);render(1);snapshot();assert(r[39]==(tick+1)%3);sc(0xf6);snapshot();tick=r[39];sc(0x69);render(1);snapshot();assert(r[39]==(tick+1)%3);
 /* Isolate natural MOD3: historical GS1 must mute that lane while its
  * hidden MOD note/CHANS record continues. GS1 is not MOD1. */
 memset(b+1084,0,2048);event(b,0,3,428,0,0);
 sc(0x30);assert(gd()==1);for(unsigned i=0;i<sizeof(b);i++)sd(b[i]);sc(0xd2);assert(gd()==1);pre(0x31,0);render(128);assert(audio[0]&&!audio[1]);
 sc(0x38);assert(gd()==1);for(unsigned i=0;i<8;i++)sd(128);sc(0xd2);assert(gd()==1);
 post(0x48,0,0,0);post(0x49,8,0,0);pre(0x81,0);render(128);for(unsigned i=0;i<256;i++)assert(!audio[i]);
 reply(0x63,n,4);assert((n[3]&127)==48&&(n[1]&127)==127);
 pre(0x3a,0x40);render(128);assert(audio[0]&&!audio[1]);
 pre(0x6b,0);sd(0);pre(0x6b,1);sd(0x40);sc(0x6b);sc(0xd0);pre(0x6b,0xff);sd(0xff);
 render(128);for(unsigned i=0;i<128;i++){assert(audio[2*i]==2048);assert(!audio[2*i+1]);}
 /* Independent FX audio through MOD pause, resume, stop and finite EOF. */
 pre(0x35,0);unsigned fh=fx_asset(1);(void)fh;post(0x48,0,0,0);post(0x49,8,0,0);
 pre(0x40,60);pre(0x41,64);pre(0x42,0);pre(0x82,0);
 long double phase=wave_check(60,64,1,0,128);
 sc(0x32);phase=wave_check(60,64,1,phase,128);
 sc(0x33);phase=wave_check(60,64,1,phase,128);
 stop();phase=wave_check(60,64,1,phase,128);
 assert(!call(UG_OP_LEGACY_INFO,NULL,0));unsigned mh=get16(r);assert(mh);
 unsigned pid=play(mh,0);render(0);uint8_t seek[5];put16(seek,pid);put16(seek+2,1);seek[4]=63;
 assert(!call(UG_OP_SEEK_MOD,seek,5));render(0);
 phase=wave_check(60,64,1,phase,6*960+128);snapshot();assert(r[24]==3);
 wave_check(60,64,1,phase,128);pre(0x3a,0xff);
 puts("T04 independent FX audio continues through MOD PAUSE/RESUME/STOP/EOF PASS");
 sc(0xf3);ug_minimal_dispatch();sc(0xf4);ug_minimal_dispatch();assert(status()==0x7e);
 puts("G07/G08/T04 natural CHANS, dirty independence, 65/66/6A/6B, warm/cold, BUSY ON/OFF manual tick PASS");
}
static void load_whitelist(void){
 unsigned ready_limit=100000;while(ug_storage_busy()){assert(ready_limit--);ug_minimal_dispatch();}
 unsigned raw=pcm(),module=mod(0,0,0);const uint8_t data4[]={128,192,64,128};
 unsigned configured=upload(1,data4,4),blob=upload(0,data4,4);
 sc(0x38);assert(gd()==1);sd(128);sd(192);
 const uint8_t diagnostics[]={UG_OP_CAPS,UG_OP_MEM_INFO,UG_OP_STATS,UG_OP_CLEAR_STATS,UG_OP_SNAPSHOT,UG_OP_LEGACY_INFO};
 for(unsigned i=0;i<sizeof(diagnostics);i++)assert(!call(diagnostics[i],NULL,0));
 /* INFO is served by the production front-end, not the storage API. */
 ug_minimal_write_decoded(3,UG_OP_INFO,time_us_32());ug_minimal_write_decoded(3,0,time_us_32());
 unsigned info_limit=10000;while(!(ug_minimal_read_status()&4)){assert(info_limit--);ug_minimal_dispatch();}
 assert(!ug_minimal_read_response());assert(ug_minimal_read_response()==40);for(unsigned i=0;i<40;i++)(void)ug_minimal_read_response();
 assert(!call(UG_OP_LEGACY_INFO,NULL,0));unsigned pending=get16(r+4);assert(ug_get32(r+6)==2);
 uint8_t q[26]={0};put16(q,pending);assert(!call(UG_OP_OBJECT_INFO,q,2));
 memset(q,0,sizeof(q));assert(!call(UG_OP_OBJECT_ENUM,q,2));
 ug_minimal_write_decoded(2,0xa2,time_us_32());ug_minimal_dispatch();
 q[0]=0;ug_put32(q+1,16);assert(call(UG_OP_ALLOC,q,5)==UG_ERR_NO_MEMORY); /* allowed, extent reserved by LOAD */
 { uint8_t w[13]={0};put16(w,blob);put16(w+6,4);assert(!call(UG_OP_WRITE_BEGIN,w,9));uint32_t t=ug_get32(r);ug_storage_grant_ack(time_us_32());
  for(unsigned i=0;i<4;i++)assert(!ug_storage_data_write(data4[i],time_us_32()));ug_put32(w,t);assert(!call(UG_OP_WRITE_END,w,4)); }
 memset(q,0,sizeof(q));put16(q,configured);ug_put32(q+2,48000);q[6]=1;q[7]=8;ug_put32(q+14,4);
 assert(!call(UG_OP_PCM_CONFIG,q,26));seal(configured);seal(blob);
 put16(q,configured);assert(!call(UG_OP_FREE,q,2));
 memset(q,0,sizeof(q));put16(q,pending);assert(call(UG_OP_FREE,q,2)==UG_ERR_PINNED);
 assert(call(UG_OP_SEAL,q,7)==UG_ERR_STATE);assert(call(UG_OP_PCM_CONFIG,q,26)==UG_ERR_STATE);
 put16(q+6,2);q[8]=1;assert(call(UG_OP_READ_BEGIN,q,9)==UG_ERR_BUSY);
 q[8]=0;assert(!call(UG_OP_READ_BEGIN,q,9));uint32_t token=ug_get32(r);ug_storage_grant_ack(time_us_32());
 for(unsigned i=0;i<2;i++){uint8_t v;assert(!ug_storage_data_read(&v,time_us_32()));assert(v==(i?192:128));}
 ug_put32(q,token);assert(!call(UG_OP_READ_END,q,4));
 /* The same BULK read of a different READY object is allowed. */
 memset(q,0,sizeof(q));put16(q,blob);put16(q+6,4);assert(!call(UG_OP_READ_BEGIN,q,9));token=ug_get32(r);ug_storage_grant_ack(time_us_32());
 for(unsigned i=0;i<4;i++){uint8_t v;assert(!ug_storage_data_read(&v,time_us_32()));assert(v==data4[i]);}
 ug_put32(q,token);assert(!call(UG_OP_READ_END,q,4));
 memset(q,0,sizeof(q));put16(q,raw);q[4]=64;q[5]=128;assert(!call(UG_OP_PLAY_PCM,q,6));render(0);
 /* GS pause/resume with a PCM foreground are no-ops, not PCM controls. */
 sc(0x32);assert(gd()==1);sc(0x33);assert(gd()==1);snapshot();assert(r[24]==1&&r[25]==1);
 control(0,1);render(0);control(0,2);render(0);stop();
 unsigned fxid=effect(raw,65535,2,0);render(0);capture();pages(UG_OP_FX_STATUS,1);put16(q,fxid);q[2]=1;assert(!call(UG_OP_CONTROL_FX,q,3));render(0);q[2]=2;assert(!call(UG_OP_CONTROL_FX,q,3));render(0);
 put16(q,fxid);assert(!call(UG_OP_STOP_FX,q,2));render(0);
 unsigned id=play(module,1);render(0);assert(!call(UG_OP_SET_MIX,(uint8_t[]){64,64,64,64},4));render(0);
 assert(!call(UG_OP_SET_TEMPO,(uint8_t[]){3,150},2));render(0);assert(!call(UG_OP_SET_PAN,(uint8_t[]){0,0,128},3));render(0);
 put16(q,id);put16(q+2,0);q[4]=1;assert(!call(UG_OP_SEEK_MOD,q,5));render(0);stop();
 /* S9 queue capability is not published yet; the GS LOAD whitelist must
  * not silently implement unsupported queue opcodes as successful no-ops. */
 for(unsigned op=UG_OP_QUEUE_CLEAR;op<=UG_OP_QUEUE_INFO;op++)assert(call((uint8_t)op,NULL,0)==UG_ERR_BAD_OPCODE);
 assert(!call(UG_OP_LEGACY_INFO,NULL,0));assert(get16(r+4)==pending&&ug_get32(r+6)==2);
 sc(0xd2);assert(gd()==1);
 memset(q,0,sizeof(q));put16(q,raw);q[4]=64;q[5]=128;assert(!call(UG_OP_PLAY_PCM,q,6));render(0);
 sc(0x32);assert(!gd());sc(0x33);assert(!gd());snapshot();assert(r[24]==1&&r[25]==1);stop();sc(0x37);
 puts("G09 every implemented EXT whitelist row at LOAD: diagnostics/ALLOC/FREE/PCM_CONFIG/SEAL/play/control/seek/mix/pan/FX/pending and READY BULK read PASS; S9 queue denied BAD_OPCODE");
}
int main(void){init();sc(0);assert(status()==0x7e);sc(8);sc(0xd0);sc(0xd1);pauses_and_abort();fx_oracle();commands();mod_commands();load_whitelist();
 for(unsigned c=0;c<256;c++)if(seen[c])printf("COMMAND_%02X EXECUTED_ASSERTIONS_PASS\n",c);
 return 0;}
