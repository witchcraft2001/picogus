/* SPDX-License-Identifier: GPL-2.0-or-later */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <limits.h>
#include <pthread.h>
#include <sched.h>
#include "../../../sw/ultrags/ug_opl.c"
#include "../../../sw/opl/emu8950.c"
#include "../../../sw/ultrags/ug_render.h"
extern const uint32_t tll_table[128][64][4];
static void reset(void) {
    memset(&queue,0,sizeof(queue)); memset(timers,0,sizeof(timers));
    publish_status();
    address=0; volume=100; sounding=primed=false; first=second=0; residue=0;
    ug_opl_init();
}
static void write_reg(unsigned reg,unsigned value) {
    assert(ug_opl_write(0x388,reg,0)); assert(ug_opl_write(0x389,value,0));
}
static void note(unsigned ch) {
    static const unsigned offsets[]={0,1,2,8,9,10,16,17,18};
    unsigned op=offsets[ch];
    write_reg(0x20+op,0x21);write_reg(0x23+op,0x21);
    write_reg(0x40+op,24);write_reg(0x43+op,12);
    write_reg(0x60+op,0xf3);write_reg(0x63+op,0xf3);
    write_reg(0x80+op,0x35);write_reg(0x83+op,0x35);
    write_reg(0xa0+ch,0x80+ch*7);write_reg(0xb0+ch,0x31);
}
static void test_queue(void) {
    ug_opl_queue q={.producer=UINT32_MAX-100,.consumer=UINT32_MAX-100};
    for(unsigned round=0;round<100;round++) {
        for(unsigned i=0;i<256;i++) assert(ug_opl_enqueue(&q,i,i^0x5a));
        assert(!ug_opl_enqueue(&q,99,99));assert(ug_opl_snapshot(&q)==256);
        unsigned n=ug_opl_snapshot(&q);
        for(unsigned i=0;i<n;i++) { ug_opl_command c;assert(ug_opl_pop(&q,&c));assert(c.reg==i && c.value==(i^0x5a)); }
        assert(ug_opl_snapshot(&q)==0);
    }
    reset();write_reg(0x40,1); assert(ug_opl_write(0x389,2,0));
    ug_opl_command c;assert(ug_opl_pop(&queue,&c)&&c.reg==0x40&&c.value==1);
    assert(ug_opl_pop(&queue,&c)&&c.reg==0x40&&c.value==2);
    /* A snapshot is a fixed prefix even while the producer appends. */
    for(unsigned i=0;i<128;i++)assert(ug_opl_enqueue(&q,i,1));
    unsigned snapshot=ug_opl_snapshot(&q);
    for(unsigned i=0;i<128;i++)assert(ug_opl_enqueue(&q,i,2));
    for(unsigned i=0;i<snapshot;i++){assert(ug_opl_pop(&q,&c));assert(c.value==1);}
    assert(ug_opl_snapshot(&q)==128);
}
static ug_opl_queue threaded;
static void *produce(void *arg) {
    (void)arg;
    for(unsigned i=0;i<100000;i++)
        while(!ug_opl_enqueue(&threaded,i,i>>8))sched_yield();
    return NULL;
}
static void test_concurrent(void) {
    threaded.producer=threaded.consumer=UINT32_MAX-100;
    pthread_t thread;assert(!pthread_create(&thread,NULL,produce,NULL));
    for(unsigned i=0;i<100000;i++) {
        ug_opl_command c;while(!ug_opl_pop(&threaded,&c))sched_yield();
        assert(c.reg==(uint8_t)i && c.value==(uint8_t)(i>>8));
    }
    assert(!pthread_join(thread,NULL));assert(!ug_opl_snapshot(&threaded));
}
static void test_resampling(void) {
    int32_t reference[1024];
    reset();note(0);
    for(unsigned i=0;i<1024;i+=128)memcpy(reference+i,ug_opl_render(128),512);
    reset();note(0);
    for(unsigned i=0;i<1024;) {
        unsigned n=(i*17+31)%128+1;if(n>1024-i)n=1024-i;
        assert(!memcmp(reference+i,ug_opl_render(n),n*4));i+=n;
    }
    for(unsigned percent=0;percent<=100;percent+=25) {
        reset();note(0);ug_opl_volume(percent);
        unsigned v=percent*256/100,gain=((v*v>>8)*v>>8)*128;
        for(unsigned block=0;block<8;block++) {
            const int32_t *out=ug_opl_render(128);
            for(unsigned i=0;i<128;i++)assert(out[i]==(int64_t)reference[block*128+i]*gain/32768);
        }
    }
}
static void test_timers(void) {
    reset();assert(ug_opl_status_value==6 && !ug_opl_timer_poll_needed);
    write_reg(2,255);write_reg(4,1);
    /* The published deadline is the alarm instant: 80us * (256-255). */
    assert(ug_opl_timer_poll_needed && ug_opl_status_value==6 && ug_opl_timer_deadline==80);
    ug_opl_poll(79);assert(ug_opl_status_value==6 && ug_opl_timer_deadline==80);
    ug_opl_poll(80);assert(ug_opl_status_value==0xc6 && !ug_opl_timer_poll_needed);
    assert(ug_opl_write(0x388,4,80));assert(ug_opl_write(0x389,0x80,80));
    assert(ug_opl_status_value==6 && ug_opl_timer_poll_needed && ug_opl_timer_deadline==160);
    ug_opl_poll(159);assert(ug_opl_status_value==6);
    ug_opl_poll(160);assert(ug_opl_status_value==0xc6);
    assert(ug_opl_write(0x389,0x60,160));
    assert(ug_opl_status_value==6 && !ug_opl_timer_poll_needed);
    /* Both timers pending: the earliest wins, also across the 32-bit wrap. */
    reset();assert(ug_opl_write(0x388,2,UINT32_MAX-10));assert(ug_opl_write(0x389,254,UINT32_MAX-10)); /* 160us */
    assert(ug_opl_write(0x388,3,UINT32_MAX-10));assert(ug_opl_write(0x389,255,UINT32_MAX-10)); /* 320us */
    assert(ug_opl_write(0x388,4,UINT32_MAX-10));assert(ug_opl_write(0x389,3,UINT32_MAX-10));
    assert(ug_opl_timer_poll_needed && ug_opl_timer_deadline==149);
    ug_opl_poll(149);assert(ug_opl_status_value==0xc6 && ug_opl_timer_poll_needed && ug_opl_timer_deadline==309);
    ug_opl_poll(309);assert(ug_opl_status_value==0xe6 && !ug_opl_timer_poll_needed);
    /* A masked timer never schedules an alarm. */
    reset();write_reg(2,255);write_reg(4,0x41);
    assert(!ug_opl_timer_poll_needed && ug_opl_status_value==6);
    reset();write_reg(2,255);write_reg(4,1);
    for(unsigned i=0;i<256;i++)assert(ug_opl_enqueue(&queue,0x40,i));
    assert(ug_opl_write(0x388,0x40,40));
    assert(!ug_opl_write(0x389,0x55,80));
    assert(ug_opl_status_value==0xc6 && ug_opl_snapshot(&queue)==256);
    reset();write_reg(2,255);write_reg(4,1);
    assert(ug_opl_status(79)==6);assert(ug_opl_status(80)==0xc6);
    assert(ug_opl_write(0x388,4,80));assert(ug_opl_write(0x389,0x80,80));
    assert(ug_opl_status(80)==6);assert(ug_opl_status(160)==0xc6); /* still running */
    reset();write_reg(3,255);write_reg(4,2);
    assert(ug_opl_status(319)==6);assert(ug_opl_status(320)==0xa6);
    write_reg(4,0x60);assert(ug_opl_status(1000)==6);
    reset();assert(ug_opl_write(0x388,2,UINT32_MAX-40));assert(ug_opl_write(0x389,255,UINT32_MAX-40));
    assert(ug_opl_write(0x388,4,UINT32_MAX-40));assert(ug_opl_write(0x389,1,UINT32_MAX-40));
    assert(ug_opl_status(38)==6);assert(ug_opl_status(39)==0xc6);
    for(unsigned i=0;i<256;i++)assert(ug_opl_enqueue(&queue,0x40,i));
    write_reg(4,0x60);assert(ug_opl_status(100)==6); /* independent of full synth queue */
}
static ug_mixer mixer;
static void test_mix(void) {
    reset();ug_mixer_init(&mixer,(ug_mem_if){0});int16_t pcm[256];int32_t fm[128];
    for(unsigned i=0;i<128;i++)fm[i]=40000;
    mixer.fm=fm;ug_mixer_render(&mixer,pcm,128);
    for(unsigned i=0;i<256;i++)assert(pcm[i]==32767);
    assert(mixer.stats.clips==256 && mixer.peak_current[0]==32768);
    mixer.fm=fm;mixer.vol_q15=16384;ug_mixer_render(&mixer,pcm,128);
    for(unsigned i=0;i<256;i++)assert(pcm[i]==20000);
    assert(mixer.stats.clips==256);
    memset(fm,0,sizeof(fm));mixer.fm=fm;ug_mixer_render(&mixer,pcm,128);
    for(unsigned i=0;i<256;i++)assert(pcm[i]==0);
}
int main(int argc,char **argv) {
    test_queue();test_concurrent();test_timers();test_mix();test_resampling();reset();
    for(unsigned i=0;i<128;i++)for(unsigned tl=0;tl<64;tl++)for(unsigned kl=0;kl<4;kl++)
        assert(tll_base[i][kl]+(tl<<2)==tll_table[i][tl][kl]);
    FILE *out=argc>1?fopen(argv[1],"wb"):NULL;
    for(unsigned profile=0;profile<19;profile++) {
        reset();for(unsigned ch=0;ch<(profile>=9?9:1);ch++)note(profile>=9?ch:profile);
        if(profile==9)write_reg(0xbd,0x3f);
        if(profile>=10 && profile<18) {
            write_reg(1,0x20); /* OPL2 waveform-select enable */
            if(profile>=14)write_reg(0xbd,0xc0); /* deep AM + vibrato */
        }
        if(profile>=10 && profile<18) for(unsigned ch=0;ch<9;ch++) {
            unsigned op=(unsigned[]){0,1,2,8,9,10,16,17,18}[ch];
            write_reg(0x20+op,0xe1);write_reg(0x23+op,0xe1);
            write_reg(0xe0+op,(profile-10)%4);write_reg(0xe3+op,(profile-9)%4);
            write_reg(0xc0+ch,(profile&1)?0x0f:0x0e);
        }
        assert(ug_opl_busy());long long energy=0;
        for(unsigned frame=0;frame<100;frame++) {
            const int32_t *samples=ug_opl_render(128);
            if(profile>=10 && profile<18)assert(synth.slot[0].patch->WS==(profile-10)%4 && synth.slot[1].patch->WS==(profile-9)%4);
            for(unsigned i=0;i<128;i++)energy+=llabs(samples[i]);
            if(out)assert(fwrite(samples,4,128,out)==128);
        }
        assert(energy>10000);
        for(unsigned ch=0;ch<9;ch++)write_reg(0xb0+ch,0);
        write_reg(0xbd,0x20);
        assert(ug_opl_busy());unsigned blocks=0;
        while(ug_opl_busy() && blocks++<4000)ug_opl_render(128);
        assert(!ug_opl_busy());
    }
    if(out)fclose(out);
    /* A short deterministic release vector also executes the ARM envelope
     * exit path all the way to idle, rather than checking key-off alone. */
    reset();for(unsigned ch=0;ch<9;ch++)note(ch);
    for(unsigned block=0;block<8;block++)ug_opl_render(128);
    for(unsigned op=0;op<32;op++)write_reg(0x80+op,0xff);
    for(unsigned ch=0;ch<9;ch++)write_reg(0xb0+ch,0);
    FILE *tail=argc>2?fopen(argv[2],"wb"):NULL;
    for(unsigned block=0;block<8;block++) {
        const int32_t *v=ug_opl_render(128);
        if(tail)assert(fwrite(v,4,128,tail)==128);
    }
    if(tail)fclose(tail);
    assert(!ug_opl_busy());
    reset();note(0);ug_opl_volume(0);for(unsigned j=0;j<3;j++) { const int32_t *v=ug_opl_render(128);for(unsigned i=0;i<128;i++)assert(!v[i]); }
    assert(ug_opl_busy());
    puts("PASS TLL32768 queue/full/wrap/order/address timers/wrap/full-queue nine channels/percussion/release volume final mix/clipping");
}
