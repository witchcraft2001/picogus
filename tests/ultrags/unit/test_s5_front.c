/* SPDX-License-Identifier: GPL-2.0-or-later
 * Executes the production posted fence with finite FIFO / in-flight capture.
 */
#include "ultrags/ug_posted.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
pio_hw mock_pio;
static uint32_t words[10], verdict[4], clock_us, capture;
static unsigned count,pos,verdict_count,applied,faults,capture_polls;
static unsigned base,guard_calls;
static int guard_failure;
static bool fault_during_read;
static bool guard(bool value_phase) {
    assert(value_phase?verdict_count==1 && applied==count:!verdict_count && !applied);
    guard_calls++;
    return guard_failure!=(int)value_phase;
}
unsigned pio_sm_get_rx_fifo_level(PIO p,unsigned sm) { (void)p;assert(sm==0);return count-pos; }
bool pio_sm_is_rx_fifo_empty(PIO p,unsigned sm) { return !pio_sm_get_rx_fifo_level(p,sm); }
unsigned pio_sm_get_pc(PIO p,unsigned sm) {
    (void)p;assert(sm==0);
    if(capture_polls) { capture_polls--; if(!capture_polls)words[count++]=capture; return 6; }
    return 0;
}
uint32_t pio_sm_get(PIO p,unsigned sm) { (void)p;assert(sm==0 && pos<count);return words[pos++]; }
void pio_sm_put(PIO p,unsigned sm,uint32_t v) { (void)p;assert(sm==1);verdict[verdict_count++]=v; if(verdict_count==1)assert(applied==0); }
uint32_t time_us_32(void) { return clock_us++; }
static void fault(void) { faults++; }
static void apply(uint32_t w) { assert(verdict_count==1);applied++;if(w==0x1d202)base=0x2c0; }
static bool owns(uint16_t p,const uint32_t *w,unsigned n) {
    unsigned b=base;for(unsigned i=0;i<n;i++)if(w[i]==0x1d202)b=0x2c0;
    return p==b+1;
}
static uint8_t read_port(uint16_t p) { assert(p==base+1);assert(applied==count);if(fault_during_read)guard_failure=1;return applied; }
int main(void) {
    unsigned checks=0;
    for(unsigned n=0;n<=8;n++)for(unsigned flight=0;flight<2;flight++)for(unsigned ports=0;ports<2;ports++) {
        count=n;pos=verdict_count=applied=faults=0;base=0x2a0;capture_polls=flight?3:0;
        for(unsigned i=0;i<n;i++)words[i]=0x2a055;
        if(ports&&n)words[n-1]=0x1d202;
        capture=ports?0x1d202:0x2a077;
        ug_posted_init(0);mock_pio.fdebug=0;
        ug_posted_read((ports&&(n||flight)?0x2c0:0x2a0)+1,owns,apply,read_port,fault);
        assert(verdict_count==2 && verdict[0]==UINT32_MAX && verdict[1]==(0xff00u|applied));
        assert(applied==n+flight && ug_posted_diag.drained==applied);
        checks++;
    }
    count=8;pos=verdict_count=applied=faults=0;base=0x2a0;capture_polls=0;
    ug_posted_init(0);mock_pio.fdebug=1;
    ug_posted_check(fault);assert(faults && ug_posted_diag.overflow);checks++;
    /* Host ordinary struct cannot implement W1C; acknowledge in mock. */
    mock_pio.fdebug=0;
    verdict_count=applied=0;ug_posted_read(0x300,owns,apply,read_port,fault);
    assert(verdict_count==1 && !verdict[0] && applied==8);checks++;
    for(int failure=-1;failure<=1;failure++) {
        count=2;pos=verdict_count=applied=faults=guard_calls=0;base=0x2a0;capture_polls=0;
        words[0]=words[1]=0x2a055;guard_failure=failure;
        ug_posted_init(0);mock_pio.fdebug=0;
        ug_posted_read_guarded(0x2a1,owns,apply,read_port,fault,guard);
        assert(guard_calls==(failure==0?1:2));
        assert(verdict_count==(failure<0?2u:(unsigned)failure));
        assert(faults==(failure>=0));
        assert(applied==(failure==0?0:2));checks++;
    }
    count=2;pos=verdict_count=applied=faults=guard_calls=0;base=0x2a0;capture_polls=0;
    guard_failure=-1;fault_during_read=true;ug_posted_init(0);mock_pio.fdebug=0;
    ug_posted_read_guarded(0x2a1,owns,apply,read_port,fault,guard);
    assert(guard_calls==2 && verdict_count==1 && faults==1);checks++;
    printf("S5 actual posted front-end HOST_PASS: %u checks\n",checks);
    return 0;
}
