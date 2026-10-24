#ifdef UG_ADLIB
#include "ug_opl.h"
#endif
/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * All mutable store/job data belong exclusively to core1.
 */
#include "ug_storage.h"
#include "ug_store.h"
#include "ug_memory.h"
#include "ug_pcm.h"
#include "ug_stream.h"
#include "ug_render.h"
#include "ug_tracker.h"
#include "ug_minimal.h"
#include "ug_legacy.h"
#include "ug_config.h"
#include "ug_s4.h"
#include "pico/stdlib.h"
#include <string.h>
#include "ultrags_protocol.h"
static ug_store_t store;
static ug_mixer mixer;
static ug_stream stream;
static uint16_t stream_handle;
static bool stream_closing;
static int16_t stream_samples[256];
static void stream_destroy(void) {
    if(stream_handle) {
        ug_store_pin(&store,stream_handle,false);
        ug_store_free(&store,stream_handle);
    }
    stream_handle=0;stream_closing=false;memset(&stream,0,sizeof(stream));
}
static bool mixer_ready, audio_available;
typedef struct {
    uint16_t id,handle,repeats;
    uint16_t voice[UG_LANES];
    uint8_t active,paused,priority,gain,pan,channels,flags,state,kind,legacy,legacy_fine;
    uint8_t logical_channels,s3m,music_channel[UG_LANES],side[UG_LANES];
    uint16_t mod_song_length;
    uint32_t offset;
    ug_pcm_info pcm; /* independent of the movable object table */
} ug_instance;
static ug_instance foreground, fx[UG_LANES];
static ug_instance legacy_fx[4];
static ug_lane hidden_music[8];
static unsigned music_index(unsigned logical,unsigned side) {
    for(unsigned i=0;i<foreground.channels;i++)
        if(foreground.music_channel[i]==logical && foreground.side[i]==side)return i;
    return UG_LANES;
}
static bool music_overridden(unsigned i) {
    if(i>=foreground.channels)return false;
    unsigned logical=foreground.music_channel[i],first=music_index(logical,0);
    if(logical>=4 || first==UG_LANES)return false;
    for(unsigned n=0;n<4;n++)if(legacy_fx[n].active && legacy_fx[n].voice[0]==foreground.voice[first])return true;
    return false;
}
static ug_lane *music_lane(unsigned i) {
    if(music_overridden(i))return &hidden_music[foreground.music_channel[i]*2+foreground.side[i]];
    return &mixer.lanes[foreground.voice[i]];
}
static void advance_hidden(uint32_t frames) {
    for(unsigned i=0;i<foreground.channels;i++)if(music_overridden(i))ug_lane_advance_silent(music_lane(i),frames);
}
static ug_tracker tracker;
static bool legacy_automatic=true;
static unsigned legacy_ticks;
static uint8_t legacy_f00;
static uint16_t legacy_relooper;
static ug_mod_info pending_mod_info, seal_mod_info;
static struct { uint32_t offset,size; } mod_object;
static struct { uint32_t offset,size; } s3m_object;
static ug_s3m_info pending_s3m_info;
static ug_s3m_parser s3m_parser;
static bool s3m_writing;
static uint32_t mod_lane_trigger[UG_MOD_CHANNELS];
/* Commands run on core1 between renders. Project accepted events so the next
 * command validates the ownership that will exist at the quantum boundary. */
static ug_instance pending_foreground, pending_fx[UG_LANES];
enum { UG_AUDIO_EVENTS=16 };
typedef struct { uint8_t op,q[6]; ug_instance instance; } ug_audio_event;
static ug_audio_event events[UG_AUDIO_EVENTS];
static unsigned event_count;
static unsigned audio_active;
static unsigned playback_busy; /* core1 publishes; CONFIG/core0 only reads */
static uint16_t next_play_id=1, next_fx_id=1;
static uint8_t music_master=64, fx_master=64, music_gain=64, fx_gain=64;
static uint8_t main_volume=100;
static ug_memory_job_t job;
static ug_psram_t *ps;
static uint8_t memory_error, audio_error;
static bool running, full_after_probe, gs_job;
static uint32_t probe_tested, job_started;
static unsigned busy;
static void boot(void);
static void stop_all_playback(void);
static void update_playback_busy(void);
static uint8_t legacy_flush(void);
static void legacy_info(uint8_t *r);
static bool legacy_pending(uint16_t handle);
static void legacy_forget(uint16_t handle);
static int audio_mem_read(void *ctx,uint32_t off,uint8_t *dst,uint32_t n);
static uint16_t get16(const uint8_t *p) { return p[0]|((uint16_t)p[1]<<8); }
static void put16(uint8_t *p,uint16_t v) { p[0]=v; p[1]=v>>8; }
static int audio_mem_read(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    (void)ctx; return ps ? ug_psram_read(ps,off,dst,n) : -1;
}
static int mod_object_read(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    const ug_object_t *o=(const ug_object_t *)ctx;
    if(!o || off>o->size || n>o->size-off || n>256) return -1;
    return ps ? ug_psram_read(ps,o->offset+off,dst,n) : -1;
}
static int mod_player_read(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    (void)ctx;
    if(off>mod_object.size || n>mod_object.size-off || n>256) return -1;
    int rc=ps ? ug_psram_read(ps,mod_object.offset+off,dst,n) : -1;
    if(rc) ug_stat_add(10,1);
    return rc;
}
static int s3m_aux_write(void *ctx,uint32_t off,const uint8_t *src,uint32_t n) {
    const ug_object_t *o=ctx;
    if(n>256 || off>o->aux_reserved || n>o->aux_reserved-off)return -1;
    return ug_psram_write(ps,o->aux_offset+off,src,n);
}
static int s3m_player_read(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    (void)ctx;
    if(n>256 || off>s3m_object.size || n>s3m_object.size-off)return -1;
    int rc=ug_psram_read(ps,s3m_object.offset+off,dst,n);if(rc)ug_stat_add(10,1);return rc;
}
static void s3m_seal_init(ug_object_t *o) {
    ug_store_aux(&store,o->handle,0);s3m_writing=false;ug_s3m_parser_init(&s3m_parser,o->size);
}
static int s3m_seal_step(ug_object_t *o) {
    int rc=ug_s3m_parser_step(&s3m_parser,mod_object_read,o,s3m_writing?s3m_aux_write:NULL,o);
    if(rc<0) {
        ug_store_aux(&store,o->handle,0);
        if(rc==-2)ug_stat_add(10,1);
        return -(rc==-2?UG_ERR_PSRAM:UG_ERR_FORMAT);
    }
    if(!rc)return 0;
    if(!s3m_writing) {
        uint8_t e=ug_store_aux(&store,o->handle,s3m_parser.info.aux_size);
        if(e)return -(int)e;
        s3m_writing=true;ug_s3m_parser_init(&s3m_parser,o->size);return 0;
    }
    o->mod_valid=1;o->mod_channels=s3m_parser.info.channels;return 1;
}
static void prepare_mixer(void) {
    if(!mixer_ready && audio_available && store.pool && !memory_error) {
        ug_mem_if mem={.read=audio_mem_read,.write=NULL,.ctx=NULL,.size=store.pool};
        ug_mixer_init(&mixer,mem); mixer_ready=true;
    }
}
/* CRC continuation uses the unfinalized ISO-HDLC accumulator. */
static const uint32_t crc_table[256]={
0x00000000u,0x77073096u,0xee0e612cu,0x990951bau,0x076dc419u,0x706af48fu,0xe963a535u,0x9e6495a3u,
0x0edb8832u,0x79dcb8a4u,0xe0d5e91eu,0x97d2d988u,0x09b64c2bu,0x7eb17cbdu,0xe7b82d07u,0x90bf1d91u,
0x1db71064u,0x6ab020f2u,0xf3b97148u,0x84be41deu,0x1adad47du,0x6ddde4ebu,0xf4d4b551u,0x83d385c7u,
0x136c9856u,0x646ba8c0u,0xfd62f97au,0x8a65c9ecu,0x14015c4fu,0x63066cd9u,0xfa0f3d63u,0x8d080df5u,
0x3b6e20c8u,0x4c69105eu,0xd56041e4u,0xa2677172u,0x3c03e4d1u,0x4b04d447u,0xd20d85fdu,0xa50ab56bu,
0x35b5a8fau,0x42b2986cu,0xdbbbc9d6u,0xacbcf940u,0x32d86ce3u,0x45df5c75u,0xdcd60dcfu,0xabd13d59u,
0x26d930acu,0x51de003au,0xc8d75180u,0xbfd06116u,0x21b4f4b5u,0x56b3c423u,0xcfba9599u,0xb8bda50fu,
0x2802b89eu,0x5f058808u,0xc60cd9b2u,0xb10be924u,0x2f6f7c87u,0x58684c11u,0xc1611dabu,0xb6662d3du,
0x76dc4190u,0x01db7106u,0x98d220bcu,0xefd5102au,0x71b18589u,0x06b6b51fu,0x9fbfe4a5u,0xe8b8d433u,
0x7807c9a2u,0x0f00f934u,0x9609a88eu,0xe10e9818u,0x7f6a0dbbu,0x086d3d2du,0x91646c97u,0xe6635c01u,
0x6b6b51f4u,0x1c6c6162u,0x856530d8u,0xf262004eu,0x6c0695edu,0x1b01a57bu,0x8208f4c1u,0xf50fc457u,
0x65b0d9c6u,0x12b7e950u,0x8bbeb8eau,0xfcb9887cu,0x62dd1ddfu,0x15da2d49u,0x8cd37cf3u,0xfbd44c65u,
0x4db26158u,0x3ab551ceu,0xa3bc0074u,0xd4bb30e2u,0x4adfa541u,0x3dd895d7u,0xa4d1c46du,0xd3d6f4fbu,
0x4369e96au,0x346ed9fcu,0xad678846u,0xda60b8d0u,0x44042d73u,0x33031de5u,0xaa0a4c5fu,0xdd0d7cc9u,
0x5005713cu,0x270241aau,0xbe0b1010u,0xc90c2086u,0x5768b525u,0x206f85b3u,0xb966d409u,0xce61e49fu,
0x5edef90eu,0x29d9c998u,0xb0d09822u,0xc7d7a8b4u,0x59b33d17u,0x2eb40d81u,0xb7bd5c3bu,0xc0ba6cadu,
0xedb88320u,0x9abfb3b6u,0x03b6e20cu,0x74b1d29au,0xead54739u,0x9dd277afu,0x04db2615u,0x73dc1683u,
0xe3630b12u,0x94643b84u,0x0d6d6a3eu,0x7a6a5aa8u,0xe40ecf0bu,0x9309ff9du,0x0a00ae27u,0x7d079eb1u,
0xf00f9344u,0x8708a3d2u,0x1e01f268u,0x6906c2feu,0xf762575du,0x806567cbu,0x196c3671u,0x6e6b06e7u,
0xfed41b76u,0x89d32be0u,0x10da7a5au,0x67dd4accu,0xf9b9df6fu,0x8ebeeff9u,0x17b7be43u,0x60b08ed5u,
0xd6d6a3e8u,0xa1d1937eu,0x38d8c2c4u,0x4fdff252u,0xd1bb67f1u,0xa6bc5767u,0x3fb506ddu,0x48b2364bu,
0xd80d2bdau,0xaf0a1b4cu,0x36034af6u,0x41047a60u,0xdf60efc3u,0xa867df55u,0x316e8eefu,0x4669be79u,
0xcb61b38cu,0xbc66831au,0x256fd2a0u,0x5268e236u,0xcc0c7795u,0xbb0b4703u,0x220216b9u,0x5505262fu,
0xc5ba3bbeu,0xb2bd0b28u,0x2bb45a92u,0x5cb36a04u,0xc2d7ffa7u,0xb5d0cf31u,0x2cd99e8bu,0x5bdeae1du,
0x9b64c2b0u,0xec63f226u,0x756aa39cu,0x026d930au,0x9c0906a9u,0xeb0e363fu,0x72076785u,0x05005713u,
0x95bf4a82u,0xe2b87a14u,0x7bb12baeu,0x0cb61b38u,0x92d28e9bu,0xe5d5be0du,0x7cdcefb7u,0x0bdbdf21u,
0x86d3d2d4u,0xf1d4e242u,0x68ddb3f8u,0x1fda836eu,0x81be16cdu,0xf6b9265bu,0x6fb077e1u,0x18b74777u,
0x88085ae6u,0xff0f6a70u,0x66063bcau,0x11010b5cu,0x8f659effu,0xf862ae69u,0x616bffd3u,0x166ccf45u,
0xa00ae278u,0xd70dd2eeu,0x4e048354u,0x3903b3c2u,0xa7672661u,0xd06016f7u,0x4969474du,0x3e6e77dbu,
0xaed16a4au,0xd9d65adcu,0x40df0b66u,0x37d83bf0u,0xa9bcae53u,0xdebb9ec5u,0x47b2cf7fu,0x30b5ffe9u,
0xbdbdf21cu,0xcabac28au,0x53b39330u,0x24b4a3a6u,0xbad03605u,0xcdd70693u,0x54de5729u,0x23d967bfu,
0xb3667a2eu,0xc4614ab8u,0x5d681b02u,0x2a6f2b94u,0xb40bbe37u,0xc30c8ea1u,0x5a05df1bu,0x2d02ef8du
};
static uint32_t crc_step(uint32_t crc,const uint8_t *p,unsigned n) {
    while(n--) crc=crc_table[(crc^*p++)&255]^(crc>>8);
    return crc;
}
static uint32_t stats[16];
void ug_stat_add(unsigned i,uint32_t n) {
    uint32_t v=__atomic_load_n(stats+i,__ATOMIC_RELAXED), next;
    do { next=n>UINT32_MAX-v?UINT32_MAX:v+n; }
    while(!__atomic_compare_exchange_n(stats+i,&v,next,false,__ATOMIC_RELAXED,__ATOMIC_RELAXED));
}
void ug_stat_max(unsigned i,uint32_t n) {
    uint32_t v=__atomic_load_n(stats+i,__ATOMIC_RELAXED);
    while(v<n && !__atomic_compare_exchange_n(stats+i,&v,n,false,__ATOMIC_RELAXED,__ATOMIC_RELAXED)) {}
}
void ug_stats_copy(uint8_t out[64]) {
    for(unsigned i=0;i<16;i++) ug_put32(out+4*i,__atomic_load_n(stats+i,__ATOMIC_RELAXED));
}
void ug_stats_clear(void) {
    for(unsigned i=0;i<16;i++) __atomic_store_n(stats+i,0,__ATOMIC_RELAXED);
    memset(&mixer.stats,0,sizeof(mixer.stats)); mixer.stats.checksum=0x811c9dc5u;
    mixer.peak_frames=0;
    memset(mixer.peaks,0,sizeof(mixer.peaks)); memset(mixer.peak_current,0,sizeof(mixer.peak_current));
    memset(mixer.lane_peaks,0,sizeof(mixer.lane_peaks)); memset(mixer.lane_peak_current,0,sizeof(mixer.lane_peak_current));
}
/* NONE, PREPARING, ACK_PENDING, GRANTED, CRC_CHECKING, COMMITTING. The release of
 * GRANTED publishes the descriptor and SRAM; END revokes it before SPI. */
