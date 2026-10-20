/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * Framed transport and S4 storage. Musical capabilities remain unavailable.
 */
#include "ug_minimal.h"
#include "ug_config.h"
#include "ug_legacy.h"
#include "ug_storage.h"
#include "ug_s4.h"
#include "ultrags_protocol.h"
#include "pico/stdlib.h"
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
#define ERROR(v) ug_minimal_error(v)
static void gs_error_set(uint8_t v) {
    __atomic_store_n(&gs_error,v,__ATOMIC_RELAXED);
    if(v) ug_stat_add(7,1);
}
#define GS_ERROR(v) gs_error_set(v)
static uint8_t gs_status(void) { return __atomic_load_n(&gs_flags,__ATOMIC_ACQUIRE); }
uint8_t ug_minimal_peek_gs_status(void) { return 0x7e|gs_status(); }
void ug_minimal_error(uint8_t v) {
    __atomic_store_n(&error,v,__ATOMIC_RELAXED);
    if(v) ug_stat_add(v==4?6:7,1);
}
/* RXSTALL is a sticky transport failure; only A0 reopens framing. */
static bool transport_fault;
void ug_minimal_transport_fault(void) {
    transport_fault=true;
    ug_storage_data_overflow();
    ERROR(UG_ERR_OVERFLOW);
}
static uint8_t snap_index;
static uint32_t command_started;
static bool had_transfer;
static uint8_t reset_gs;
static uint32_t last_byte;
static uint8_t boot_state;
static uint64_t session_id;
void ug_minimal_init(void) {
    transport_fault=false; ug_storage_snap_init(); SET_STATE(IDLE); error=gs_error=gs_flags=used=total=read_index=snap_index=0;
    gs_in=gs_out=gs_command=0; boot_state=2; session_id=0; had_transfer=false; reset_gs=0;
}
void ug_minimal_ready(uint8_t s,uint64_t session) {
    session_id=session; __atomic_store_n(&boot_state,s,__ATOMIC_RELEASE);
}
bool ug_minimal_gs_idle(void) { return !gs_status() && !ug_storage_busy() && !ug_legacy_busy(); }
bool ug_minimal_idle(void) { return __atomic_load_n(&frame_state,__ATOMIC_ACQUIRE)==IDLE && ug_minimal_gs_idle() && !ug_storage_playback_busy() && __atomic_load_n(&boot_state,__ATOMIC_ACQUIRE)!=2; }
int ug_minimal_decode_port(uint16_t port) {
    uint16_t base=ug_cfg.settings->UltraGS.basePort, alias=ug_cfg.settings->UltraGS.bulkAlias;
    if(port>=base && port-base<32) return port-base;
    if(alias!=0xffff && port>=alias && port-alias<32) return 0;
    if(port==0xb3 && ug_config_aliases(&ug_cfg)) return 0x13;
    if(port==0xbb && ug_config_aliases(&ug_cfg)) return 0x1b;
    return -1;
}
bool ug_minimal_port(uint16_t p) { return ug_minimal_decode_port(p)>=0; }
void ug_minimal_write_decoded(int decoded,uint8_t v,uint32_t now) {
    ug_stat_add(1,1);
    if(ug_config_busy(&ug_cfg)) { ERROR(5); return; }
    if(transport_fault && decoded!=2) { ERROR(UG_ERR_OVERFLOW); return; }
    switch(decoded) {
    case 0: {
        uint8_t e=!ug_storage_bulk()?UG_ERR_STATE:ug_storage_data_write(v,now);
        if(e) ERROR(e);
        break;
    }
    case 2:
        if(v==0xa0) {
            transport_fault=false;
            unsigned current=__atomic_load_n(&frame_state,__ATOMIC_ACQUIRE);
            ug_storage_request_cancel();
            __atomic_store_n(&frame_state,(current==EXEC || current==CANCEL)?CANCEL:IDLE,__ATOMIC_RELEASE);
            __atomic_store_n(&gs_flags,0,__ATOMIC_RELEASE); ERROR(0);
        }
        else if(v==0xa1) { ug_storage_request_cancel(); }
        else if(v==0xa2) { ERROR(0); GS_ERROR(0); }
        else if(v==0xa3) { ug_storage_latch(); snap_index=0; }
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
        if(used==total) { command_started=now; ug_stat_max(13,used); __atomic_store_n(&frame_state,EXEC,__ATOMIC_RELEASE); }
        break;
    case 4: if(v>63) ERROR(8); else snap_index=v; break;
    case 0x13:
        if(ug_storage_transfer() && (ug_storage_bulk() || ug_storage_grant()!=8)) { if(ug_legacy_loading()) GS_ERROR(5);else ERROR(6);break; }
        if(gs_status()&129) { GS_ERROR(0x0e); ug_storage_data_overflow(); }
        else { gs_in=v; ug_storage_touch(now); __atomic_fetch_or(&gs_flags,128,__ATOMIC_RELEASE); }
        break;
    case 0x1b:
        if(gs_status()&1) GS_ERROR(5);
        else { gs_command=v; __atomic_fetch_or(&gs_flags,1,__ATOMIC_RELEASE); }
        break;
    default:ERROR(0x14);
    }
}
void ug_minimal_write(uint16_t p,uint8_t v,uint32_t now) {
    ug_minimal_write_decoded(ug_minimal_decode_port(p),v,now);
}
uint8_t ug_minimal_read_status(void) {
    ug_stat_add(0,1);
    unsigned current=__atomic_load_n(&frame_state,__ATOMIC_ACQUIRE);
    return (current==IDLE && !transport_fault && !ug_config_busy(&ug_cfg)?1:0)|(current==EXEC?2:0)|(current==REPLY?4:0)|(transport_fault?0:ug_storage_grant())|(__atomic_load_n(&error,__ATOMIC_RELAXED)?32:0)|(__atomic_load_n(&gs_error,__ATOMIC_RELAXED)?64:0)|(ug_storage_audio_active()?128:0);
}
uint8_t ug_minimal_read_response(void) {
    ug_stat_add(0,1);
    unsigned current=__atomic_load_n(&frame_state,__ATOMIC_ACQUIRE);
    if(transport_fault) { ERROR(UG_ERR_OVERFLOW); return 255; }
    if(current!=REPLY) { if(current!=FAULT) ERROR(15); return 255; }
    uint8_t value=response[read_index++];
    if(read_index==total) {
        ug_storage_grant_ack(time_us_32());
        __atomic_store_n(&frame_state,IDLE,__ATOMIC_RELEASE);
    }
    return value;
}
uint8_t ug_minimal_read_decoded(int decoded) {
    if(decoded==1) return ug_minimal_read_status();
    if(decoded==3) return ug_minimal_read_response();
    ug_stat_add(0,1);
    if(transport_fault && (decoded==0 || decoded==0x13)) { ERROR(UG_ERR_OVERFLOW); return 255; }
    switch(decoded) {
    case 0: {
        uint8_t v=255;
        uint8_t e=!ug_storage_bulk()?UG_ERR_STATE:ug_storage_data_read(&v,time_us_32());
        if(e) ERROR(e);
        return v;
    }
    case 4:return snap_index;
    case 5: if(snap_index==64) { ERROR(15); return 255; } return ug_storage_snap_byte(snap_index++);
    case 6:return __atomic_load_n(&error,__ATOMIC_RELAXED);
    case 7:return __atomic_load_n(&gs_error,__ATOMIC_RELAXED);
    case 8:return 1;
    case 9:return 0;
    case 0x13:
        if(ug_storage_transfer()) {
            uint8_t v=255;
            uint8_t e=(ug_storage_bulk() || ug_storage_grant()!=16)?6:(!(gs_status()&128) && ug_storage_read_available())?15:ug_storage_data_read(&v,time_us_32());
            if(e) ERROR(e);
            else { gs_out=v; __atomic_fetch_and(&gs_flags,1,__ATOMIC_ACQ_REL); }
            return v;
        }
        __atomic_fetch_and(&gs_flags,1,__ATOMIC_ACQ_REL); return gs_out;
    case 0x1b:return ug_minimal_peek_gs_status();
    default:return 0;
    }
}
uint8_t ug_minimal_read(uint16_t p) {
    return ug_minimal_read_decoded(ug_minimal_decode_port(p));
}
void ug_minimal_poll(uint32_t now) {
    if(state==RX && (uint32_t)(now-last_byte)>=1000000) { SET_STATE(FAULT); ERROR(13); }
}
void ug_minimal_poll_now(void) {
    /* Idle/configuration traffic has no partial request to expire. Avoid a
     * timer read on every ISA polling iteration, ahead of the next IOR. */
    if(state==RX) ug_minimal_poll(time_us_32());
}
void ug_minimal_dispatch(void) {
    unsigned current=__atomic_load_n(&frame_state,__ATOMIC_ACQUIRE);
    uint32_t now=time_us_32();
    if(current==CANCEL) {
        if(ug_storage_abort(now)) {
            if(reset_gs && reset_gs!=3) ug_storage_gs_reset(reset_gs==2,now);
            reset_gs=0;
            __atomic_store_n(&frame_state,IDLE,__ATOMIC_RELEASE);
            /* WC acknowledges reset last: a host observing CB=0 must be
             * able to start its next frame without a remaining CANCEL gap. */
            __atomic_store_n(&gs_flags,0,__ATOMIC_RELEASE);
        }
        return;
    }
    ug_storage_tick(now);
    bool active=ug_storage_transfer();
    if(had_transfer && !active) __atomic_fetch_and(&gs_flags,1,__ATOMIC_ACQ_REL);
    had_transfer=active;
    if(gs_status()&1) {
        uint8_t cmd=gs_command;
        bool loading=ug_legacy_loading();
        if(cmd==0xf3 || cmd==0xf4 || (cmd==0 && active && !loading)) {
            GS_ERROR(0);ERROR(0);reset_gs=cmd==0xf4?2:cmd==0xf3?1:3;
            SET_STATE(CANCEL);return;
        }
        if(active) {
            /* LOAD continues to ignore ordinary SC bytes during a packet.
             * Only D2 conflicts with the live packet; reset was handled above. */
            if(!loading || cmd==0xd2) GS_ERROR(UG_ERR_BUSY);
            __atomic_fetch_and(&gs_flags,128,__ATOMIC_ACQ_REL);
        } else {
            uint8_t e=0,out=gs_out;bool db=false;
            if(loading && (gs_status()&128)) {
                ug_legacy_data(gs_in,&e);__atomic_fetch_and(&gs_flags,1,__ATOMIC_ACQ_REL);
                if(e) GS_ERROR(e==UG_ERR_PSRAM?0xe1:e);
            }
            bool pre=(gs_status()&128)!=0;
            if(!ug_legacy_command(cmd,pre,gs_in,&out,&db,&e)) return;
            if(cmd==0 && !loading) { GS_ERROR(0);ERROR(0); }
            else if(e) GS_ERROR(e);
            if(cmd==0xf0 && !loading) { out=__atomic_load_n(&gs_error,__ATOMIC_RELAXED);db=true; }
            gs_out=out;
            /* Publish OUT before clearing CB. A host observing WC may read
             * the optional latch immediately, with DB deliberately clear. */
            __atomic_store_n(&gs_flags,db?128:0,__ATOMIC_RELEASE);
        }
    } else if(!active) {
        uint8_t e=0;
        if((gs_status()&128) && ug_legacy_accepts_data()) {
            ug_legacy_data(gs_in,&e);
            if(e) GS_ERROR(e==UG_ERR_PSRAM?0xe1:e);
            __atomic_fetch_and(&gs_flags,1,__ATOMIC_ACQ_REL);
        } else if(!(gs_status()&128)) {
            ug_legacy_reply_consumed();
            uint8_t out;
            if(ug_legacy_reply(&out)) { gs_out=out;__atomic_fetch_or(&gs_flags,128,__ATOMIC_RELEASE); }
        }
    }
    if(!ug_storage_bulk() && ug_storage_grant()==8 && (gs_status()&128)) {
        uint8_t e=ug_storage_data_write(gs_in,now); if(e) ERROR(e);
        __atomic_fetch_and(&gs_flags,1,__ATOMIC_ACQ_REL);
    } else if(!ug_storage_bulk() && ug_storage_read_available()) {
        __atomic_fetch_or(&gs_flags,128,__ATOMIC_RELEASE);
    }
    if(reset_gs) return;
    if(current!=EXEC) return;
    uint8_t status=0, length=0;
    bool crc=request[0]&128;
    if(crc && ug_crc32(request,used-4)!=ug_get32(request+used-4)) status=4;
    else if((request[0]&127)!=0) {
        if(!ug_storage_command(request[0]&127,request+2,request[1],response+2,&length,&status,time_us_32())) return;
    }
    else if(request[1]) status=3;
    else {
        length=40; memset(response+2,0,length);
        memcpy(response+2,"UGS1",4); response[6]=1; response[8]=8;
        response[9]=__atomic_load_n(&boot_state,__ATOMIC_ACQUIRE);
        ug_put32(response+10,0x040101);
        memcpy(response+14,&session_id,8); memcpy(response+22,UG_BUILD_ID,16);memcpy(response+38,"VLS1",4);
    }
    response[0]=status; response[1]=length; total=2+length;
    if(status) ERROR(status);
    if(crc) { ug_put32(response+total,ug_crc32(response,total)); total+=4; }
    ug_stat_max(12,time_us_32()-command_started); ug_stat_max(14,total);
    read_index=0;
    unsigned expected=EXEC;
    /* Core0 can request reset during the last storage slice. Keep CANCEL
     * until the next dispatch releases pins/staging; never reopen RX here. */
    (void)__atomic_compare_exchange_n(&frame_state,&expected,REPLY,false,__ATOMIC_RELEASE,__ATOMIC_ACQUIRE);
}
