/* SPDX-License-Identifier: GPL-2.0-or-later
 * Execute the pinned backend and adapter, replacing only SDK/peripherals.
 * The DMA stream model deliberately separates DMA completion, FIFO/last-bit
 * completion and CS. It does not claim physical timing or signal integrity.
 */
#include "sdk_mock.h"
#include "ultrags/ug_psram.h"
#include "ultrags/ug_hwmap.h"
#include <stdio.h>
#include <string.h>
mock_pio mock_pios[2];
static bool claimed[12], dma_busy[12];
static uint32_t used[2], now, pc;
static unsigned checks, tail, cs_delay, dma_remaining[12], reset_commands, aborts;
static int stuck_channel=-1;
static bool stuck_cs, frozen_clock;
static unsigned divider256, installed_length, installed_offset, wrap_top;
static bool installed_id;
static uint32_t sys_hz=370000000, reserved_programs;
static uint8_t memory[8u<<20];
static uint8_t command[33];
static unsigned command_size, write_left;
static uint32_t address;
static bool read_pending;
#define CHECK(c) do { assert(c); checks++; } while(0)
uint32_t time_us_32(void) { return frozen_clock?now:now++; }
void busy_wait_us(uint delay) { now+=delay;tail=cs_delay=0; }
void tight_loop_contents(void) { if(tail)tail--; else if(cs_delay && !stuck_cs)cs_delay--; }
bool pio_can_add_program(PIO p,const struct pio_program *g) {
    unsigned bank=p==pio1;
    for(unsigned i=0;i+g->length<=32;i++)if(!(used[bank]&(((1u<<g->length)-1)<<i)))return true;
    return false;
}
uint pio_add_program(PIO p,const struct pio_program *g) {
    unsigned bank=p==pio1;
    for(unsigned i=0;i+g->length<=32;i++) {
        uint32_t mask=((1u<<g->length)-1)<<i;
        if(!(used[bank]&mask)) { used[bank]|=mask; installed_length=g->length;installed_offset=i;installed_id=g->id;return i; }
    }
    assert(false); return 0;
}
void pio_add_program_at_offset(PIO p,const struct pio_program *g,uint off) {
    uint32_t mask=((1u<<g->length)-1)<<off;
    assert(!p->enabled[1] && !(used[p==pio1]&mask));
    used[p==pio1]|=mask;installed_length=g->length;installed_offset=off;installed_id=g->id;
}
void pio_sm_set_wrap(PIO p,uint sm,uint bottom,uint top) { assert(!p->enabled[sm] && bottom==installed_offset);wrap_top=top; }
void pio_sm_exec(PIO p,uint sm,uint instr) { assert(!p->enabled[sm] && instr==installed_offset);pc=instr; }
void pio_sm_set_clkdiv_int_frac(PIO p,uint sm,uint i,uint8_t f) { assert(!p->enabled[sm]);divider256=i*256+f; }
void backend_clock_init(float div) { divider256=(unsigned)(div*256);wrap_top=installed_offset+installed_length-1; }
void pio_remove_program(PIO p,const struct pio_program *g,uint off) {
    uint32_t mask=((1u<<g->length)-1)<<off; assert((used[p==pio1]&mask)==mask);
    used[p==pio1]&=~mask;
}
void backend_sm_init(PIO p,uint sm,uint off) { pc=off;tail=cs_delay=0;command_size=write_left=0;read_pending=false;p->enabled[sm]=true; }
void pio_sm_claim(PIO p,uint sm) { assert(!p->claimed[sm]);p->claimed[sm]=true; }
void pio_sm_unclaim(PIO p,uint sm) { assert(p->claimed[sm]);p->claimed[sm]=false; }
bool pio_sm_is_claimed(PIO p,uint sm) { return p->claimed[sm]; }
int pio_claim_unused_sm(PIO p,bool required) { for(unsigned i=0;i<4;i++)if(!p->claimed[i]){pio_sm_claim(p,i);return i;}assert(!required);return -1; }
void pio_sm_set_enabled(PIO p,uint sm,bool en) { p->enabled[sm]=en; }
bool pio_sm_is_tx_fifo_empty(PIO p,uint sm) { (void)p;(void)sm;return tail<=2; }
bool pio_sm_is_tx_fifo_full(PIO p,uint sm) { (void)p;(void)sm;return false; }
bool pio_sm_is_rx_fifo_empty(PIO p,uint sm) { (void)p;(void)sm;return true; }
uint pio_sm_get_pc(PIO p,uint sm) { (void)p;(void)sm;return pc+(tail?1:0); }
uint pio_get_dreq(PIO p,uint sm,bool tx) { (void)p;(void)sm;return tx?1:0; }
void gpio_set_drive_strength(uint pin,uint strength) { (void)pin;assert(strength==4); }
bool gpio_get(uint pin) { assert(pin==1);return !tail && !cs_delay && !stuck_cs; }
void dma_channel_claim(uint ch) { assert(ch<12 && !claimed[ch]);claimed[ch]=true; }
void dma_channel_unclaim(uint ch) { assert(claimed[ch] && !dma_busy[ch]);claimed[ch]=false; }
bool dma_channel_is_claimed(uint ch) { return claimed[ch]; }
int dma_claim_unused_channel(bool required) { for(unsigned i=0;i<12;i++)if(!claimed[i]){dma_channel_claim(i);return i;}assert(!required);return -1; }
bool dma_channel_is_busy(uint ch) {
    if(!dma_busy[ch])return false;
    if((int)ch==stuck_channel)return true;
    if(dma_remaining[ch] && !--dma_remaining[ch])dma_busy[ch]=false;
    return dma_busy[ch];
}
void dma_channel_abort(uint ch) { dma_busy[ch]=false;aborts++; }
/* A missing force-include must fail rather than silently exercise a fake wait. */
void dma_channel_wait_for_finish_blocking(uint ch);
dma_channel_config dma_channel_get_default_config(uint ch) { dma_channel_config c={ch};return c; }
void channel_config_set_transfer_data_size(dma_channel_config *c,uint size) { (void)c;assert(size==8); }
void channel_config_set_read_increment(dma_channel_config *c,bool b) { (void)c;(void)b; }
void channel_config_set_write_increment(dma_channel_config *c,bool b) { (void)c;(void)b; }
void channel_config_set_dreq(dma_channel_config *c,uint d) { (void)c;(void)d; }
void dma_channel_set_write_addr(uint ch,const void *dst,bool start) { (void)ch;(void)dst;assert(!start); }
void dma_channel_set_read_addr(uint ch,const void *src,bool start) { (void)ch;(void)src;assert(!start); }
void dma_channel_set_config(uint ch,const dma_channel_config *c,bool start) { (void)ch;(void)c;assert(!start); }
static void dma_start(uint ch) { assert(claimed[ch]);dma_busy[ch]=true;dma_remaining[ch]=3; }
static void spi_end(void) { tail=4;cs_delay=4; }
void dma_channel_transfer_from_buffer_now(uint ch,const void *src,uint n) {
    dma_start(ch);
    if((int)ch==stuck_channel)return;
    const uint8_t *q=src;
    if(write_left) {
        assert(n==write_left && address+n<=sizeof(memory));
        memcpy(memory+address,q,n);write_left=0;spi_end();return;
    }
    assert(!tail && !cs_delay && n>=3 && n<=sizeof(command));
    memcpy(command,q,n);command_size=n;
    if(q[2]==0x66 || q[2]==0x99) { assert(n==3 && q[0]==8 && !q[1]);reset_commands++;spi_end();return; }
    assert(n>=6);address=((uint32_t)q[3]<<16)|((uint32_t)q[4]<<8)|q[5];
    if(q[2]==2) {
        unsigned bytes=q[0]/8-4;assert(!q[1] && bytes<=27 && bytes<=1024-(address&1023));
        if(n==6)write_left=bytes;
        else { assert(n==6+bytes && address+bytes<=sizeof(memory));memcpy(memory+address,q+6,bytes);spi_end(); }
    } else {
        assert((q[2]==0x0b && q[0]==40 && n==7 && !q[6]) ||
               (q[2]==0x9f && q[0]==32 && n==6));
        read_pending=true;
    }
}
void dma_channel_transfer_to_buffer_now(uint ch,void *dst,uint n) {
    dma_start(ch);
    if((int)ch==stuck_channel || !n)return;
    if(!read_pending) { assert(stuck_channel>=0);dma_remaining[ch]=0;return; }
    assert(command_size>=6 && command[1]==n*8);
    if(command[2]==0x9f) {
        /* Old production code violates both checks: 100 MHz, and the
         * fallback can use the extra-clock high-speed sampling phase. */
        assert((uint64_t)sys_hz*128<=25000000ull*divider256 &&
               installed_length==9 && wrap_top==installed_offset+8 && installed_id);
        const uint8_t id[3]={13,93,64};assert(n==3);memcpy(dst,id,3);
    }
    else { assert(n<=31 && n<=1024-(address&1023) && address+n<=sizeof(memory));memcpy(dst,memory+address,n); }
    read_pending=false;spi_end();
}
/* Reset commands in the real init use fixed busy_wait delays; emulate PIO
 * progress there too, independently from the adapter's completion polling. */
