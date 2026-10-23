/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_opl.h"
#include "../opl/emu8950.h"
#include <string.h>
#include <assert.h>

static ug_opl_queue queue;
static uint8_t address;
static uint32_t volume=100;
static bool sounding, initialized;
static OPL synth;
static int32_t output[128], source[135];
static unsigned residue;
static int32_t first, second;
static bool primed;
typedef struct { uint32_t started; uint8_t value; bool running, masked, overflow; } timer;
static timer timers[2];
uint8_t ug_opl_status_value=6;
bool ug_opl_timer_poll_needed;
uint32_t ug_opl_timer_deadline;

bool ug_opl_enqueue(ug_opl_queue *q,uint8_t reg,uint8_t value) {
    uint32_t p=__atomic_load_n(&q->producer,__ATOMIC_RELAXED);
    uint32_t c=__atomic_load_n(&q->consumer,__ATOMIC_ACQUIRE);
    if((uint32_t)(p-c)>=UG_OPL_CAPACITY) return false;
    q->commands[p&255]=(ug_opl_command){reg,value};
    __atomic_store_n(&q->producer,p+1,__ATOMIC_RELEASE);
    return true;
}
unsigned ug_opl_snapshot(const ug_opl_queue *q) {
    return __atomic_load_n(&q->producer,__ATOMIC_ACQUIRE)-
           __atomic_load_n(&q->consumer,__ATOMIC_RELAXED);
}
bool ug_opl_pop(ug_opl_queue *q,ug_opl_command *out) {
    uint32_t c=__atomic_load_n(&q->consumer,__ATOMIC_RELAXED);
    if(c==__atomic_load_n(&q->producer,__ATOMIC_ACQUIRE)) return false;
    *out=q->commands[c&255];
    __atomic_store_n(&q->consumer,c+1,__ATOMIC_RELEASE);
    return true;
}
static void tick(uint32_t now) {
    for(unsigned i=0;i<2;i++) {
        timer *t=&timers[i];
        uint32_t period=(256u-t->value)*(i?320u:80u);
        if(t->running && (uint32_t)(now-t->started)>=period) {
            if(!t->masked) t->overflow=true;
            t->started=now-((now-t->started)%period);
        }
    }
}
static void publish_status(void) {
    unsigned flags=(timers[0].overflow?0x40:0)|(timers[1].overflow?0x20:0);
    ug_opl_status_value=6|flags|(flags?0x80:0);
    bool needed=false;uint32_t earliest=0;
    for(unsigned i=0;i<2;i++) {
        const timer *t=&timers[i];
        if(!t->running || t->masked || t->overflow) continue;
        uint32_t deadline=t->started+(256u-t->value)*(i?320u:80u);
        if(!needed || (int32_t)(deadline-earliest)<0) earliest=deadline;
        needed=true;
    }
    ug_opl_timer_deadline=earliest;
    ug_opl_timer_poll_needed=needed;
}
void ug_opl_poll(uint32_t now) {
    tick(now);publish_status();
}
uint8_t ug_opl_status(uint32_t now) {
    ug_opl_poll(now);
    return ug_opl_status_value;
}
bool ug_opl_write(uint16_t port,uint8_t value,uint32_t now) {
    /* A full synth queue can hold core0 in the write retry loop. Timers
     * must keep advancing there without consuming or dropping that pair.
     * The caller masks the expiry alarm around this call. */
    if(ug_opl_timer_poll_needed) ug_opl_poll(now);
    if(port==UG_OPL_PORT) { address=value; return true; }
    if(port!=UG_OPL_PORT+1) return true;
    if(address>=2 && address<=4) {
        tick(now);
        if(address<4) timers[address-2].value=value;
        else if(value&128) { timers[0].overflow=timers[1].overflow=false; }
        else for(unsigned i=0;i<2;i++) {
            timer *t=&timers[i];
            t->masked=(value&(0x40u>>i))!=0;
            if(t->masked) t->overflow=false;
            bool run=(value&(1u<<i))!=0;
            if(run && !t->running) t->started=now;
            t->running=run;
        }
        publish_status();
        return true;
    }
    return ug_opl_enqueue(&queue,address,value);
}
bool ug_opl_busy(void) {
    /* Load consumer first: a concurrently consumed command must be covered
     * by sounding, published before the first pop. */
    uint32_t c=__atomic_load_n(&queue.consumer,__ATOMIC_ACQUIRE);
    return c!=__atomic_load_n(&queue.producer,__ATOMIC_ACQUIRE) ||
        __atomic_load_n(&sounding,__ATOMIC_ACQUIRE);
}
void ug_opl_volume(uint8_t percent) {
    __atomic_store_n(&volume,percent>100?100:percent,__ATOMIC_RELEASE);
}
void ug_opl_init(void) {
    OPL_init_static(&synth); initialized=true;
}
static bool audible(void) {
    if(synth.slot_key_status) return true;
    for(unsigned i=0;i<18;i++) {
        if(!(i&1) && !synth.ch_alg[i/2] && !(synth.perc_mode && i>=14)) continue;
        if(synth.slot[i].eg_state==ATTACK || synth.slot[i].eg_out<EG_MAX) return true;
    }
    return first!=0 || second!=0;
}
const int32_t *ug_opl_render(unsigned frames) {
    assert(frames<=128);
    if(!initialized) ug_opl_init();
    unsigned count=ug_opl_snapshot(&queue);
    assert(count<=UG_OPL_CAPACITY);
    if(count) __atomic_store_n(&sounding,true,__ATOMIC_RELEASE);
    for(unsigned i=0;i<count;i++) {
        ug_opl_command cmd; bool ok=ug_opl_pop(&queue,&cmd); assert(ok);
        OPL_writeReg(&synth,cmd.reg,cmd.value);
    }
    /* A fully released chip has no audio state to advance. Keep the native
     * PCM-only path cheap; queued key-on and every release tail bypass this. */
    if(!audible()) {
        memset(output,0,frames*sizeof(*output));
        __atomic_store_n(&sounding,false,__ATOMIC_RELEASE);
        return output;
    }
    unsigned needed=(residue+frames*49716u)/48000u+(primed?0:2);
    OPL_calc_buffer(&synth,source,needed);
    unsigned pos=0;
    if(!primed) { first=source[pos++]; second=source[pos++]; primed=true; }
    unsigned norm=__atomic_load_n(&volume,__ATOMIC_ACQUIRE)*256u/100u;
    unsigned gain=((norm*norm>>8)*norm>>8)*128u;
    for(unsigned i=0;i<frames;i++) {
        int32_t sample=first+(int32_t)(((int64_t)second-first)*residue/48000);
        output[i]=(int32_t)((int64_t)sample*gain/32768);
        residue+=49716;
        while(residue>=48000) { residue-=48000; first=second; second=source[pos++]; }
    }
    assert(pos==needed);
    __atomic_store_n(&sounding,audible(),__ATOMIC_RELEASE);
    return output;
}

#ifdef UG_S4_TEST
void ug_opl_test_reset(void) {
    memset(&queue,0,sizeof(queue));memset(timers,0,sizeof(timers));
    publish_status();
    address=0;volume=100;sounding=primed=false;first=second=0;residue=0;
    ug_opl_init();
}
#endif
