/* SPDX-License-Identifier: GPL-2.0-or-later
 * Actual posted diagnostic and fence: queued CONFIG, guards and counters.
 * Guard delays are mocked; electrical timing remains REAL_PENDING.
 */
#include "hardware/pio.h"
#include "ultrags/ug_posted.h"
#include "ultrags/ug_diag.h"
#include "ultrags/ug_diag_guard.h"
#include "ultrags/ug_spike.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
pio_hw mock_pio;
uint8_t BOARD_TYPE=1;
const char *firmware_string="HOST";
static uint32_t queue[9],input,port,verdict[2],clock_us;
static unsigned count,pos,nv,delays[2],delay_count,checks;
static bool failed;
#define CHECK(x) do { assert(x); checks++; } while(0)
void handle_iow(void); void handle_ior(void); void ug_diag_isa_reset(void);
void ug_diag_isa_stats(uint32_t *,uint32_t *);
unsigned pio_sm_get_rx_fifo_level(PIO p,unsigned sm) { (void)p;assert(sm==0);return count-pos; }
bool pio_sm_is_rx_fifo_empty(PIO p,unsigned sm) { return !pio_sm_get_rx_fifo_level(p,sm); }
unsigned pio_sm_get_pc(PIO p,unsigned sm) { (void)p;assert(sm==0);return 0; }
uint32_t pio_sm_get(PIO p,unsigned sm) { (void)p;return sm?port:pos<count?queue[pos++]:input; }
void pio_sm_put(PIO p,unsigned sm,uint32_t v) { (void)p;assert(sm==1 && nv<2);verdict[nv++]=v; }
uint32_t time_us_32(void) { return clock_us++; }
bool gpio_get(unsigned pin) { (void)pin;return true; }
void watchdog_reboot(unsigned a,unsigned b,unsigned c) { assert(!a&&!b&&c==1); }
bool ug_diag_guard_failed(void) { return failed; }
void ug_diag_guard_arm(unsigned pin) { assert(pin==5); }
bool ug_diag_guard_delay(uint16_t us) {
    assert(delay_count<2);delays[delay_count++]=us;
    if(us==999) failed=true;
    return !failed;
}
uint8_t ug_spike_cmd(uint8_t cmd,uint16_t arg) { (void)cmd;(void)arg;return 0; }
bool ug_spike_status(ug_diag_status *s) { memset(s,0,sizeof(*s));return true; }
static void reset(void) {
    failed=false;count=pos=nv=delay_count=0;
    ug_diag_isa_reset();ug_posted_init(0);mock_pio.fdebug=0;
}
static void queued(const uint32_t *words,unsigned n) { memcpy(queue,words,n*sizeof(*words));count=n;pos=0; }
static void read_at(unsigned p) { port=p;nv=delay_count=0;handle_ior(); }
int main(void) {
    reset();read_at(0x300);CHECK(nv==1 && verdict[0]==0 && !delay_count);
    read_at(0x1d2);CHECK(nv==1 && verdict[0]==0 && !delay_count);
    uint32_t set_assert[]={0x1d0cc,0x1d000|UGD_SEL_ASSERT_US,0x1d107,0x1d200};
    queued(set_assert,4);read_at(0x1d0);
    CHECK(nv==2 && verdict[0]==UINT32_MAX && verdict[1]==(0xff00|UGD_SEL_ASSERT_US));
    CHECK(delays[0]==7 && delays[1]==0);
    uint32_t writes,reads;ug_diag_isa_stats(&writes,&reads);CHECK(writes==4 && reads==3);
    uint32_t set_response[]={0x1d000|UGD_SEL_RESPONSE_US,0x1d109,0x1d200};
    queued(set_response,3);read_at(0x1d2);CHECK(nv==2 && delays[0]==7 && delays[1]==9);
    uint32_t fatal_assert[]={0x1d000|UGD_SEL_ASSERT_US,0x1d1e7,0x1d203};
    queued(fatal_assert,3);read_at(0x1d0);CHECK(failed && !nv && delay_count==1 && delays[0]==999);
    reset();uint32_t fatal_response[]={0x1d0cc,0x1d000|UGD_SEL_RESPONSE_US,0x1d1e7,0x1d203};
    queued(fatal_response,4);read_at(0x1d0);CHECK(failed && nv==1 && verdict[0]==UINT32_MAX && delays[1]==999);
    read_at(0x300);CHECK(!nv && !delay_count);ug_diag_isa_stats(&writes,&reads);CHECK(reads==2);
    reset();uint32_t too_long[]={0x1d0cc,0x1d000|UGD_SEL_ASSERT_US,0x1d1ff,0x1d2ff};
    queued(too_long,4);read_at(0x1d0);CHECK(!failed && nv==2 && !delays[0] && !delays[1]);
    reset();uint32_t payload[]={((UGD_BASE+2)<<8)|1,((UGD_BASE+1)<<8)|UGD_WRITE,(UGD_BASE<<8)|7};
    queued(payload,3);read_at(UGD_BASE+1);CHECK(nv==2 && verdict[1]==(0xff00|UGD_WRITE));
    ug_diag_isa_stats(&writes,&reads);CHECK(writes==3 && reads==1);
    printf("S5 actual posted diagnostic HOST_PASS: %u checks\n",checks);
    return 0;
}