enum { T_NONE,T_PREP,T_ACK,T_GRANT,T_CHECK,T_COMMIT };
enum { T_CANCEL_REQUESTED=256,T_STAGING_FAULT=512 };
static struct {
    uint8_t buffers[2][1024];
    unsigned phase;
    uint32_t token, next_token, offset, expected_crc, last, cursor, crc;
    uint16_t handle, length, done;
    uint8_t direction, verified, fault, transport, streaming, buffer_index, stream_failure;
    bool cancelled_command;
} transfer;
static struct { bool active, parser_started; uint16_t handle; uint32_t cursor,crc,expected,started; bool verify; ug_wav_parser parser; ug_mod_parser mod_parser; } sealing;
volatile uint32_t ug_seal_elapsed_us,ug_service_max_us,ug_spi_slice_max_us;
#ifdef UG_S4_TEST
void ug_storage_test_tokens(uint32_t next) { transfer.next_token=next; }
uint32_t ug_storage_test_crc_step(uint32_t crc,const uint8_t *p,unsigned n) { return crc_step(crc,p,n); }
#endif
static unsigned phase(void) { return __atomic_load_n(&transfer.phase,__ATOMIC_ACQUIRE)&255; }
static void set_phase(unsigned p) {
    unsigned v=__atomic_load_n(&transfer.phase,__ATOMIC_ACQUIRE);
    while(!__atomic_compare_exchange_n(&transfer.phase,&v,(v&(T_CANCEL_REQUESTED|(p==T_NONE?0:T_STAGING_FAULT)))|p,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE)) {}
}
bool ug_storage_bulk(void) { return ug_storage_transfer() && !transfer.transport; }
bool ug_storage_read_available(void) { return ug_storage_grant()==16 && __atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE)<transfer.length; }
bool ug_storage_transfer(void) { return phase()!=T_NONE; }
uint8_t ug_storage_grant(void) {
    /* A0/A1 revoke permission in core0 immediately, while core1 releases the
     * pin cooperatively. Cleanup can leave the data phase after cancellation. */
    return __atomic_load_n(&transfer.phase,__ATOMIC_ACQUIRE)==T_GRANT &&
        (!transfer.streaming || __atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE)<transfer.length)?(transfer.direction?16:8):0;
}
void ug_storage_grant_ack(uint32_t now) {
    if(phase()==T_ACK) { __atomic_store_n(&transfer.last,now,__ATOMIC_RELEASE); set_phase(T_GRANT); }
}
void ug_storage_request_cancel(void) { __atomic_fetch_or(&transfer.phase,T_CANCEL_REQUESTED,__ATOMIC_ACQ_REL); }
void ug_storage_data_overflow(void) {
    /* Share the point of no return with COMMITTING. A separate fault flag
     * alone leaves a check-then-CAS race when RXSTALL arrives in core0. */
    unsigned v=__atomic_load_n(&transfer.phase,__ATOMIC_ACQUIRE);
    while((v&255)!=T_NONE && (v&255)!=T_COMMIT) {
        if(__atomic_compare_exchange_n(&transfer.phase,&v,v|T_STAGING_FAULT,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE)) {
            __atomic_store_n(&transfer.fault,UG_ERR_OVERFLOW,__ATOMIC_RELEASE); return;
        }
    }
}
static void release_transfer(void) {
    ug_store_pin(&store,transfer.handle,false);
    set_phase(T_NONE);
}
static uint8_t begin_commit(void) {
    /* The CAS is the point of no return: cancellation and COMMITTING share
     * one atomic word, so a cancellation arriving during the final CRC slice
     * cannot be lost between checking a flag and publishing COMMITTING. */
    unsigned expected=phase();
    uint8_t fault=__atomic_load_n(&transfer.fault,__ATOMIC_ACQUIRE);
    if(fault) { release_transfer(); return fault; }
    if(__atomic_compare_exchange_n(&transfer.phase,&expected,T_COMMIT,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE)) return UG_ERR_OK;
    uint8_t e=(expected&T_STAGING_FAULT)?UG_ERR_OVERFLOW:UG_ERR_CANCELLED;
    release_transfer(); return e;
}
void ug_storage_touch(uint32_t now) {
    if(phase()==T_GRANT && __atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE)<transfer.length) __atomic_store_n(&transfer.last,now,__ATOMIC_RELEASE);
}
uint8_t ug_storage_data_write(uint8_t byte,uint32_t now) {
    if(phase()==T_GRANT && transfer.streaming && __atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE)==transfer.length) {
        ug_storage_data_overflow();return UG_ERR_OVERFLOW;
    }
    if(ug_storage_grant()!=8 || transfer.direction) return UG_ERR_STATE;
    if(__atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE)==transfer.length) { ug_storage_data_overflow();return UG_ERR_OVERFLOW; }
    uint16_t done=__atomic_load_n(&transfer.done,__ATOMIC_RELAXED);
    transfer.buffers[transfer.streaming?transfer.buffer_index:0][done]=byte;
    /* Auto-commit may run immediately on core1: publish the completed byte,
     * never a reservation for a byte that core0 has not stored yet. */
    __atomic_store_n(&transfer.done,(uint16_t)(done+1),__ATOMIC_RELEASE);
    __atomic_store_n(&transfer.last,now,__ATOMIC_RELEASE);return 0;
}
uint8_t ug_storage_data_read(uint8_t *byte,uint32_t now) {
    if(ug_storage_grant()!=16 || !transfer.direction) return UG_ERR_STATE;
    if(__atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE)==transfer.length) { __atomic_store_n(&transfer.fault,UG_ERR_OVERFLOW,__ATOMIC_RELEASE); return UG_ERR_UNDERFLOW; }
    *byte=transfer.buffers[1][__atomic_fetch_add(&transfer.done,1,__ATOMIC_ACQ_REL)]; __atomic_store_n(&transfer.last,now,__ATOMIC_RELEASE); return 0;
}
/* Three SRAM snapshots: published, held by core0, and writer's spare.
 * Ownership is exchanged in one atomic word. No PSRAM or wait for core1
 * is possible in the ISA latch/read paths. */
