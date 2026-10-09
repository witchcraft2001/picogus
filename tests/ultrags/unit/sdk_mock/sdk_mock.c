/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "sdk_mock.h"
#include "psram_spi.h"
#include <string.h>
mock_pio mock_pios[2];
mock_dma_hw mock_dma;
const uint32_t *mock_dma_src[12];
unsigned mock_starts[12], mock_counts[12], mock_tail_steps, mock_waits;
unsigned mock_read_calls, mock_write_calls, mock_async_calls, mock_max_read, mock_max_write;
bool mock_irq_enabled, mock_irq_disabled;
uint8_t mock_memory[8u<<20];
pthread_mutex_t *mock_last_mutex;
uint32_t mock_capacity=8u<<20, mock_alias_mask=0xffffffff, mock_now;
int mock_stuck_bit=-1;
bool mock_dma_stuck, mock_cs_stuck;
uint8_t mock_id[8]={0x0d,0x5d,0x40};
void (*mock_psram_hook)(void);
static void psram_hook(void) {
    void (*hook)(void)=mock_psram_hook;
    mock_psram_hook=NULL;
    if(hook) hook();
}
void (*mock_time_hook)(void);
uint32_t time_us_32(void) {
    void (*hook)(void)=mock_time_hook;
    mock_time_hook=NULL;
    if(hook) hook();
    return mock_now++;
}
static bool dma_claims[12];
static void (*irq_handler)(void);
static uint spi_offset;
void mock_reset(void) {
    mock_psram_hook=NULL;
    mock_time_hook=NULL;
    memset(mock_pios,0,sizeof(mock_pios)); memset(dma_claims,0,sizeof(dma_claims));
    memset(mock_starts,0,sizeof(mock_starts)); memset(mock_counts,0,sizeof(mock_counts));
    mock_tail_steps=mock_waits=0;
    mock_read_calls=mock_write_calls=mock_async_calls=mock_max_read=mock_max_write=0;
    mock_irq_enabled=mock_irq_disabled=false;
}
uint32_t save_and_disable_interrupts(void) { uint32_t old=mock_irq_disabled; mock_irq_disabled=true; return old; }
void restore_interrupts(uint32_t old) { mock_irq_disabled=old; }
void tight_loop_contents(void) { mock_waits++; if(mock_tail_steps && !mock_cs_stuck) mock_tail_steps--; }
bool pio_can_add_program(PIO p,const struct pio_program *g) { return p->used+g->length<=32; }
uint pio_add_program(PIO p,const struct pio_program *g) { assert(pio_can_add_program(p,g)); uint off=p->used; p->used+=g->length; return off; }
void pio_sm_claim(PIO p,uint sm) { assert(!p->claimed[sm]); p->claimed[sm]=true; }
bool pio_sm_is_claimed(PIO p,uint sm) { return p->claimed[sm]; }
void pio_sm_set_enabled(PIO p,uint sm,bool en) { p->enabled[sm]=en; }
void pio_sm_set_clkdiv_int_frac(PIO p,uint sm,uint i,uint8_t f) { (void)p;(void)sm; assert(i==120 && f==113); }
bool pio_sm_is_tx_fifo_empty(PIO p,uint sm) { (void)p;(void)sm;return true; }
uint pio_sm_get_pc(PIO p,uint sm) { (void)p;(void)sm;return spi_offset+(mock_tail_steps?1:0); }
uint pio_get_dreq(PIO p,uint sm,bool tx) { (void)p;(void)tx;return sm; }
void dma_channel_claim(uint ch) { assert(ch<12 && !dma_claims[ch]); dma_claims[ch]=true; }
bool dma_channel_is_claimed(uint ch) { return dma_claims[ch]; }
bool dma_channel_is_busy(uint ch) { (void)ch;return mock_dma_stuck; }
void dma_channel_abort(uint ch) { (void)ch; mock_tail_steps=0; }
dma_channel_config dma_channel_get_default_config(uint ch) { dma_channel_config c={ch};return c; }
void channel_config_set_dreq(dma_channel_config *c,uint d) { (void)c;(void)d; }
void channel_config_set_transfer_data_size(dma_channel_config *c,uint s) { (void)c;assert(s==32); }
void channel_config_set_read_increment(dma_channel_config *c,bool b) { (void)c;assert(b); }
void channel_config_set_write_increment(dma_channel_config *c,bool b) { (void)c;assert(!b); }
void channel_config_set_chain_to(dma_channel_config *c,uint ch) { c->chain=ch; }
void dma_channel_configure(uint ch,dma_channel_config *c,uint32_t *dst,const uint32_t *src,uint n,bool start) { (void)c;(void)dst;assert(!start);mock_dma_src[ch]=src;mock_counts[ch]=n; }
void dma_channel_set_read_addr(uint ch,const void *src,bool start) { assert(!start);mock_dma_src[ch]=src; }
void dma_channel_set_trans_count(uint ch,uint n,bool start) { assert(!start);mock_counts[ch]=n; }
void dma_channel_start(uint ch) { mock_starts[ch]++; }
void dma_irqn_set_channel_enabled(uint irq,uint ch,bool en) { assert(irq==0 && ch<2 && en); }
void irq_set_exclusive_handler(uint irq,void (*f)(void)) { assert(irq==0);irq_handler=f; }
void irq_set_priority(uint irq,uint p) { assert(irq==0 && p==0x40); }
void irq_set_enabled(uint irq,bool en) { assert(irq==0);mock_irq_enabled=en; }
void gpio_set_function(uint pin,uint fn) { (void)pin;(void)fn; }
bool gpio_get(uint pin) { (void)pin;return mock_tail_steps==0; }
uint32_t clock_get_hz(uint clk) { (void)clk;return 370000000; }
void audio_i2s_program_init(PIO p,uint sm,uint off,uint data,uint clock) { (void)off;(void)data;(void)clock;p->enabled[sm]=false; }
void mock_complete(unsigned ch) { assert(mock_irq_enabled && !mock_irq_disabled);mock_dma.ints0=1u<<ch;irq_handler(); }
psram_spi_inst_t psram_spi_init_clkdiv(PIO p,int sm,float div,bool fudge) {
    (void)div; psram_spi_inst_t s={p,sm,pio_add_program(p,fudge?&spi_psram_fudge_program:&spi_psram_program),2,3,4};
    spi_offset=s.offset; dma_channel_claim(2);dma_channel_claim(3);dma_channel_claim(4);p->enabled[sm]=true;return s;
}
void psram_spi_uninit(psram_spi_inst_t s,bool fudge) { assert(!s.pio->enabled[s.sm] && !mock_tail_steps); s.pio->used-=fudge?10:9; s.pio->claimed[s.sm]=false;dma_claims[2]=dma_claims[3]=dma_claims[4]=false; }
void psram_read(psram_spi_inst_t *s,uint32_t off,uint8_t *dst,uint32_t n) { (void)s;psram_hook();assert(!mock_tail_steps && n<=31 && off+n<=sizeof(mock_memory));for(unsigned i=0;i<n;i++) dst[i]=mock_memory[((off+i)%mock_capacity)&mock_alias_mask];mock_tail_steps=3;mock_read_calls++;if(n>mock_max_read)mock_max_read=n; }
void psram_write(psram_spi_inst_t *s,uint32_t off,const uint8_t *src,uint32_t n) { (void)s;psram_hook();assert(!mock_tail_steps && n<=27 && off+n<=sizeof(mock_memory));for(unsigned i=0;i<n;i++) mock_memory[((off+i)%mock_capacity)&mock_alias_mask]=src[i] & (mock_stuck_bit<0?255:~(1u<<mock_stuck_bit));mock_tail_steps=3;mock_write_calls++;if(n>mock_max_write)mock_max_write=n; }
void psram_write_async_fast(psram_spi_inst_t *s,uint32_t off,uint8_t *src,uint32_t n) { psram_write(s,off,src,n);mock_async_calls++; }
void mutex_init(mutex_t *m) { assert(pthread_mutex_init(&m->mutex,NULL)==0);mock_last_mutex=&m->mutex; }
bool mutex_try_enter(mutex_t *m,uint32_t *owner) { (void)owner;return pthread_mutex_trylock(&m->mutex)==0; }
void mutex_enter_blocking(mutex_t *m) { assert(pthread_mutex_lock(&m->mutex)==0); }
void mutex_exit(mutex_t *m) { assert(pthread_mutex_unlock(&m->mutex)==0); }
void mock_hold_snapshot(void) { assert(pthread_mutex_lock(mock_last_mutex)==0); }
void mock_release_snapshot(void) { assert(pthread_mutex_unlock(mock_last_mutex)==0); }

void pio_spi_write_read_dma_blocking(psram_spi_inst_t *s,const uint8_t *q,size_t n,uint8_t *r,size_t m) {
    (void)s; assert(n==6 && q[2]==0x9f && m==8); memcpy(r,mock_id,8); mock_tail_steps=3;
}
