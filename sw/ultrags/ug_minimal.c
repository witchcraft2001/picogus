/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * S2 transport/INFO only. No storage or musical capability is advertised.
 */
#include "ug_minimal.h"
#include "ug_config.h"
#include <string.h>
#ifndef UG_BUILD_ID
#define UG_BUILD_ID "000000000000000+"
#endif
enum { IDLE,RX,EXEC,REPLY,FAULT,CANCEL };
static unsigned frame_state;
#define state __atomic_load_n(&frame_state,__ATOMIC_ACQUIRE)
#define SET_STATE(v) __atomic_store_n(&frame_state,(v),__ATOMIC_RELEASE)
static uint8_t request[134],response[134], used,total,read_index;
/* Core0 produces GS latches, core1 consumes CB. Volatile alone cannot
 * publish the input bytes or protect flags/error updates across cores. */
static uint8_t error,gs_error,gs_in,gs_out,gs_command,gs_flags;
#define ERROR(v) __atomic_store_n(&error,(v),__ATOMIC_RELAXED)
#define GS_ERROR(v) __atomic_store_n(&gs_error,(v),__ATOMIC_RELAXED)
static uint8_t gs_status(void) { return __atomic_load_n(&gs_flags,__ATOMIC_ACQUIRE); }
static uint8_t snap_index;
static uint32_t last_byte;
static uint8_t boot_state;
static uint64_t session_id;
void ug_minimal_init(void) {
    SET_STATE(IDLE); error=gs_error=gs_flags=used=total=read_index=snap_index=0;
    gs_in=gs_out=gs_command=0; boot_state=2; session_id=0;
}
void ug_minimal_ready(uint8_t s,uint64_t session) {
    session_id=session; __atomic_store_n(&boot_state,s,__ATOMIC_RELEASE);
}
bool ug_minimal_gs_idle(void) { return !gs_status(); }
bool ug_minimal_idle(void) { return __atomic_load_n(&frame_state,__ATOMIC_ACQUIRE)==IDLE && ug_minimal_gs_idle() && __atomic_load_n(&boot_state,__ATOMIC_ACQUIRE)!=2; }
static int reg(uint16_t port) {
    uint16_t base=ug_cfg.settings->UltraGS.basePort, alias=ug_cfg.settings->UltraGS.bulkAlias;
    if(port>=base && port-base<32) return port-base;
    if(alias!=0xffff && port>=alias && port-alias<32) return 0;
    if(ug_cfg.aliases && port==0xb3) return 0x13;
    if(ug_cfg.aliases && port==0xbb) return 0x1b;
    return -1;
}
bool ug_minimal_port(uint16_t p) { return reg(p)>=0; }
void ug_minimal_write(uint16_t p,uint8_t v,uint32_t now) {
    if(ug_config_busy(&ug_cfg)) { ERROR(5); return; }
    switch(reg(p)) {
    case 0: ERROR(6); break; /* no transfer grants in S2 */
    case 2:
        if(v==0xa0) {
            unsigned current=__atomic_load_n(&frame_state,__ATOMIC_ACQUIRE);
            __atomic_store_n(&frame_state,(current==EXEC || current==CANCEL)?CANCEL:IDLE,__ATOMIC_RELEASE);
            ERROR(0);
        }
        else if(v==0xa1) { /* no transfer exists */ }
        else if(v==0xa2) { ERROR(0); GS_ERROR(0); }
        else if(v==0xa3) ERROR(1);
        else ERROR(2);
        break;
    case 3:
        if(state==FAULT) return;
        if(state==EXEC || state==REPLY || state==CANCEL) { ERROR(5); return; }
        if(state==IDLE) { SET_STATE(RX); used=0; total=2; }
        request[used++]=v; last_byte=now;
        if(used==2) {
            if(v>128) { SET_STATE(FAULT); ERROR(3); return; }
            total=2+v+((request[0]&128)?4:0);
        }
        if(used==total) __atomic_store_n(&frame_state,EXEC,__ATOMIC_RELEASE);
        break;
    case 4: if(v>127) ERROR(2); else snap_index=v; break;
    case 0x13:
        if(gs_status()&129) GS_ERROR(0x0e);
        else { gs_in=v; __atomic_fetch_or(&gs_flags,128,__ATOMIC_RELEASE); }
        break;
    case 0x1b:
        if(gs_status()&1) GS_ERROR(5);
        else { gs_command=v; __atomic_fetch_or(&gs_flags,1,__ATOMIC_RELEASE); }
        break;
    default:ERROR(0x14);
    }
}
uint8_t ug_minimal_read(uint16_t p) {
    unsigned current=__atomic_load_n(&frame_state,__ATOMIC_ACQUIRE);
    switch(reg(p)) {
    case 0: ERROR(15); return 255;
    case 1: return (current==IDLE && !ug_config_busy(&ug_cfg)?1:0)|(current==EXEC?2:0)|(current==REPLY?4:0)|(__atomic_load_n(&error,__ATOMIC_RELAXED)?32:0)|(__atomic_load_n(&gs_error,__ATOMIC_RELAXED)?64:0);
    case 3:
        if(current!=REPLY) { ERROR(15); return 255; }
        { uint8_t v=response[read_index++]; if(read_index==total) __atomic_store_n(&frame_state,IDLE,__ATOMIC_RELEASE); return v; }
    case 4:return snap_index;
    case 5:ERROR(1); return 255;
    case 6:return __atomic_load_n(&error,__ATOMIC_RELAXED);
    case 7:return __atomic_load_n(&gs_error,__ATOMIC_RELAXED);
    case 8:return 1;
    case 9:return 0;
    case 0x13:__atomic_fetch_and(&gs_flags,1,__ATOMIC_ACQ_REL); return gs_out;
    case 0x1b:return 0x7e|gs_status();
    default:return 0;
    }
}
void ug_minimal_poll(uint32_t now) {
    if(state==RX && (uint32_t)(now-last_byte)>=1000000) { SET_STATE(FAULT); ERROR(13); }
}
void ug_minimal_dispatch(void) {
    unsigned current=__atomic_load_n(&frame_state,__ATOMIC_ACQUIRE);
    if(current==CANCEL) { __atomic_store_n(&frame_state,IDLE,__ATOMIC_RELEASE); return; }
    if(gs_status()&1) {
        (void)gs_command; (void)gs_in;
        GS_ERROR(1);
        __atomic_fetch_and(&gs_flags,0,__ATOMIC_RELEASE);
    }
    if(current!=EXEC) return;
    uint8_t status=0, length=0;
    bool crc=request[0]&128;
    if(crc && ug_crc32(request,used-4)!=ug_get32(request+used-4)) status=4;
    else if((request[0]&127)!=0) status=1;
    else if(request[1]) status=3;
    else {
        length=36; memset(response+2,0,length);
        memcpy(response+2,"UGS1",4); response[6]=1; response[8]=8;
        response[9]=__atomic_load_n(&boot_state,__ATOMIC_ACQUIRE);
        ug_put32(response+10,0x040101);
        memcpy(response+14,&session_id,8); memcpy(response+22,UG_BUILD_ID,16);
    }
    response[0]=status; response[1]=length; total=2+length;
    if(status) ERROR(status);
    if(crc) { ug_put32(response+total,ug_crc32(response,total)); total+=4; }
    read_index=0;
    unsigned expected=EXEC;
    if(!__atomic_compare_exchange_n(&frame_state,&expected,REPLY,false,__ATOMIC_RELEASE,__ATOMIC_ACQUIRE))
        __atomic_store_n(&frame_state,IDLE,__ATOMIC_RELEASE);
}
