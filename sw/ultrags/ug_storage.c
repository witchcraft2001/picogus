/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * All mutable store/job data belong exclusively to core1.
 */
#include "ug_storage.h"
#include "ug_store.h"
#include "ug_memory.h"
#include "ug_minimal.h"
#include "ug_config.h"
#include <string.h>
#include "ultrags_protocol.h"
static ug_store_t store;
static ug_memory_job_t job;
static ug_psram_t *ps;
static uint8_t memory_error, audio_error;
static bool running, full_after_probe;
static uint32_t probe_tested, job_started;
static unsigned busy;
static uint16_t get16(const uint8_t *p) { return p[0]|((uint16_t)p[1]<<8); }
static void put16(uint8_t *p,uint16_t v) { p[0]=v; p[1]=v>>8; }
static void boot(void) { ug_minimal_ready(audio_error?3:memory_error?1:0,store.session); }
void ug_storage_bind(ug_psram_t *p,uint64_t session) {
    ps=p; ug_store_init(&store,0,session); memset(&job,0,sizeof(job));
    running=false; memory_error=0; audio_error=0;
    __atomic_store_n(&busy,1,__ATOMIC_RELEASE); ug_minimal_ready(2,session);
}
void ug_storage_publish(uint32_t physical,uint8_t error,uint8_t ae) {
    store.pool=physical; memory_error=error; audio_error=ae;
    __atomic_store_n(&busy,0,__ATOMIC_RELEASE); boot();
}
bool ug_storage_busy(void) { return __atomic_load_n(&busy,__ATOMIC_ACQUIRE)!=0; }
void ug_storage_cancel(uint32_t now) {
    if(running) {
        ug_memory_cancel(&job,now); running=false;
        __atomic_store_n(&busy,0,__ATOMIC_RELEASE); boot();
    }
}
static void result(uint8_t *r) {
    ug_put32(r,job.tested); ug_put32(r+4,job.first_bad); r[8]=job.expected; r[9]=job.actual;
    ug_put32(r+10,job.elapsed_ms);
}
static void unavailable_test(uint8_t *r,uint8_t *len) {
    memset(&job,0,sizeof(job)); job.first_bad=UINT32_MAX;
    *len=14; result(r);
}
bool ug_storage_command(uint8_t op,const uint8_t *q,uint8_t n,uint8_t *r,
                        uint8_t *len,uint8_t *status,uint32_t now) {
    *len=*status=UG_ERR_OK;
    if(running) {
        ug_memory_step(&job,now); if(job.active) return false;
        if(!job.status && job.probe) {
            store.pool=job.physical;
            if(full_after_probe) {
                full_after_probe=false; probe_tested=job.tested;
                ug_memory_start(&job,ps,false,1,job_started); return false;
            }
        }
        job.tested+=probe_tested;
        running=false; __atomic_store_n(&busy,0,__ATOMIC_RELEASE);
        memory_error=job.status; boot(); *status=job.status;
        if(op==UG_OP_MEM_TEST) { *len=14; result(r); }
        else if(!*status) { *len=8; memcpy(r,&store.session,8); }
        return true;
    }
    unsigned expected;
    switch(op) {
    case UG_OP_CAPS: case UG_OP_MEM_INFO: expected=0; break;
    case UG_OP_MEM_TEST: expected=1; break;
    case UG_OP_RESET_STORE: case UG_OP_ALLOC: expected=5; break;
    case UG_OP_FREE: case UG_OP_OBJECT_INFO: case UG_OP_OBJECT_ENUM: expected=2; break;
    default: *status=UG_ERR_BAD_OPCODE; return true;
    }
    if(n!=expected) { *status=UG_ERR_LENGTH; return true; }
    if(op==UG_OP_CAPS) {
        memset(r,0,32); *len=32;
        ug_put32(r,128u|(ug_config_aliases(&ug_cfg)?512u:0u)); /* only MEM_TEST (+ live GS alias setting) */
        ug_put32(r+8,48000); put16(r+12,1024); put16(r+14,128); put16(r+16,128);
        put16(r+24,ug_cfg.settings->UltraGS.basePort); put16(r+26,ug_cfg.settings->UltraGS.bulkAlias);
        return true;
    }
    if(ug_storage_busy()) { *status=UG_ERR_BUSY; return true; }
    if(op==UG_OP_MEM_INFO) {
        uint32_t free_bytes,largest; ug_store_space(&store,&free_bytes,&largest);
        ug_put32(r,store.pool); ug_put32(r+4,store.pool); ug_put32(r+8,free_bytes);
        ug_put32(r+12,largest); put16(r+16,store.count); put16(r+18,128); *len=20;
    } else if(op==UG_OP_MEM_TEST || op==UG_OP_RESET_STORE) {
        uint8_t mode=op==UG_OP_MEM_TEST?q[0]:q[4];
        if(mode>1 || (op==UG_OP_RESET_STORE && ug_get32(q)!=UG_RESET_STORE_KEY)) { *status=UG_ERR_BAD_ARGUMENT; return true; }
        if(op==UG_OP_MEM_TEST && store.count) { *status=UG_ERR_BUSY; return true; }
        if(op==UG_OP_RESET_STORE) { ug_store_reset(&store); boot(); }
        if(op==UG_OP_RESET_STORE && !mode) { memcpy(r,&store.session,8); *len=8; return true; }
        if(!ps || (!ps->up && !ps->divider256)) {
            if(!memory_error) { memory_error=UG_ERR_PSRAM; boot(); }
            *status=memory_error;
            if(op==UG_OP_MEM_TEST && *status==UG_ERR_PSRAM) unavailable_test(r,len);
            return true;
        }
        bool probe=!store.pool;
        bool recover=probe || ug_psram_dma_fault;
        if(recover && ug_psram_recover(ps)) {
            memory_error=UG_ERR_PSRAM; boot(); *status=UG_ERR_PSRAM;
            if(op==UG_OP_MEM_TEST) unavailable_test(r,len);
            return true;
        }
        if(probe) ps->pool_bytes=8u<<20;
        job_started=now; probe_tested=0; full_after_probe=probe && op==UG_OP_MEM_TEST && mode;
        ug_memory_start(&job,ps,probe,op==UG_OP_MEM_TEST?mode:0,now); running=true;
        __atomic_store_n(&busy,1,__ATOMIC_RELEASE); return false;
    } else if(op==UG_OP_ALLOC) {
        if(memory_error) { *status=memory_error; return true; }
        ug_object_t *o; *status=ug_store_reserve(&store,q[0],ug_get32(q+1),&o);
        if(!*status) { put16(r,o->handle); ug_put32(r+2,o->reserved); *len=6; }
    } else if(op==UG_OP_FREE) *status=ug_store_free(&store,get16(q));
    else if(op==UG_OP_OBJECT_ENUM) { put16(r,ug_store_enum(&store,get16(q))); *len=2; }
    else {
        ug_object_t *o=ug_store_find(&store,get16(q));
        if(!o) *status=UG_ERR_HANDLE;
        else {
            memset(r,0,38); put16(r,o->handle); r[2]=o->kind; r[3]=o->state;
            put16(r+4,o->pins); ug_put32(r+6,o->size); ug_put32(r+10,o->uploaded);
            ug_put32(r+14,o->crc); *len=38;
        }
    }
    return true;
}