uint32_t clock_get_hz(uint clk) { (void)clk;return sys_hz; }
static void release(ug_psram_t *ps) {
    ug_psram_uninit(ps);CHECK(!ps->up && !pio_sm_is_claimed(pio1,1));
    CHECK(!claimed[2] && !claimed[3] && !claimed[4]);CHECK(used[1]==reserved_programs && !ug_hw_pio_used(pio1));
}
int main(int argc,char **argv) {
    ug_psram_t ps={0};dma_channel_claim(0);dma_channel_claim(1);
    for(unsigned profile=0;profile<4;profile++)for(unsigned fudge=0;fudge<2;fudge++) {
        sys_hz=profile&1?264000000:370000000;
        reserved_programs=profile&2?0xfe00001fu:0;
        used[1]=reserved_programs;
        float data_div=(float)sys_hz/(profile&2?100000000.0f:200000000.0f);
        unsigned resets_before=reset_commands;
        pio_sm_claim(pio1,1);CHECK(!ug_psram_init(&ps,pio1,1,data_div,8u<<20,fudge));
        CHECK(reset_commands==resets_before+2);CHECK(!ug_hw_psram_dma_check(ps.dma_tx,ps.dma_rx,ps.dma_async));
        uint8_t id[8],src[256],dst[256];for(unsigned i=0;i<256;i++)src[i]=(uint8_t)(i^0xa5);
        CHECK(!ug_psram_read_id(&ps,id) && id[0]==13 && id[1]==93 && id[2]==64);
        CHECK(divider256==ps.divider256 && installed_length==(fudge?10:9) && !installed_id);
        CHECK(wrap_top==installed_offset+installed_length-1 && pio1->enabled[1]);
        CHECK((used[1]&reserved_programs)==reserved_programs);
        CHECK(reset_commands==resets_before+2); /* ID never resets data. */
        CHECK(ug_psram_read_id(&ps,NULL));
        const unsigned sizes[]={1,7,27,28,31,32,255,256};
        for(unsigned k=0;k<sizeof(sizes)/sizeof(sizes[0]);k++) {
            unsigned n=sizes[k];
            const uint32_t offsets[]={0,1023,(8u<<20)-n};
            for(unsigned j=0;j<3;j++)for(unsigned async=0;async<2;async++) {
                CHECK(!(async?ug_psram_write_async(&ps,offsets[j],src,n):ug_psram_write(&ps,offsets[j],src,n)));
                CHECK(!tail && !cs_delay);CHECK(!ug_psram_read(&ps,offsets[j],dst,n));CHECK(!memcmp(src,dst,n));
            }
        }
        unsigned count=reset_commands;CHECK(ug_psram_read(&ps,8u<<20,dst,1));CHECK(ug_psram_write(&ps,UINT32_MAX,src,2));CHECK(reset_commands==count);
        /* Final SPI bits and CS outlive DMA; independently stuck CS fails. */
        stuck_cs=true;uint32_t start=now;CHECK(ug_psram_read_id(&ps,id));CHECK(now-start<3000 && ug_psram_dma_fault && !pio1->enabled[1]);
        CHECK(divider256==ps.divider256 && installed_length==(fudge?10:9) && !installed_id);
        stuck_cs=false;CHECK(!ug_psram_recover(&ps) && ps.fudge==(bool)fudge);
        for(int channel=2;channel<=4;channel++) {
            stuck_channel=channel;start=now;
            int error=channel==4?ug_psram_write_async(&ps,0,src,1):ug_psram_read(&ps,0,dst,1);
            CHECK(error && ug_psram_dma_fault && now-start<10000);
            CHECK(!dma_busy[2] && !dma_busy[3] && !dma_busy[4]);
            stuck_channel=-1;CHECK(!ug_psram_recover(&ps) && ps.fudge==(bool)fudge);
        }
        frozen_clock=true;stuck_channel=3;CHECK(ug_psram_read(&ps,0,dst,1));
        frozen_clock=false;stuck_channel=-1;CHECK(!ug_psram_recover(&ps));
        release(&ps);
    }
    used[1]=reserved_programs=0;sys_hz=370000000;
    /* The real driver's reset commands also use the bounded DMA wrapper. */
    dma_channel_unclaim(5); /* Both startup inits can fail before CRC reserve. */
    pio_sm_claim(pio1,1);stuck_channel=2;uint32_t start=now;
    CHECK(ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    CHECK(ug_psram_dma_fault && now-start<10000);
    stuck_channel=-1;CHECK(!ug_psram_recover(&ps));CHECK(claimed[5]);release(&ps);
    pio_sm_claim(pio1,1);CHECK(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));release(&ps);
    CHECK(aborts>0);
    printf("S3 pinned backend HOST_PASS: %u checks (real init/read/write/async/DMA wait/teardown)\n",checks);
    if(argc>1) { FILE *f=fopen(argv[1],"w");assert(f);fprintf(f,"{\"checks\":%u,\"pinned_backend\":true,\"bounded_waits\":true}\n",checks);fclose(f); }
}
