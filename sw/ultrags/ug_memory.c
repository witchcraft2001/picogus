/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_memory.h"
#include <string.h>
#include "ultrags_protocol.h"
static void finish(ug_memory_job_t *j,uint8_t status,uint32_t now) {
    j->status=status; j->active=false; j->elapsed_ms=(now-j->started)/1000;
}
static void bad(ug_memory_job_t *j,uint32_t a,uint8_t e,uint8_t v,uint32_t now) {
    j->first_bad=a; j->expected=e; j->actual=v; finish(j,UG_ERR_PSRAM,now);
}
static void point(ug_memory_job_t *j,uint32_t a) {
    for(unsigned i=0;i<j->count;i++) if(j->points[i]==a) return;
    if(j->count<UG_QUICK_POINTS) j->points[j->count++]=a;
}
static void quick(ug_memory_job_t *j) {
    j->count=j->index=0; point(j,0);
    for(uint32_t a=1;a<j->physical;a<<=1) { point(j,a); point(j,a-1); }
    point(j,j->physical-1); j->phase=3;
}
void ug_memory_start(ug_memory_job_t *j,ug_psram_t *ps,bool probe,uint8_t mode,uint32_t now) {
    memset(j,0,sizeof(*j)); j->ps=ps; j->probe=probe; j->mode=mode;
    j->physical=ps->pool_bytes; j->first_bad=UINT32_MAX; j->started=now; j->active=true;
    if(!probe) { if(mode==0) quick(j); else j->phase=5; }
}
/* Distinct address bytes are tested in three independent full passes, so
 * aliasing at any address bit cannot hide behind an 8-bit hash collision. */
static uint8_t pattern(uint8_t pass,uint32_t a) {
    static const uint8_t fixed[]={0,255,85,170};
    if(pass<4) return fixed[pass];
    if(pass<7) return (uint8_t)(a>>((pass-4)*8));
    return (uint8_t)(1u<<(pass-7));
}
void ug_memory_step(ug_memory_job_t *j,uint32_t now) {
    if(!j->active) return;
    ug_psram_t *ps=j->ps; uint32_t a=0,n=1; uint8_t e;
    if(j->phase==0) {
        uint8_t id[8];
        if(ug_psram_read_id(ps,id)) { bad(j,0,0,0,now); return; }
        if(id[0]!=0x0d || id[1]!=0x5d) { finish(j,UG_ERR_UNSUPPORTED_MEMORY,now); return; }
        /* Legacy parts with EID=FF have no usable density hint. Capacity
         * still requires the complete alias matrix and address-line test. */
        j->physical=id[2]==255?0:((id[2]>>5)<=2?(2u<<20)<<(id[2]>>5):0);
        if(id[2]!=255 && !j->physical) { finish(j,UG_ERR_UNSUPPORTED_MEMORY,now); return; }
        j->phase=1; j->index=0; return;
    }
    if(j->phase==1) {
        a=(uint32_t)j->index<<20; e=(uint8_t)(0xa0+j->index);
        if(ug_psram_write(ps,a,&e,1)) { bad(j,a,e,0,now); return; }
        if(++j->index==8) { j->index=0; j->phase=2; } return;
    }
    if(j->phase==2) {
        a=(uint32_t)j->index<<20;
        if(ug_psram_read(ps,a,j->buffer+j->index,1)) { bad(j,a,0,0,now); return; }
        if(++j->index<8) return;
        bool hinted=j->physical!=0;
        unsigned cap=hinted?j->physical>>20:8;
        if(!hinted) {
            /* Region 7 was written last: its marker is known even with
             * unknown aliasing. Corrupt data must not become a fake size. */
            j->tested++;
            if(j->buffer[7]!=0xa7) { bad(j,7u<<20,0xa7,j->buffer[7],now); return; }
            /* Distance to the preceding copy identifies the alias period,
             * including unsupported 3/5/6/7 MiB rather than guessing from
             * region 0 (which is ambiguous for those sizes). */
            for(unsigned i=7;i-->0;) if(j->buffer[i]==0xa7) { cap=7-i; break; }
        }
        for(unsigned i=0;i<8;i++) {
            if(!hinted && i==7) continue; /* already compared above */
            unsigned region=i%cap;
            uint8_t expected=(uint8_t)(0xa0+region+(7-region)/cap*cap); j->tested++;
            if(j->buffer[i]!=expected) { bad(j,i<<20,expected,j->buffer[i],now); return; }
        }
        if(cap!=1 && cap!=2 && cap!=4 && cap!=8) { finish(j,UG_ERR_UNSUPPORTED_MEMORY,now); return; }
        j->physical=cap<<20; ps->pool_bytes=j->physical; quick(j); return;
    }
    if(j->phase==3 || j->phase==4) {
        a=j->points[j->index]; e=(uint8_t)((0x80+j->index)^(j->pass?255:0));
        if(j->phase==3) {
            if(ug_psram_write(ps,a,&e,1)) { bad(j,a,e,0,now); return; }
        } else {
            if(ug_psram_read(ps,a,j->buffer,1)) { bad(j,a,e,0,now); return; }
            j->tested++; if(j->buffer[0]!=e) { bad(j,a,e,j->buffer[0],now); return; }
        }
        if(++j->index==j->count) {
            j->index=0; if(j->phase==3) j->phase=4;
            else if(!j->pass++) j->phase=3; else finish(j,UG_ERR_OK,now);
        } return;
    }
    a=j->offset; n=j->physical-a; if(n>UG_PSRAM_CHUNK) n=UG_PSRAM_CHUNK;
    if(j->phase==5) {
        for(unsigned i=0;i<n;i++) j->buffer[i]=pattern(j->pass,a+i);
        if(ug_psram_write(ps,a,j->buffer,n)) { bad(j,a,j->buffer[0],0,now); return; }
    } else {
        if(ug_psram_read(ps,a,j->buffer,n)) { bad(j,a,pattern(j->pass,a),0,now); return; }
        for(unsigned i=0;i<n;i++) {
            j->tested++; e=pattern(j->pass,a+i);
            if(e!=j->buffer[i]) { bad(j,a+i,e,j->buffer[i],now); return; }
        }
    }
    j->offset+=n;
    if(j->offset==j->physical) {
        j->offset=0;
        if(j->phase==5) j->phase=6;
        else if(++j->pass==15) finish(j,UG_ERR_OK,now);
        else j->phase=5;
    }
}
void ug_memory_cancel(ug_memory_job_t *j,uint32_t now) { if(j->active) finish(j,UG_ERR_CANCELLED,now); }