typedef struct {
    uint8_t summary[64], voice[UG_LANES][20], fx[UG_LANES][16];
} ug_snapshot;
static ug_snapshot snapshots[3];
static unsigned snap_owners; /* bits0..1=published, bits2..3=held */
static uint32_t snap_seq;
static uint64_t output_frames;
static uint32_t last_frames, last_underruns;
static void make_snapshot(ug_snapshot *s) {
    memset(s,0,sizeof(*s));uint8_t *r=s->summary;
    ug_put32(r,++snap_seq);memcpy(r+4,&store.session,8);memcpy(r+12,&output_frames,8);
    ug_put32(r+46,__atomic_load_n(stats+9,__ATOMIC_RELAXED));r[50]=audio_error;
    put16(r+42,mixer.peaks[0]);put16(r+44,mixer.peaks[1]);
    if(foreground.state) {
        put16(r+20,foreground.id);r[24]=foreground.state;r[25]=foreground.kind;
        put16(r+26,foreground.kind==2?foreground.logical_channels:foreground.channels);put16(r+28,foreground.handle);
        ug_put32(r+32,foreground.kind==4?(uint32_t)stream.position:foreground.kind==2?0:foreground.state==3?foreground.pcm.frames:
                 (uint32_t)(mixer.lanes[foreground.voice[0]].phase>>32));
        if(foreground.kind==2) { put16(r+36,tracker.state.order);r[38]=tracker.state.row;r[39]=tracker.state.tick;r[40]=tracker.state.speed;r[41]=tracker.state.bpm; }
    }
    for(unsigned v=0;v<UG_LANES;v++) {
        uint8_t *rec=s->voice[v];put16(rec,(uint16_t)v);put16(rec+6,UINT16_MAX);rec[16]=127;
    }
    unsigned voices=0,instances=0;bool counted[UG_LANES]={0};
    for(unsigned n=0;n<=UG_LANES+4;n++) {
        const ug_instance *in=!n?&foreground:n<=UG_LANES?&fx[n-1]:&legacy_fx[n-UG_LANES-1];
        if(!in->active) continue;
        for(unsigned c=0;c<in->channels;c++) {
            unsigned v=in->voice[c];const ug_lane *l=&mixer.lanes[v];uint8_t *rec=s->voice[v];
            put16(rec+2,in->id);put16(rec+4,in->handle);put16(rec+6,n?UINT16_MAX:(uint16_t)(in->kind==2?in->music_channel[c]:c));
            ug_put32(rec+8,(uint32_t)(l->phase>>32));put16(rec+12,mixer.lane_peaks[v]);
            rec[17]=in->gain;rec[18]=in->pan;rec[19]=8|((in->kind==4?!in->paused && !stream.buffering && !stream.error:l->active)?1:0)|(n?2:0)|(in->paused?4:0);
            if(!n && in->kind==2) {
                const ug_mod_channel *mc=&tracker.state.channel[in->music_channel[c]];put16(rec+14,mc->period);
                rec[16]=mc->note;rec[17]=mc->mix_volume;rec[18]=mc->pan;
            }
            if(!counted[v]) { ++voices;counted[v]=true; }
        }
        if(n) {
            uint8_t *rec=s->fx[instances++];put16(rec,in->id);put16(rec+2,in->channels);
            put16(rec+4,in->handle);rec[6]=in->paused?2:1;rec[7]=in->channels;
            ug_put32(rec+8,(uint32_t)(mixer.lanes[in->voice[0]].phase>>32));
            rec[12]=in->gain;rec[13]=in->pan;rec[14]=in->priority;rec[15]=(in->legacy?1:0)|(!in->repeats?2:0);
        }
    }
    put16(r+52,(uint16_t)voices);put16(r+54,(uint16_t)instances);
    if(phase()!=T_NONE) { ug_put32(r+56,transfer.token);put16(r+60,__atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE));put16(r+62,transfer.length); }
}
void ug_storage_audio(uint32_t frames,uint32_t underruns) {
    output_frames+=(uint32_t)(frames-last_frames);last_frames=frames;
    ug_stat_add(9,(uint32_t)(underruns-last_underruns));last_underruns=underruns;
}
void ug_storage_snap_init(void) {
    snap_seq=0;snap_owners=4;
    for(unsigned i=0;i<3;i++) make_snapshot(&snapshots[i]);
}
void ug_storage_latch(void) {
    unsigned v=__atomic_load_n(&snap_owners,__ATOMIC_ACQUIRE),n;
    do { n=(v&3)|((v&3)<<2); }
    while(!__atomic_compare_exchange_n(&snap_owners,&v,n,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE));
}
static const ug_snapshot *held_snapshot(void) {
    return &snapshots[(__atomic_load_n(&snap_owners,__ATOMIC_ACQUIRE)>>2)&3];
}
uint8_t ug_storage_snap_byte(unsigned i) { return i<64?held_snapshot()->summary[i]:255; }
void ug_storage_snapshot(uint8_t out[64]) { memcpy(out,held_snapshot()->summary,64); }
static uint8_t snapshot_page(uint8_t op,const uint8_t *q,uint8_t *r,uint8_t *len) {
    const ug_snapshot *s=held_snapshot();
    if(memcmp(q,s->summary+4,8) || ug_get32(q+8)!=ug_get32(s->summary)) return UG_ERR_STATE;
    bool voice=op==UG_OP_VOICE_STATUS;
    unsigned total=voice?UG_LANES:get16(s->summary+54),first=get16(q+12),count=get16(q+14),size=voice?20:16;
    if(!count) return UG_ERR_BAD_ARGUMENT;
    if(first>total) return UG_ERR_RANGE;
    if(count>108/size) count=108/size;
    if(count>total-first) count=total-first;
    memcpy(r,q,14);put16(r+14,(uint16_t)count);put16(r+16,(uint16_t)total);put16(r+18,(uint16_t)size);
    if(count) memcpy(r+20,voice?s->voice[first]:s->fx[first],count*size);
    *len=(uint8_t)(20+count*size);return 0;
}
static void publish_snapshot(void) {
    unsigned v=__atomic_load_n(&snap_owners,__ATOMIC_ACQUIRE),pub=v&3,held=(v>>2)&3;
    unsigned spare=pub==held?(pub+1)%3:3-pub-held;
    make_snapshot(&snapshots[spare]);
    while(!__atomic_compare_exchange_n(&snap_owners,&v,(v&12)|spare,false,__ATOMIC_RELEASE,__ATOMIC_ACQUIRE)) {}
}
static uint8_t commit_step(void) {
    ug_object_t *o=ug_store_find(&store,transfer.handle);
    uint32_t start=time_us_32();
    unsigned n=transfer.length-transfer.cursor;if(n>256)n=256;
    uint32_t offset=transfer.offset+transfer.cursor;
    if(transfer.streaming) {
        offset=(stream.write_offset+transfer.cursor)%stream.capacity;
        if(n>stream.capacity-offset)n=stream.capacity-offset;
    }
    if(!o || ug_psram_write(ps,o->offset+offset,
        transfer.buffers[transfer.streaming?transfer.buffer_index:0]+transfer.cursor,n)) {
        if(o)o->state=2;
        if(transfer.streaming)stream.error=UG_ERR_PSRAM;
        ug_stat_add(10,1);release_transfer();return UG_ERR_PSRAM;
    }
    uint32_t elapsed=time_us_32()-start;if(elapsed>ug_spi_slice_max_us)ug_spi_slice_max_us=elapsed;
    transfer.cursor+=n;
    if(transfer.cursor==transfer.length) {
        if(transfer.streaming)ug_stream_publish(&stream,transfer.length);
        else {
            uint32_t end=transfer.offset+transfer.length;
            if(end>o->uploaded)o->uploaded=end;
        }
        ug_stat_add(2,transfer.length);ug_stat_add(4,1);release_transfer();
    }
    return 0;
}
bool ug_storage_abort(uint32_t now) {
    transfer.cancelled_command=false;transfer.stream_failure=0;
    if(phase()==T_COMMIT) { uint8_t e=commit_step(); if(e) ug_minimal_error(e); if(phase()==T_COMMIT) return false; }
    else if(phase()!=T_NONE) release_transfer();
    if(sealing.active) { ug_store_aux(&store,sealing.handle,0);ug_store_pin(&store,sealing.handle,false); __atomic_store_n(&sealing.active,false,__ATOMIC_RELEASE); }
    ug_storage_cancel(now); return true;
}
void ug_storage_gs_reset(bool cold,uint32_t now) {
    /* A reset during COMMITTING is deferred by the frame cancellation
     * path. Cold reset owns the explicit destructive store operation. */
    if(!ug_storage_abort(now)) return;
    stop_all_playback(); ug_store_reset(&store);ug_legacy_reset(cold); transfer.next_token=1; boot();
    if(cold && ps && ps->up) {
        ug_memory_start(&job,ps,false,0,now); running=gs_job=true;
        __atomic_store_n(&busy,1,__ATOMIC_RELEASE);
        ug_minimal_ready(2,store.session);
    }
}
void ug_storage_tick(uint32_t now) {
    if(__atomic_fetch_and(&transfer.phase,~T_CANCEL_REQUESTED,__ATOMIC_ACQ_REL)&T_CANCEL_REQUESTED) {
        /* A1 cancels only transfer staging. SEAL and MEM_TEST belong to the
         * frame and are aborted only by the cooperative transport-reset path.
         * A cancelled pending READ_BEGIN must return CANCELLED, not restart. */
        unsigned p=phase();
        if(p!=T_NONE && p!=T_COMMIT) {
            transfer.cancelled_command=p==T_PREP || p==T_CHECK || transfer.streaming;
            release_transfer();
        }
    }
    /* core1 sampled now before core0 may acknowledge BEGIN or move data.
     * A newer last must not wrap this subtraction into a multi-minute idle
     * interval and revoke a live grant. Both the 5s deadline and dispatcher
     * service intervals are below half the 32-bit timer period. */
    if(phase()==T_GRANT) {
        uint32_t idle=now-__atomic_load_n(&transfer.last,__ATOMIC_ACQUIRE);
        if(idle>=5000000 && idle<UINT32_C(0x80000000)) {
            if(transfer.streaming)transfer.stream_failure=UG_ERR_TIMEOUT;
            release_transfer(); ug_stat_add(8,1); ug_minimal_error(UG_ERR_TIMEOUT);
        }
    }
    if(gs_job) {
        ug_memory_step(&job,now);
        if(!job.active) { running=gs_job=false; memory_error=job.status; prepare_mixer(); __atomic_store_n(&busy,0,__ATOMIC_RELEASE); boot(); }
    }
    publish_snapshot();
}
static void boot(void) { ug_minimal_ready(audio_error?3:memory_error?1:0,store.session); }
void ug_storage_bind(ug_psram_t *p,uint64_t session) {
    stream_handle=0;stream_closing=false;memset(&stream,0,sizeof(stream));
    ps=p; ug_store_init(&store,0,session); memset(&job,0,sizeof(job));
    ug_mixer_init(&mixer,(ug_mem_if){0});
    mixer_ready=audio_available=false; memset(&foreground,0,sizeof(foreground)); memset(fx,0,sizeof(fx));memset(legacy_fx,0,sizeof(legacy_fx));
    event_count=0; __atomic_store_n(&playback_busy,0,__ATOMIC_RELEASE);__atomic_store_n(&audio_active,0,__ATOMIC_RELEASE);
    memset(&tracker,0,sizeof(tracker)); memset(&pending_mod_info,0,sizeof(pending_mod_info));
    memset(&mod_object,0,sizeof(mod_object)); memset(mod_lane_trigger,0,sizeof(mod_lane_trigger));
    output_frames=0; last_frames=last_underruns=0;
    next_play_id=next_fx_id=1; music_master=fx_master=music_gain=fx_gain=64;
    running=false; gs_job=false; memory_error=0; audio_error=0;
    memset(&transfer,0,sizeof(transfer)); transfer.next_token=1; memset(&sealing,0,sizeof(sealing));
    ug_legacy_reset(true);ug_stats_clear();
    __atomic_store_n(&busy,1,__ATOMIC_RELEASE); ug_minimal_ready(2,session);
}
void ug_storage_publish(uint32_t physical,uint8_t error,uint8_t ae) {
    store.pool=physical; memory_error=error; audio_error=ae;
    audio_available=!ae; prepare_mixer();
    __atomic_store_n(&busy,0,__ATOMIC_RELEASE); boot();
}
bool ug_storage_busy(void) { return __atomic_load_n(&busy,__ATOMIC_ACQUIRE)!=0 || ug_storage_transfer() || __atomic_load_n(&sealing.active,__ATOMIC_ACQUIRE); }
bool ug_storage_audio_active(void) {
#ifdef UG_ADLIB
    if(ug_opl_busy()) return true;
#endif
    return __atomic_load_n(&audio_active,__ATOMIC_ACQUIRE)!=0; }
bool ug_storage_playback_busy(void) {
#ifdef UG_ADLIB
    if(ug_opl_busy()) return true;
#endif
    return __atomic_load_n(&playback_busy,__ATOMIC_ACQUIRE)!=0; }
void ug_storage_cancel(uint32_t now) {
    if(running) {
        ug_memory_cancel(&job,now); running=gs_job=false;
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
static int seal_pcm_read(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    ug_object_t *o=(ug_object_t *)ctx;
    if(!o || off>o->size || n>o->size-off || n>256) return -1;
    return ug_psram_read(ps,o->offset+off,dst,n);
}
static uint16_t alloc_id(uint16_t *next,const ug_instance *used,unsigned n) {
    for(uint32_t tries=0;tries<65535;tries++) {
        uint16_t id=*next; if(!id) id=1;
        *next=(uint16_t)(id+1); if(!*next) *next=1;
        bool busy_id=false;
        if(used) for(unsigned i=0;i<n;i++) if(used[i].active && used[i].id==id) busy_id=true;
        if(!busy_id) return id;
    }
    return 0;
}
static void project_playback(void) {
    if(!event_count) { pending_foreground=foreground; memcpy(pending_fx,fx,sizeof(fx)); }
}
static void update_playback_busy(void) {
    bool value=foreground.active;
    for(unsigned i=0;i<UG_LANES;i++) value=value || fx[i].active;
    for(unsigned i=0;i<4;i++) value=value || legacy_fx[i].active;
    __atomic_store_n(&audio_active,value,__ATOMIC_RELEASE);
    __atomic_store_n(&playback_busy,value || event_count,__ATOMIC_RELEASE);
}
static uint16_t instance_id(bool is_fx) {
    uint16_t *next=is_fx?&next_fx_id:&next_play_id;
    for(unsigned tries=0;tries<65535;tries++) {
        uint16_t id=alloc_id(next,is_fx?fx:&foreground,is_fx?UG_LANES:1);
        bool used=false;
        for(unsigned i=0;i<event_count;i++)
            if((is_fx?events[i].op==UG_OP_PLAY_FX:
                (events[i].op==UG_OP_PLAY_PCM || events[i].op==UG_OP_PLAY_MOD || events[i].op==UG_OP_STREAM_START)) &&
                events[i].instance.id==id) used=true;
        if(is_fx) for(unsigned i=0;i<4;i++) if(legacy_fx[i].active && legacy_fx[i].id==id) used=true;
        if(!used) return id;
    }
    return 0;
}
static uint8_t playable(const ug_object_t *o) {
    if(!o || o->state!=1) return UG_ERR_STATE;
    if((o->kind!=1 && o->kind!=2) || !o->pcm_valid) return UG_ERR_FORMAT;
    if(!mixer_ready) return UG_ERR_PSRAM;
    if((uint64_t)o->offset+o->pcm.data_offset+o->pcm.data_length>mixer.mem.size) return UG_ERR_FORMAT;
    return 0;
}
static uint64_t mod_step(uint16_t period) {
    return period?(((uint64_t)3546895u<<32)/(uint32_t)period)/48000u:1;
}
static uint32_t mod_sample_offset(unsigned sample) {
    uint32_t offset=mod_object.offset+tracker.engine.mod.info.sample_offset;
    for(unsigned i=0;i<sample && i<31;i++) offset+=tracker.engine.mod.info.samples[i].length;
    return offset;
}
static void mod_lane_sync(unsigned i,bool force) {
    ug_mod_channel *c=&tracker.engine.mod.channel[i]; ug_lane *l=music_lane(i);
    if(l->failed && !force) { tracker.state.error=1;tracker.state.playing=0;l->active=0;return; }
    bool retrigger=force || mod_lane_trigger[i]!=c->trigger;
    if(retrigger) tracker.state.dirty_note|=(1u<<i);
    if(l->gain!=c->mix_volume) tracker.state.dirty_volume|=(1u<<i);
    if(retrigger) {
        mod_lane_trigger[i]=c->trigger;
        if(!c->period || c->voice_sample>=31 ||
           c->sample_offset>=tracker.engine.mod.info.samples[c->voice_sample].length) {
            memset(l,0,sizeof(*l));return;
        }
        const ug_mod_sample *s=&tracker.engine.mod.info.samples[c->voice_sample];
        if(ug_lane_configure(&mixer,l,mod_sample_offset(c->voice_sample),s->length,s->loop_start,
              s->loop_start+s->loop_length,mod_step(c->period),c->mix_volume,c->pan,UG_FMT_S8,
              UG_LANE_MONO,s->loop_length!=0,0)) {
            l->active=0;tracker.state.error=2;tracker.state.playing=0;return;
        }
        /* Keep the original source/loop bounds. The intro and 9xx offset
         * affect only the initial phase, never the stored sample or loop. */
        l->phase=(uint64_t)c->sample_offset<<32;
    }
    l->step=mod_step(c->period);l->gain=c->mix_volume;l->pan=c->pan;
    if(tracker.state.paused || foreground.paused) l->active=0;
    mod_lane_trigger[i]=c->trigger;l->class_gain=music_gain;l->class_master=music_master;
    /* Calibrate a module to the four-channel mix before pan/accumulation.
     * Round channel count up to4/8/16/32: bounded shifts keep the sample path
     * free of division. Independent PCM/FX lanes retain unity headroom. */
    unsigned channels=tracker.engine.mod.info.channels;
    l->mix_shift=channels>16?3:channels>8?2:channels>4?1:0;
}
static void s3m_lane_sync(unsigned i,bool force);
static void mod_sync_all(bool force) { for(unsigned i=0;i<foreground.channels;i++) { if(tracker.s3m)s3m_lane_sync(i,force);else mod_lane_sync(i,force); } }
static void s3m_lane_sync(unsigned i,bool force) {
    unsigned ch=foreground.music_channel[i],side=foreground.side[i];
    ug_s3m_channel *c=&tracker.engine.s3m.channel[ch];const ug_s3m_sample *s=&c->sample;
    ug_lane *l=music_lane(i);
    if(l->failed && !force) { tracker.state.error=1;tracker.state.playing=0;l->active=0;return; }
    bool retrigger=force || mod_lane_trigger[i]!=c->trigger;
    if(retrigger)tracker.state.dirty_note|=1u<<ch;
    if(l->gain!=c->mix_volume)tracker.state.dirty_volume|=1u<<ch;
    if(retrigger) {
        mod_lane_trigger[i]=c->trigger;
        if(!c->period || !s->length || c->sample_offset>=s->length || (side && !(s->flags&2))) { memset(l,0,sizeof(*l));return; }
        unsigned bytes=(s->flags&4)?2:1;
        uint8_t fmt=tracker.engine.s3m.info.signed_samples?(bytes==2?UG_FMT_S16LE:UG_FMT_S8):(bytes==2?UG_FMT_U16LE:UG_FMT_U8);
        /* Each plane is contiguous. Configure its own source range and stride;
         * pan mode is independent and never doubles the source stride. */
        if(ug_lane_configure(&mixer,l,mod_object.offset+s->offset+side*s->length*bytes,s->length,
              s->loop_start,s->loop_end,ug_s3m_step(c),c->mix_volume,c->pan,fmt,UG_LANE_MONO,s->flags&1,0)) {
            l->active=0;tracker.state.error=2;tracker.state.playing=0;return;
        }
        l->mode=(s->flags&2)?(side?UG_LANE_RIGHT:UG_LANE_LEFT):UG_LANE_MONO;
        l->phase=(uint64_t)c->sample_offset<<32;
    }
    l->step=ug_s3m_step(c);l->gain=c->mix_volume;l->pan=c->pan;
    if(!c->period || tracker.state.paused || foreground.paused)l->active=0;
    l->class_gain=music_gain;l->class_master=music_master;
    unsigned channels=foreground.channels;l->mix_shift=channels>16?3:channels>8?2:channels>4?1:0;
}
static int instance_lanes(const ug_instance *in,bool is_fx) {
    const ug_pcm_info *p=&in->pcm;
    uint8_t fmt=p->sample_format==0?UG_FMT_U8:p->sample_format==1?UG_FMT_S8:UG_FMT_S16LE;
    for(unsigned side=0;side<p->channels;side++) {
        uint8_t mode=p->channels==1?UG_LANE_MONO:side?UG_LANE_RIGHT:UG_LANE_LEFT;
        if(p->sample_format==UG_PCM_FMT_IMA_ADPCM) {
            /* WAV IMA ADPCM: decoded on the lane; no internal loop exists. */
            if(ug_lane_set_ima(&mixer,in->voice[side],in->offset,p->data_length,p->frames,
                               p->block_align,p->samples_per_block,in->gain,in->pan,mode,(uint8_t)side)) return -1;
        } else if(ug_lane_set(&mixer,in->voice[side],in->offset,p->frames,p->loop_start,p->loop_end,
                       0,in->gain,in->pan,fmt,mode,(p->flags&1)!=0,(uint8_t)side)) return -1;
        ug_lane *l=&mixer.lanes[in->voice[side]];
        ug_lane_pcm_rate(l,p->rate,48000,in->repeats);
        l->class_gain=is_fx?fx_gain:music_gain;
        l->class_master=is_fx?fx_master:music_master;
    }
    if(p->channels==2 && ug_lane_share_cache(&mixer,in->voice[1],in->voice[0])) return -1;
    return 0;
}
static void drop_instance(ug_instance *in) {
    if(!in->active) {
        if(in->kind==4 && in->handle==stream_handle)stream_destroy();
        return;
    }
    for(unsigned i=0;i<in->channels;i++) {
        unsigned v=in->voice[i];
        bool overridden=in==&foreground && music_overridden(i);
        if(!overridden) mixer.lanes[v].active=0;
        /* Restore hidden music only when an overriding FX ends. A legacy
         * foreground itself must never resurrect stale hidden voices. */
        if(in!=&foreground && in->legacy && foreground.active && foreground.kind==2)
            for(unsigned c=0;c<foreground.channels;c++) if(music_overridden(c)) {
                unsigned first=music_index(foreground.music_channel[c],0);
                if(foreground.voice[first]==v)mixer.lanes[foreground.voice[c]]=*music_lane(c);
            }
    }
    if(in->kind==2) ug_tracker_stop(&tracker);
    ug_store_pin(&store,in->handle,false); in->active=0; in->paused=0; in->state=0;
    if(in->kind==4)stream_destroy();
}
static ug_instance new_instance(const ug_object_t *o,uint16_t id,
                                uint8_t gain,uint8_t pan,uint16_t repeats) {
    return (ug_instance){.id=id,.handle=o->handle,.active=1,.state=1,
        .gain=gain,.pan=pan,.channels=o->pcm.channels,.repeats=repeats,.kind=1,
        .offset=o->offset+o->pcm.data_offset,.pcm=o->pcm};
}
static void queue_event(uint8_t op,const uint8_t *q,unsigned n,const ug_instance *in) {
    /* PLAY already reserved its object pin. The queue owns that pin until
     * application transfers it to the live instance, or reset releases it. */
    ug_audio_event *e=&events[event_count++]; memset(e,0,sizeof(*e)); e->op=op;
    if(n) memcpy(e->q,q,n);
    if(in) e->instance=*in;
    update_playback_busy();
}
/* Reservation is a table of IDs, never a word-size-dependent bit mask. */
static bool uses_voice(const ug_instance *in,unsigned voice) {
    if(!in->active) return false;
    for(unsigned i=0;i<in->channels;i++) if(in->voice[i]==voice) return true;
    return false;
}
static bool intersects(const ug_instance *a,const ug_instance *b) {
    for(unsigned i=0;i<a->channels;i++) if(uses_voice(b,a->voice[i])) return true;
    return false;
}
static int fx_owner(unsigned voice) {
    for(unsigned i=0;i<UG_LANES;i++) if(uses_voice(&pending_fx[i],voice)) return (int)i;
    return -1;
}
static bool reserve_voices(ug_instance *in,bool foreground_replacement,uint16_t preferred,
                           bool steal,uint8_t priority) {
    unsigned chosen=0;
    if(preferred!=UINT16_MAX && preferred>=UG_LANES) return false;
    /* Resolve an explicit first voice before scanning the remaining pool.
     * The second stereo voice still prefers a free ID even if the preferred
     * first voice requires stealing. Validation never mutates live owners. */
    if(preferred!=UINT16_MAX) {
        for(unsigned i=0;i<4;i++) if(uses_voice(&legacy_fx[i],preferred)) return false;
        if(!foreground_replacement && uses_voice(&pending_foreground,preferred)) return false;
        int owner=fx_owner(preferred);
        if(owner>=0 && (!steal || pending_fx[owner].priority>=priority)) return false;
        in->voice[chosen++]=preferred;
    }
    for(unsigned pass=0;pass<(steal?2u:1u);pass++) {
        for(unsigned voice=0;voice<UG_LANES && chosen<in->channels;voice++) {
            bool duplicate=false;
            for(unsigned j=0;j<chosen;j++) if(in->voice[j]==voice) duplicate=true;
            if(duplicate) continue;
            bool reserved=false;for(unsigned i=0;i<4;i++) if(uses_voice(&legacy_fx[i],voice)) reserved=true;
            if(reserved || (!foreground_replacement && uses_voice(&pending_foreground,voice))) continue;
            int owner=fx_owner(voice);
            if(owner>=0 && (!pass || pending_fx[owner].priority>=priority)) continue;
            in->voice[chosen++]=(uint16_t)voice;
        }
        if(chosen==in->channels) return true;
    }
    return false;
}
static int start_foreground(ug_object_t *o,uint16_t repeats,uint8_t gain,uint8_t pan) {
    if(event_count==UG_AUDIO_EVENTS) return UG_ERR_BUSY;
    uint8_t rc=playable(o); if(rc) return rc;
    if((o->pcm.flags&1) && repeats!=1) return UG_ERR_BAD_ARGUMENT;
    project_playback();
    uint16_t id=instance_id(false); if(!id) return UG_ERR_NO_VOICE;
    rc=ug_store_pin(&store,o->handle,true); if(rc) return rc;
    ug_instance in=new_instance(o,id,gain,pan,repeats);
    if(!reserve_voices(&in,true,UINT16_MAX,false,0)) { ug_store_pin(&store,o->handle,false); return UG_ERR_NO_VOICE; }
    pending_foreground=in; queue_event(UG_OP_PLAY_PCM,NULL,0,&in);
    return 0;
}
static int start_mod(ug_object_t *o,uint8_t flags) {
    if((flags&~(UG_MOD_LOOP|UG_MOD_IGNORE_F00|UG_MOD_PAUSE_F00)) ||
       (flags&(UG_MOD_IGNORE_F00|UG_MOD_PAUSE_F00))==(UG_MOD_IGNORE_F00|UG_MOD_PAUSE_F00)) return UG_ERR_BAD_ARGUMENT;
    if(event_count==UG_AUDIO_EVENTS) return UG_ERR_BUSY;
    for(unsigned i=0;i<event_count;i++) if(events[i].op==UG_OP_PLAY_MOD) return UG_ERR_BUSY;
    if(!o) return UG_ERR_HANDLE;
    if(o->state!=1) return UG_ERR_STATE;
    if((o->kind!=3 && o->kind!=5) || !o->mod_valid) return UG_ERR_FORMAT;
    if(o->kind==5 && (flags&~UG_MOD_LOOP))return UG_ERR_BAD_ARGUMENT;
    if(!mixer_ready) return UG_ERR_PSRAM;
    int parsed=0;
    if(o->kind==5) {
        for(unsigned off=0;off<sizeof(pending_s3m_info);) {
            unsigned n=sizeof(pending_s3m_info)-off;if(n>256)n=256;
            if(ug_psram_read(ps,o->aux_offset+off,(uint8_t *)&pending_s3m_info+off,n)) { parsed=-2;break; }off+=n;
        }
    } else parsed=ug_mod_parse(&pending_mod_info,mod_object_read,o,o->size);
    if(parsed) { if(parsed==-2)ug_stat_add(10,1);return parsed==-2?UG_ERR_PSRAM:UG_ERR_FORMAT; }
    project_playback();
    uint16_t id=instance_id(false);if(!id)return UG_ERR_NO_VOICE;
    uint8_t rc=ug_store_pin(&store,o->handle,true);if(rc)return rc;
    ug_instance in={.id=id,.handle=o->handle,.active=1,.state=1,.channels=pending_mod_info.channels,.kind=2,.flags=flags,
                    .gain=64,.mod_song_length=pending_mod_info.song_length};
    in.s3m=o->kind==5;
    in.logical_channels=in.s3m?pending_s3m_info.channels:pending_mod_info.channels;
    if(in.s3m) {
        in.channels=0;in.mod_song_length=pending_s3m_info.orders;
        for(unsigned side=0;side<2;side++)for(unsigned ch=0;ch<in.logical_channels;ch++) {
            uint32_t mask=side?pending_s3m_info.stereo:pending_s3m_info.enabled;
            if(mask&(1u<<ch)) {
                if(in.channels==UG_LANES) { ug_store_pin(&store,o->handle,false);return UG_ERR_NO_VOICE; }
                in.music_channel[in.channels]=ch;in.side[in.channels++]=side;
            }
        }
    } else for(unsigned ch=0;ch<in.channels;ch++)in.music_channel[ch]=ch;
    if(!reserve_voices(&in,true,UINT16_MAX,false,0)) { ug_store_pin(&store,o->handle,false); return UG_ERR_NO_VOICE; }
    pending_foreground=in;queue_event(UG_OP_PLAY_MOD,NULL,0,&in);return 0;
}
static int start_fx(ug_object_t *o,uint16_t preferred,uint8_t priority,uint8_t gain,uint8_t pan,uint8_t flags,uint16_t *id_out,uint16_t *count_out) {
    if(event_count==UG_AUDIO_EVENTS) return UG_ERR_BUSY;
    uint8_t rc=playable(o); if(rc) return rc;
    if(gain>64 || priority==0 || priority==255 || (flags&~3u)) return UG_ERR_BAD_ARGUMENT;
    if(preferred!=UINT16_MAX && preferred>=UG_LANES) return UG_ERR_RANGE;
    if((flags&2) && (o->pcm.flags&1)) return UG_ERR_BAD_ARGUMENT;
    project_playback();
    ug_instance in=new_instance(o,0,gain,pan,(flags&2)?0:1);
    if(!reserve_voices(&in,false,preferred,(flags&1)!=0,priority)) return UG_ERR_NO_VOICE;
    int slot=-1;
    for(unsigned i=0;i<UG_LANES;i++) if(!pending_fx[i].active || intersects(&in,&pending_fx[i])) { slot=(int)i;break; }
    if(slot<0) return UG_ERR_NO_VOICE;
    uint16_t id=instance_id(true); if(!id) return UG_ERR_NO_VOICE;
    rc=ug_store_pin(&store,o->handle,true); if(rc) return rc;
    in.id=id;in.priority=priority;in.flags=flags;
    for(unsigned i=0;i<UG_LANES;i++) if(intersects(&in,&pending_fx[i])) pending_fx[i].active=0;
    pending_fx[slot]=in;queue_event(UG_OP_PLAY_FX,NULL,0,&in);
    *id_out=id;*count_out=in.channels;return 0;
}
static bool any_playing(void) {
    if(foreground.active && !foreground.paused) return true;
    for(unsigned i=0;i<UG_LANES;i++) if(fx[i].active && !fx[i].paused) return true;
    for(unsigned i=0;i<4;i++) if(legacy_fx[i].active && !legacy_fx[i].paused) return true;
    return false;
}
static void stop_all_playback(void) {
    for(unsigned i=0;i<event_count;i++)
        if(events[i].op==UG_OP_PLAY_PCM || events[i].op==UG_OP_PLAY_MOD || events[i].op==UG_OP_PLAY_FX || events[i].op==UG_OP_STREAM_START) ug_store_pin(&store,events[i].instance.handle,false);
    event_count=0;
    for(unsigned i=0;i<4;i++) drop_instance(&legacy_fx[i]);
    drop_instance(&foreground);
    for(unsigned i=0;i<UG_LANES;i++) drop_instance(&fx[i]);
    memset(&foreground,0,sizeof(foreground)); memset(fx,0,sizeof(fx));
    stream_destroy();update_playback_busy();
}
static void control_instance(ug_instance *in,uint8_t action) {
    if(action==0) { drop_instance(in); return; }
    in->paused=action==1; in->state=in->paused?2:1;
    if(in->kind==2) tracker.state.paused=in->paused;
    if(in->kind==4)return;
    for(unsigned channel=0;channel<in->channels;channel++) {
        ug_lane *l=in->kind==2?music_lane(channel):&mixer.lanes[in->voice[channel]];
        l->active=!in->paused && l->len_samples && !l->ended && !l->failed;
    }
}
static void sync_mod_pause(void) {
    if(foreground.active && foreground.kind==2 && tracker.state.paused) {
        foreground.paused=1;foreground.state=2;
        for(unsigned lane=0;lane<foreground.channels;lane++) music_lane(lane)->active=0;
    }
}
static void apply_audio_events(void) {
    for(unsigned index=0;index<event_count;index++) {
        const ug_audio_event *e=&events[index];
        if(e->op==UG_OP_STREAM_START) {
            /* Old foreground can only be a different object: START is one-shot. */
            drop_instance(&foreground);foreground=e->instance;
            instance_lanes(&foreground,false);
            for(unsigned ch=0;ch<foreground.channels;ch++)mixer.lanes[foreground.voice[ch]].active=0;
        } else if(e->op==UG_OP_STREAM_CLOSE) {
            if(foreground.kind==4 && foreground.handle==stream_handle) {
                drop_instance(&foreground);memset(&foreground,0,sizeof(foreground));
            } else stream_destroy();
        } else if(e->op==UG_OP_PLAY_PCM) {
            drop_instance(&foreground); foreground=e->instance;
            if(instance_lanes(&foreground,false)) { drop_instance(&foreground); foreground.state=4; audio_error=UG_ERR_FORMAT; }
        } else if(e->op==UG_OP_PLAY_MOD) {
            drop_instance(&foreground); foreground=e->instance;
            ug_object_t *o=ug_store_find(&store,foreground.handle);
            if(!o) { foreground.active=0;foreground.state=4;audio_error=UG_ERR_HANDLE;continue; }
            mod_object.offset=o->offset;mod_object.size=o->size;
            if(foreground.s3m) {
                s3m_object.offset=o->aux_offset;s3m_object.size=o->aux_reserved;
                ug_tracker_start_s3m(&tracker,&pending_s3m_info,s3m_player_read,NULL,foreground.flags);
            } else ug_tracker_start_mod(&tracker,&pending_mod_info,mod_player_read,&mod_object,foreground.flags,legacy_f00);
            memset(mod_lane_trigger,0,sizeof(mod_lane_trigger));
            for(unsigned lane=0;lane<foreground.channels;lane++)music_lane(lane)->active=0;
            mod_sync_all(true);
            sync_mod_pause();
        } else if(e->op==UG_OP_SEEK_MOD) {
            if(ug_tracker_seek(&tracker,get16(e->q+2),e->q[4])) tracker.state.playing=0;
            mod_sync_all(true);
            sync_mod_pause();
        } else if(e->op==UG_OP_SET_TEMPO) {
            ug_tracker_tempo(&tracker,e->q[0],e->q[1]);
        } else if(e->op==UG_OP_SET_PAN) {
            unsigned channel=get16(e->q);ug_tracker_pan(&tracker,channel,e->q[2]);mod_sync_all(false);
        } else if(e->op==UG_OP_PLAY_FX) {
            int slot=-1;
            for(unsigned i=0;i<UG_LANES;i++) if(fx[i].active && intersects(&fx[i],&e->instance)) drop_instance(&fx[i]);
            for(unsigned i=0;i<UG_LANES;i++) if(!fx[i].active) { slot=(int)i; break; }
            if(slot>=0) {
                fx[slot]=e->instance;
                if(instance_lanes(&fx[slot],true)) { drop_instance(&fx[slot]); audio_error=UG_ERR_FORMAT; }
            } else { ug_store_pin(&store,e->instance.handle,false); audio_error=UG_ERR_NO_VOICE; }
        } else if(e->op==UG_OP_CONTROL) control_instance(&foreground,e->q[2]);
        else if(e->op==UG_OP_CONTROL_FX) {
            for(unsigned i=0;i<UG_LANES;i++) if(fx[i].active && fx[i].id==get16(e->q)) control_instance(&fx[i],e->q[2]);
        } else if(e->op==UG_OP_STOP_FX) {
            uint16_t id=get16(e->q);
            for(unsigned i=0;i<UG_LANES;i++) if(fx[i].active && (!id || fx[i].id==id)) drop_instance(&fx[i]);
        } else if(e->op==UG_OP_SET_MIX) {
            music_master=e->q[0]; fx_master=e->q[1]; music_gain=e->q[2]; fx_gain=e->q[3];
            for(unsigned n=0;n<=UG_LANES+4;n++) {
                const ug_instance *in=!n?&foreground:n<=UG_LANES?&fx[n-1]:&legacy_fx[n-UG_LANES-1];
                if(in->active) for(unsigned c=0;c<in->channels;c++) {
                    ug_lane *l=in->kind==2?music_lane(c):&mixer.lanes[in->voice[c]];
                    l->class_gain=n?fx_gain:music_gain;l->class_master=n?fx_master:music_master;
                }
            }
        }
    }
    event_count=0; update_playback_busy();
}
static uint32_t mainvol_q15(void) {
    uint32_t percent=__atomic_load_n(&main_volume,__ATOMIC_ACQUIRE);
    if(percent>100) percent=100;
    uint32_t normalized=percent*256u/100u;
    uint32_t squared=normalized*normalized>>8;
    uint32_t cubed=squared*normalized>>8;
    return cubed*128u; /* the existing 20.12 taper converted to Q15 */
}
bool ug_storage_render(int16_t *out,uint32_t frames) {
    if(!out || frames>128) return false;
    memset(out,0,(size_t)frames*2*sizeof(*out));
#ifndef UG_ADLIB
    if(!mixer_ready) return false;
#endif
    uint32_t clips=mixer.stats.clips, errors=mixer.stats.fetch_errors, started=time_us_32();
#ifdef UG_ADLIB
    mixer.fm=ug_opl_render(frames);
#endif
    apply_audio_events();
    mixer.vol_q15=(int32_t)mainvol_q15();
    if(foreground.active && foreground.kind==2 && tracker.state.playing && !tracker.state.paused) {
        while(legacy_ticks) { ug_tracker_tick(&tracker);--legacy_ticks; }
        mod_sync_all(false);
    }
    if(foreground.active && foreground.kind==2 && tracker.state.playing && !tracker.state.paused && legacy_automatic) {
        uint32_t done=0;
        while(done<frames) {
            uint32_t to_tick=ug_tracker_frames_to_tick(&tracker);
            uint32_t take=frames-done;if(take>to_tick)take=to_tick;
            if(take) { advance_hidden(take);ug_mixer_render(&mixer,out+done*2,take);ug_tracker_advance_frames(&tracker,take);done+=take; }
            mod_sync_all(false);
            sync_mod_pause();
            if(!tracker.state.playing || tracker.state.paused) {
                for(unsigned lane=0;lane<foreground.channels;lane++) music_lane(lane)->active=0;
                if(done<frames) ug_mixer_render(&mixer,out+done*2,frames-done);
                done=frames;
            }
        }
    } else {
        if(foreground.active && !foreground.paused && foreground.kind==2)
            advance_hidden(frames);
        if(foreground.active && foreground.kind==4 && !foreground.paused) {
            uint8_t previous_error=stream.error;
            bool ended=ug_stream_render(&stream,mixer.mem,stream_samples,frames);
            if(!previous_error && stream.error)ug_stat_add(10,1);
            for(unsigned ch=0;ch<foreground.channels;ch++) {
                ug_lane *l=&mixer.lanes[foreground.voice[ch]];
                l->phase=((uint64_t)(uint32_t)stream.position<<32)|stream.fraction;
            }
            uint16_t voices[2]={foreground.voice[0],foreground.channels==2?foreground.voice[1]:UINT16_MAX};
            ug_mixer_render_stream(&mixer,out,frames,stream_samples,voices);
            if(ended || stream.error) {
                ug_store_pin(&store,foreground.handle,false);foreground.active=0;
                foreground.state=stream.error?4:3;
                if(stream.error)audio_error=stream.error;
            }
        } else ug_mixer_render(&mixer,out,frames);
    }
    ug_stat_add(10,mixer.stats.fetch_errors-errors);
    bool failed=false;
    for(unsigned which=0;which<=UG_LANES+4;which++) {
        ug_instance *in=!which?&foreground:which<=UG_LANES?&fx[which-1]:&legacy_fx[which-UG_LANES-1];
        if(in->kind==4)continue;
        if(!in->active || (in->paused && !(in->kind==2 && tracker.state.error))) continue;
        unsigned first=in->voice[0];
        bool fault=false;
        for(unsigned c=0;c<in->channels;c++)
            if((in->kind==2?music_lane(c):&mixer.lanes[in->voice[c]])->failed) fault=true;
        if(in->kind==2 && tracker.state.error) fault=true;
        bool ended=in->kind==2?!tracker.state.playing:!mixer.lanes[first].active;
        if(fault || ended) {
            uint8_t error=in->kind==2 && tracker.state.error==2?UG_ERR_FORMAT:UG_ERR_PSRAM;
            drop_instance(in);
            if(!which) foreground.state=fault?4:3;
            if(fault) { failed=true; audio_error=error; }
        }
    }
    if(failed) {
        memset(out,0,(size_t)frames*2*sizeof(*out));
        /* A fault silences this quantum, so its speculative output must not
         * inflate clipping or output peaks. Restart the measurement window. */
        mixer.stats.clips=clips; mixer.peak_frames=0;
        memset(mixer.peaks,0,sizeof(mixer.peaks)); memset(mixer.peak_current,0,sizeof(mixer.peak_current));
        memset(mixer.lane_peaks,0,sizeof(mixer.lane_peaks)); memset(mixer.lane_peak_current,0,sizeof(mixer.lane_peak_current));
    } else ug_stat_add(15,mixer.stats.clips-clips);
    update_playback_busy(); publish_snapshot();
    ug_stat_max(11,time_us_32()-started);
#ifdef UG_ADLIB
    mixer.fm=NULL;
    return any_playing() || ug_opl_busy();
#else
    return any_playing();
#endif
}
void ug_storage_main_volume(uint8_t percent) {
    if(percent>100) percent=100;
    __atomic_store_n(&main_volume,percent,__ATOMIC_RELEASE);
}
bool ug_storage_command(uint8_t op,const uint8_t *q,uint8_t n,uint8_t *r,
                        uint8_t *len,uint8_t *status,uint32_t now) {
    *len=*status=UG_ERR_OK;
    if(transfer.stream_failure) {
        *status=transfer.stream_failure;transfer.stream_failure=0;return true;
    }
    if(transfer.streaming && phase()==T_GRANT && op==UG_OP_STREAM_FEED) {
        uint8_t fault=__atomic_load_n(&transfer.fault,__ATOMIC_ACQUIRE);
        if(fault) { release_transfer();*status=fault;return true; }
        if(__atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE)!=transfer.length)return false;
        transfer.cursor=0;
        if(transfer.verified) { transfer.crc=UINT32_MAX;set_phase(T_CHECK); }
        else if((*status=begin_commit()))return true;
        return false;
    }
    if(transfer.cancelled_command) {
        transfer.cancelled_command=false; *status=UG_ERR_CANCELLED; return true;
    }
    if(phase()==T_CHECK) {
        uint8_t fault=__atomic_load_n(&transfer.fault,__ATOMIC_ACQUIRE);
        if(fault) { release_transfer(); *status=fault; return true; }
        /* Revoke the GS grant before CRC work and retain SRAM until the
         * check completes. Cancellation here still leaves PSRAM untouched. */
        unsigned k=transfer.length-transfer.cursor; if(k>256) k=256;
        uint32_t start=time_us_32();
        transfer.crc=crc_step(transfer.crc,transfer.buffers[transfer.streaming?transfer.buffer_index:0]+transfer.cursor,k);
        uint32_t elapsed=time_us_32()-start; if(elapsed>ug_spi_slice_max_us) ug_spi_slice_max_us=elapsed;
        transfer.cursor+=k;
        if(transfer.cursor<transfer.length) return false;
        if((transfer.crc^UINT32_MAX)!=transfer.expected_crc) {
            release_transfer(); *status=UG_ERR_CRC; return true;
        }
        transfer.cursor=0;
        if((*status=begin_commit())) return true;
        return false;
    }
    if(phase()==T_PREP) {
        ug_object_t *o=ug_store_find(&store,transfer.handle);
        uint32_t start=time_us_32();
        unsigned k=transfer.length-transfer.cursor; if(k>256) k=256;
        if(!o || ug_psram_read(ps,o->offset+transfer.offset+transfer.cursor,transfer.buffers[1]+transfer.cursor,k)) {
            release_transfer(); ug_stat_add(10,1); *status=UG_ERR_PSRAM; return true;
        }
        if(transfer.verified)
            transfer.expected_crc=crc_step(transfer.expected_crc,transfer.buffers[1]+transfer.cursor,k);
        uint32_t elapsed=time_us_32()-start; if(elapsed>ug_spi_slice_max_us) ug_spi_slice_max_us=elapsed;
        transfer.cursor+=k; if(transfer.cursor<transfer.length) return false;
        ug_put32(r,transfer.token); *len=4;
        if(transfer.verified) { transfer.expected_crc^=UINT32_MAX; ug_put32(r+4,transfer.expected_crc); *len=8; }
        set_phase(T_ACK); return true;
    }
    if(phase()==T_COMMIT) {
        *status=commit_step();
        if(phase()==T_COMMIT)return false;
        if(!*status && transfer.streaming) {
            ug_put32(r,stream.next_sequence);memcpy(r+4,&stream.published,8);*len=12;
        }
        return true;
    }
    if(sealing.active) {
        ug_object_t *o=ug_store_find(&store,sealing.handle);
        if(sealing.cursor<o->size) {
            unsigned k=o->size-sealing.cursor; if(k>256) k=256;
            uint32_t start=time_us_32();
            if(ug_psram_read(ps,o->offset+sealing.cursor,transfer.buffers[1],k)) {
                o->state=2; *status=UG_ERR_PSRAM; ug_stat_add(10,1);
            } else {
                sealing.crc=crc_step(sealing.crc,transfer.buffers[1],k); sealing.cursor+=k;
            }
            uint32_t elapsed=time_us_32()-start;
            if(elapsed>ug_spi_slice_max_us) ug_spi_slice_max_us=elapsed;
        }
        if(!*status && sealing.cursor<o->size) return false;
        if(!*status && o->kind==2) {
            if(!sealing.parser_started) {
                ug_wav_parser_init(&sealing.parser,o->size);
                sealing.parser_started=true;
            }
            ug_pcm_info pcm;
            int parsed=ug_wav_parser_step(&sealing.parser,seal_pcm_read,o,&pcm);
            if(parsed<0) {
                o->state=2; *status=parsed==-2?UG_ERR_PSRAM:UG_ERR_FORMAT;
                if(parsed==-2) ug_stat_add(10,1);
            }
            else if(parsed==0) return false;
            else { o->pcm=pcm; o->pcm_valid=1; }
        } else if(!*status && o->kind==3) {
            if(!sealing.parser_started) {
                ug_mod_parser_init(&sealing.mod_parser,&seal_mod_info,o->size);
                sealing.parser_started=true;
            }
            int rc=ug_mod_parser_step(&sealing.mod_parser,&seal_mod_info,mod_object_read,o);
            if(rc<0) {
                o->state=2;*status=rc==-2?UG_ERR_PSRAM:UG_ERR_FORMAT;
                if(rc==-2)ug_stat_add(10,1);
            }
            else if(!rc) return false;
            else { o->mod_valid=1;o->mod_channels=seal_mod_info.channels; }
        } else if(!*status && o->kind==5) {
            if(!sealing.parser_started) { s3m_seal_init(o);sealing.parser_started=true; }
            int rc=s3m_seal_step(o);
            if(!rc)return false;
            if(rc<0) { o->state=2;*status=(uint8_t)-rc; }
        }
        ug_seal_elapsed_us=time_us_32()-sealing.started;
        uint32_t actual=sealing.crc^UINT32_MAX;
        if(!*status && sealing.verify && actual!=sealing.expected) { o->state=2; *status=UG_ERR_CRC; }
        if(*status)ug_store_aux(&store,o->handle,0);
        if(!*status) { o->crc=actual; o->state=1; ug_put32(r,actual); *len=4; }
        ug_store_pin(&store,o->handle,false); __atomic_store_n(&sealing.active,false,__ATOMIC_RELEASE); return true;
    }
    if(running && !gs_job) {
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
        memory_error=job.status; prepare_mixer(); boot(); *status=job.status;
        if(op==UG_OP_MEM_TEST) { *len=14; result(r); }
        else if(!*status) { *len=8; memcpy(r,&store.session,8); }
        return true;
    }
    unsigned expected;
    switch(op) {
    case UG_OP_LEGACY_INFO: case UG_OP_CAPS: case UG_OP_MEM_INFO: case UG_OP_STATS: case UG_OP_CLEAR_STATS: case UG_OP_SNAPSHOT: expected=0; break;
    case UG_OP_STREAM_CREATE: expected=20;break;
    case UG_OP_STREAM_STATE: case UG_OP_STREAM_EOF: case UG_OP_STREAM_CLOSE: expected=2;break;
    case UG_OP_STREAM_START: expected=4;break;
    case UG_OP_STREAM_FEED:
        if(n<9) { *status=UG_ERR_LENGTH;return true; }
        expected=(q[8]&128)?13:9;break;
    case UG_OP_WRITE_BEGIN:
        if(n<9) { *status=UG_ERR_LENGTH; return true; }
        expected=(q[8]&128)?13:9; break;
    case UG_OP_READ_BEGIN: expected=9; break;
    case UG_OP_WRITE_END: case UG_OP_TRANSFER_CANCEL: expected=4; break;
    case UG_OP_READ_END: expected=(phase()!=T_NONE && transfer.verified)?8:4; break;
    case UG_OP_SEAL: expected=7; break;
    case UG_OP_PCM_CONFIG: expected=26; break;
    case UG_OP_PLAY_PCM: expected=6; break;
    case UG_OP_PLAY_MOD: expected=3; break;
    case UG_OP_SEEK_MOD: expected=5; break;
    case UG_OP_SET_TEMPO: expected=2; break;
    case UG_OP_SET_PAN: expected=3; break;
    case UG_OP_CONTROL: case UG_OP_CONTROL_FX: expected=3; break;
    case UG_OP_SET_MIX: expected=4; break;
    case UG_OP_PLAY_FX: expected=8; break;
    case UG_OP_STOP_FX: expected=2; break;
    case UG_OP_FX_STATUS: case UG_OP_VOICE_STATUS: expected=16; break;
    case UG_OP_MEM_TEST: expected=1; break;
    case UG_OP_RESET_STORE: case UG_OP_ALLOC: expected=5; break;
    case UG_OP_FREE: case UG_OP_OBJECT_INFO: case UG_OP_OBJECT_ENUM: expected=2; break;
    default: *status=UG_ERR_BAD_OPCODE; return true;
    }
    if(n!=expected) { *status=UG_ERR_LENGTH; return true; }
    if(op==UG_OP_CAPS) {
        if(ug_storage_transfer()) { *status=UG_ERR_BUSY; return true; }
        memset(r,0,44); *len=44;
        /* Musical GS dispatcher/LOAD and native formats share this renderer.
         * Capability means implemented; physical acceptance remains REAL_PENDING. */
        ug_put32(r,(230u|(ug_cfg.settings->UltraGS.bulkAlias!=0xffff?8u:0u)|
                    (ug_config_aliases(&ug_cfg)?512u:0u)|(mixer_ready?(1281u|UG_STREAM_FEATURE|UG_MOD_F00_POLICY_FEATURE):0u)));
#ifdef UG_ADLIB
        ug_put32(r,ug_get32(r)|UG_ADLIB_OPL2_FEATURE);
#endif
        if(mixer_ready) ug_put32(r+4,511u); /* RAW8/16, WAV, MOD4, 8CHN, FLT8, MOD 1..32, S3M, WAV IMA ADPCM */
        ug_put32(r+8,48000); put16(r+12,1024); put16(r+14,128); put16(r+16,128);
        put16(r+20,UG_LANES);put16(r+22,UG_LANES);put16(r+24,mixer_ready?UG_LANES:0);
        r[26]=1;r[27]=1;
        put16(r+28,ug_cfg.settings->UltraGS.basePort);put16(r+30,ug_cfg.settings->UltraGS.bulkAlias);
        ug_put32(r+32,8000);ug_put32(r+36,48000);r[40]=20;r[41]=16;put16(r+42,64);
        return true;
    }
    if(__atomic_load_n(&busy,__ATOMIC_ACQUIRE)) { *status=UG_ERR_BUSY; return true; }
    if(ug_storage_transfer() && op!=UG_OP_MEM_INFO && op!=UG_OP_OBJECT_INFO &&
       op!=UG_OP_WRITE_END && op!=UG_OP_READ_END && op!=UG_OP_TRANSFER_CANCEL &&
       op!=UG_OP_LEGACY_INFO && op!=UG_OP_STATS && op!=UG_OP_SNAPSHOT && op!=UG_OP_FX_STATUS && op!=UG_OP_VOICE_STATUS) { *status=UG_ERR_BUSY; return true; }
    if(ug_storage_transfer() && op==UG_OP_OBJECT_INFO && get16(q)!=transfer.handle) {
        *status=UG_ERR_BUSY; return true;
    }
    if(op==UG_OP_LEGACY_INFO) {
        uint8_t e=legacy_flush();if(e) { *status=e;return true; }
        legacy_info(r);*len=10;return true;
    }
    if(ug_legacy_loading() && (op==UG_OP_MEM_TEST || op==UG_OP_RESET_STORE)) { *status=UG_ERR_BUSY;return true; }
    if(op==UG_OP_STATS) { ug_stats_copy(r); *len=64; return true; }
    if(op==UG_OP_CLEAR_STATS) { ug_stats_clear(); return true; }
    if(op==UG_OP_SNAPSHOT) { ug_storage_latch();ug_storage_snapshot(r); *len=64; return true; }
    if(op==UG_OP_WRITE_BEGIN || op==UG_OP_READ_BEGIN) {
        uint8_t trans=q[8];
        if(trans&126) { *status=UG_ERR_BAD_ARGUMENT; return true; }
        if(!ug_minimal_gs_idle() && !(!(trans&1) && ug_legacy_loading())) { *status=UG_ERR_BUSY; return true; }
        if(ug_legacy_loading()) {
            if(trans&1) { *status=UG_ERR_BUSY;return true; }
            uint8_t e=legacy_flush();if(e) { *status=e;return true; }
        }
        ug_object_t *o=ug_store_find(&store,get16(q));
        uint32_t offset=ug_get32(q+2); uint16_t count=get16(q+6);
        if(!o) *status=UG_ERR_HANDLE;
        else if(!count || count>1024) *status=UG_ERR_LENGTH;
        else if(o->kind==UG_KIND_PCM_STREAM)*status=UG_ERR_STATE;
        else if(o->state==2 || (op==UG_OP_WRITE_BEGIN && o->state!=0)) *status=UG_ERR_STATE;
        else if(op==UG_OP_WRITE_BEGIN && o->pins && !legacy_pending(o->handle)) *status=UG_ERR_PINNED;
        else if(offset>o->size || count>o->size-offset) *status=UG_ERR_RANGE;
        else if(op==UG_OP_READ_BEGIN && (offset>o->uploaded || count>o->uploaded-offset)) *status=UG_ERR_RANGE;
        else if(op==UG_OP_WRITE_BEGIN && offset!=o->uploaded && !(o->kind==0 && offset<=o->uploaded && count<=o->uploaded-offset)) *status=UG_ERR_RANGE;
        else if(!transfer.next_token) *status=UG_ERR_OVERFLOW;
        else *status=ug_store_pin(&store,o->handle,true);
        if(*status) return true;
        transfer.streaming=0;
        transfer.handle=o->handle; transfer.offset=offset; transfer.length=count;
        __atomic_store_n(&transfer.done,0,__ATOMIC_RELAXED); transfer.cursor=0; __atomic_store_n(&transfer.fault,0,__ATOMIC_RELAXED); transfer.verified=trans>>7;
        transfer.transport=trans&1; transfer.direction=op==UG_OP_READ_BEGIN; transfer.token=transfer.next_token++;
        if(!transfer.direction) {
            transfer.expected_crc=transfer.verified?ug_get32(q+9):0;
            set_phase(T_ACK); ug_put32(r,transfer.token); *len=4; return true;
        }
        transfer.expected_crc=UINT32_MAX; set_phase(T_PREP); return false;
    }
    if(op==UG_OP_WRITE_END || op==UG_OP_READ_END || op==UG_OP_TRANSFER_CANCEL) {
        if(phase()==T_NONE || ug_get32(q)!=transfer.token) { *status=UG_ERR_HANDLE; return true; }
        if(op==UG_OP_TRANSFER_CANCEL) { release_transfer(); return true; }
        if(transfer.streaming || phase()!=T_GRANT || transfer.direction!=(op==UG_OP_READ_END)) { *status=UG_ERR_STATE; return true; }
        uint8_t fault=__atomic_load_n(&transfer.fault,__ATOMIC_ACQUIRE);
        if(fault) *status=fault;
        else if(__atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE)!=transfer.length) *status=UG_ERR_SHORT_TRANSFER;
        else if(transfer.verified && transfer.direction && ug_get32(q+4)!=transfer.expected_crc) *status=UG_ERR_CRC;
        if(*status || transfer.direction) {
            if(!*status) { ug_stat_add(3,transfer.length); ug_stat_add(5,1); }
            release_transfer(); return true;
        }
        transfer.cursor=0;
        if(transfer.verified) { transfer.crc=UINT32_MAX; set_phase(T_CHECK); }
        else if((*status=begin_commit())) return true;
        return false;
    }
    if(op==UG_OP_STREAM_CREATE) {
        uint32_t capacity=ug_get32(q+8),prefill=ug_get32(q+12),low=ug_get32(q+16);
        uint32_t rate=ug_get32(q);unsigned frame_bytes=q[4]*(q[5]/8);
        if(stream_handle)*status=UG_ERR_BUSY;
        else if(q[7])*status=UG_ERR_BAD_ARGUMENT;
        else if(rate<8000 || rate>48000 || (q[4]!=1 && q[4]!=2) ||
                (q[5]==8?q[6]>1:q[5]!=16 || q[6]!=2))*status=UG_ERR_FORMAT;
        else if(!capacity || !prefill || prefill>capacity || low>=prefill || ((capacity|prefill|low)&(frame_bytes-1)))*status=UG_ERR_BAD_ARGUMENT;
        else if(!mixer_ready)*status=memory_error?memory_error:UG_ERR_PSRAM;
        else {
            ug_object_t *o;*status=ug_store_reserve(&store,UG_KIND_PCM_STREAM,capacity,&o);
            if(!*status) {
                ug_stream_init(&stream,o->offset,capacity,prefill,low,rate,q[4],q[5],q[6]);stream_handle=o->handle;
                o->pcm=(ug_pcm_info){.rate=rate,.data_length=capacity,.frames=capacity/frame_bytes,.channels=q[4],.bits=q[5],.sample_format=q[6]};
                o->pcm_valid=1;o->pins=1;put16(r,o->handle);*len=2;
            }
        }
        return true;
    }
    if(op>=UG_OP_STREAM_STATE && op<=UG_OP_STREAM_CLOSE) {
        ug_object_t *o=ug_store_find(&store,get16(q));
        if(!o || o->handle!=stream_handle) { *status=UG_ERR_HANDLE;return true; }
        if(op==UG_OP_STREAM_STATE) {
            memset(r,0,UG_STREAM_STATE_LEN);put16(r,stream_handle);
            r[2]=stream.error?4:!stream.started?0:foreground.state==3?3:
                 foreground.paused?2:stream.buffering?5:1;
            r[3]=stream.eof | ((stream.buffering || ug_stream_fill(&stream)<=stream.low)?2:0) | (stream_closing?4:0);
            ug_put32(r+4,stream.capacity);ug_put32(r+8,stream.prefill);ug_put32(r+12,stream.low);
            ug_put32(r+16,ug_stream_fill(&stream));ug_put32(r+20,ug_stream_free(&stream));
            memcpy(r+24,&stream.published,8);memcpy(r+32,&stream.consumed,8);
            ug_put32(r+40,stream.next_sequence);ug_put32(r+44,stream.underruns);ug_put32(r+48,stream.rate);
            put16(r+52,stream.started?pending_foreground.kind==4?pending_foreground.id:foreground.id:0);
            r[54]=stream.channels;r[55]=stream.bits;r[56]=stream.error;ug_put32(r+58,stream.fraction);
            memcpy(r+62,&stream.position,8);*len=UG_STREAM_STATE_LEN;return true;
        }
        if(stream_closing) { *status=UG_ERR_STATE;return true; }
        if(op==UG_OP_STREAM_CLOSE) {
            if(event_count==UG_AUDIO_EVENTS)*status=UG_ERR_BUSY;
            else { project_playback();stream_closing=true;
                if(pending_foreground.kind==4)pending_foreground.active=0;
                queue_event(op,q,2,NULL);
            }
            return true;
        }
        if(stream.error) { *status=stream.error;return true; }
        if(op==UG_OP_STREAM_EOF) { stream.eof=1;return true; }
        if(op==UG_OP_STREAM_START) {
            if(stream.started)*status=UG_ERR_STATE;
            else if(q[2]>64)*status=UG_ERR_BAD_ARGUMENT;
            else if(event_count==UG_AUDIO_EVENTS)*status=UG_ERR_BUSY;
            else {
                project_playback();
                ug_instance in=new_instance(o,instance_id(false),q[2],q[3],1);in.kind=4;
                if(!reserve_voices(&in,true,UINT16_MAX,false,0))*status=UG_ERR_NO_VOICE;
                else {
                    ug_store_pin(&store,o->handle,true);pending_foreground=in;stream.started=1;
                    queue_event(op,NULL,0,&in);put16(r,in.id);*len=2;
                }
            }
            return true;
        }
        uint16_t count=get16(q+6);
        if(q[8]!=0 && q[8]!=128)*status=UG_ERR_BAD_ARGUMENT;
        else if(stream.eof)*status=UG_ERR_STATE;
        else if(!count || count>1024 || (count&(stream.frame_bytes-1)))*status=UG_ERR_LENGTH;
        else if(!stream.next_sequence || stream.published>UINT64_MAX-count/stream.frame_bytes)*status=UG_ERR_OVERFLOW;
        else if(ug_get32(q+2)!=stream.next_sequence)*status=UG_ERR_RANGE;
        else if(count>ug_stream_free(&stream))*status=UG_ERR_NO_MEMORY;
        else {
            transfer.streaming=1;transfer.token=0;transfer.buffer_index^=1;transfer.handle=o->handle;
            transfer.length=count;transfer.cursor=0;transfer.direction=transfer.transport=0;
            transfer.verified=q[8]>>7;transfer.expected_crc=transfer.verified?ug_get32(q+9):0;
            __atomic_store_n(&transfer.fault,0,__ATOMIC_RELAXED);__atomic_store_n(&transfer.done,0,__ATOMIC_RELAXED);
            __atomic_store_n(&transfer.last,now,__ATOMIC_RELEASE);ug_store_pin(&store,o->handle,true);
            set_phase(T_GRANT);return false;
        }
        return true;
    }
    if(op==UG_OP_PCM_CONFIG) {
        ug_object_t *o=ug_store_find(&store,get16(q));
        ug_pcm_info pcm;
        if(!o) *status=UG_ERR_HANDLE;
        else if(o->kind!=1) *status=UG_ERR_STATE;
        else if(o->state || o->pins || legacy_pending(o->handle)) *status=UG_ERR_STATE;
        else if(ug_pcm_raw_config(&pcm,o->size,q+2)) *status=UG_ERR_FORMAT;
        else { o->pcm=pcm; o->pcm_valid=1; }
        return true;
    }
    if(op==UG_OP_SEAL) {
        ug_object_t *o=ug_store_find(&store,get16(q));
        if(q[2]>1 || (!q[2] && ug_get32(q+3))) *status=UG_ERR_BAD_ARGUMENT;
        else if(!o) *status=UG_ERR_HANDLE;
        else if(legacy_pending(o->handle)) *status=UG_ERR_STATE;
        else if(o->kind>5 || o->kind==4) *status=UG_ERR_BAD_OPCODE;
        else if(o->state || o->uploaded!=o->size) *status=UG_ERR_STATE;
        else if(o->kind==1 && !o->pcm_valid) *status=UG_ERR_STATE;
        else if(o->pins) *status=UG_ERR_PINNED;
        else *status=ug_store_pin(&store,o->handle,true);
        if(*status) return true;
        __atomic_store_n(&sealing.active,true,__ATOMIC_RELEASE); sealing.handle=o->handle; sealing.cursor=0; sealing.crc=UINT32_MAX;
        sealing.verify=q[2]; sealing.expected=ug_get32(q+3); sealing.started=now;
        sealing.parser_started=false; return false;
    }
    if(op==UG_OP_PLAY_PCM) {
        ug_object_t *o=ug_store_find(&store,get16(q));
        uint16_t repeats=get16(q+2);
        if(q[4]>64) *status=UG_ERR_BAD_ARGUMENT;
        else if(!o) *status=UG_ERR_HANDLE;
        else *status=start_foreground(o,repeats,q[4],q[5]);
        if(!*status) { put16(r,pending_foreground.id); *len=2; }
        return true;
    }
    if(op==UG_OP_PLAY_MOD) {
        ug_object_t *o=ug_store_find(&store,get16(q));
        if(!o) *status=UG_ERR_HANDLE;
        else *status=start_mod(o,q[2]);
        if(!*status) { put16(r,pending_foreground.id);*len=2; }
        return true;
    }
    if(op==UG_OP_SEEK_MOD) {
        project_playback();
        if(!pending_foreground.active || pending_foreground.kind!=2 ||
           (get16(q) && get16(q)!=pending_foreground.id)) *status=UG_ERR_STATE;
        else if(q[4]>=64 || get16(q+2)>=pending_foreground.mod_song_length) *status=UG_ERR_RANGE;
        else if(event_count==UG_AUDIO_EVENTS) *status=UG_ERR_BUSY;
        else {
            /* The S3M terminator occupies an order-table slot but is not a
             * seek target. Read the immutable source, including for a queued
             * PLAY, so a rejected PLAY cannot change this validation state. */
            uint8_t order=0;
            ug_object_t *o=ug_store_find(&store,pending_foreground.handle);
            if(pending_foreground.s3m && (!o || mod_object_read(o,96u+get16(q+2),&order,1))) *status=UG_ERR_PSRAM;
            else if(pending_foreground.s3m && order==255) *status=UG_ERR_RANGE;
            else queue_event(op,q,5,NULL);
        }
        return true;
    }
    if(op==UG_OP_SET_TEMPO) {
        project_playback();
        if(q[0]<1 || (q[0]>31 && !pending_foreground.s3m) || q[1]<32) *status=UG_ERR_BAD_ARGUMENT;
        else if(!pending_foreground.active || pending_foreground.kind!=2) *status=UG_ERR_STATE;
        else if(event_count==UG_AUDIO_EVENTS) *status=UG_ERR_BUSY;
        else queue_event(op,q,2,NULL);
        return true;
    }
    if(op==UG_OP_SET_PAN) {
        project_playback();
        if(get16(q)>=32) *status=UG_ERR_RANGE;
        else if(!pending_foreground.active || pending_foreground.kind!=2) *status=UG_ERR_STATE;
        else if(event_count==UG_AUDIO_EVENTS) *status=UG_ERR_BUSY;
        else if(get16(q)>=pending_foreground.logical_channels) *status=UG_ERR_RANGE;
        else queue_event(op,q,3,NULL);
        return true;
    }
    if(op==UG_OP_CONTROL) {
        uint16_t id=get16(q); uint8_t action=q[2];
        project_playback();
        if(action>2) *status=UG_ERR_BAD_ARGUMENT;
        else if((!pending_foreground.active && !(action==0 && pending_foreground.kind==4 && stream_handle)) || (id && id!=pending_foreground.id)) *status=UG_ERR_STATE;
        else if(action==2 && !pending_foreground.paused) *status=UG_ERR_STATE;
        else if(event_count==UG_AUDIO_EVENTS) *status=UG_ERR_BUSY;
        else {
            pending_foreground.paused=action==1;
            if(!action) pending_foreground.active=0;
            queue_event(op,q,3,NULL);
        }
        return true;
    }
    if(op==UG_OP_SET_MIX) {
        if(q[0]>64 || q[1]>64 || q[2]>64 || q[3]>64) *status=UG_ERR_BAD_ARGUMENT;
        else if(event_count==UG_AUDIO_EVENTS) *status=UG_ERR_BUSY;
        else { project_playback(); queue_event(op,q,4,NULL); }
        return true;
    }
    if(op==UG_OP_PLAY_FX) {
        ug_object_t *o=ug_store_find(&store,get16(q)); uint16_t id=0,count=0;
        if(q[5]>64) *status=UG_ERR_BAD_ARGUMENT;
        else if(!o) *status=UG_ERR_HANDLE;
        else *status=start_fx(o,get16(q+2),q[4],q[5],q[6],q[7],&id,&count);
        if(!*status) { put16(r,id); put16(r+2,count); *len=4; }
        return true;
    }
    if(op==UG_OP_STOP_FX) {
        uint16_t id=get16(q); bool found=!id;
        project_playback();
        for(unsigned i=0;i<UG_LANES;i++) if(pending_fx[i].active && pending_fx[i].id==id) found=true;
        if(!found) *status=UG_ERR_HANDLE;
        else if(event_count==UG_AUDIO_EVENTS) *status=UG_ERR_BUSY;
        else {
            for(unsigned i=0;i<UG_LANES;i++) if(pending_fx[i].active && (!id || pending_fx[i].id==id)) pending_fx[i].active=0;
            queue_event(op,q,2,NULL);
        }
        return true;
    }
    if(op==UG_OP_CONTROL_FX) {
        uint16_t id=get16(q); uint8_t action=q[2]; ug_instance *in=NULL;
        project_playback();
        for(unsigned i=0;i<UG_LANES;i++) if(pending_fx[i].active && pending_fx[i].id==id) in=&pending_fx[i];
        if(action>2) *status=UG_ERR_BAD_ARGUMENT;
        else if(!in) *status=UG_ERR_HANDLE;
        else if(action==2 && !in->paused) *status=UG_ERR_STATE;
        else if(event_count==UG_AUDIO_EVENTS) *status=UG_ERR_BUSY;
        else { in->paused=action==1; if(!action) in->active=0; queue_event(op,q,3,NULL); }
        return true;
    }
    if(op==UG_OP_FX_STATUS || op==UG_OP_VOICE_STATUS) {
        *status=snapshot_page(op,q,r,len);return true;
    }
    if(op==UG_OP_MEM_INFO) {
        uint32_t free_bytes,largest; ug_store_space(&store,&free_bytes,&largest);
        ug_put32(r,store.pool); ug_put32(r+4,store.pool); ug_put32(r+8,free_bytes);
        ug_put32(r+12,largest); put16(r+16,store.count); put16(r+18,128); *len=20;
    } else if(op==UG_OP_MEM_TEST || op==UG_OP_RESET_STORE) {
        uint8_t mode=op==UG_OP_MEM_TEST?q[0]:q[4];
        if(mode>1 || (op==UG_OP_RESET_STORE && ug_get32(q)!=UG_RESET_STORE_KEY)) { *status=UG_ERR_BAD_ARGUMENT; return true; }
        if(op==UG_OP_MEM_TEST && store.count) { *status=UG_ERR_BUSY; return true; }
        if(op==UG_OP_RESET_STORE) { stop_all_playback(); ug_store_reset(&store);ug_legacy_reset(mode!=0); transfer.next_token=1; boot(); }
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
        if(q[0]>5 || q[0]==4) { *status=UG_ERR_BAD_ARGUMENT;return true; }
        ug_object_t *o; *status=ug_store_reserve(&store,q[0],ug_get32(q+1),&o);
        if(!*status) { put16(r,o->handle); ug_put32(r+2,o->reserved); *len=6; }
    } else if(op==UG_OP_FREE) {
        uint16_t handle=get16(q);*status=ug_store_free(&store,handle);
        if(!*status) legacy_forget(handle);
    }
    else if(op==UG_OP_OBJECT_ENUM) { put16(r,ug_store_enum(&store,get16(q))); *len=2; }
    else {
        ug_object_t *o=ug_store_find(&store,get16(q));
        if(!o) *status=UG_ERR_HANDLE;
        else {
            memset(r,0,38); put16(r,o->handle); r[2]=o->kind; r[3]=o->state;
            put16(r+4,o->pins); ug_put32(r+6,o->size); ug_put32(r+10,o->uploaded);
            ug_put32(r+14,o->crc);
            if(o->pcm_valid) {
                ug_put32(r+18,o->pcm.data_offset); ug_put32(r+22,o->pcm.data_length);
                ug_put32(r+26,o->pcm.rate); ug_put32(r+30,o->pcm.frames);
                r[34]=o->pcm.channels; r[35]=o->pcm.bits; r[36]=o->pcm.sample_format;
            }
            if((o->kind==3 || o->kind==5) && o->mod_valid) r[37]=o->mod_channels;
            *len=38;
        }
    }
    return true;
}

#include "ug_legacy.inc"
