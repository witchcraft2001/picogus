/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * All mutable store/job data belong exclusively to core1.
 */
#include "ug_storage.h"
#include "ug_store.h"
#include "ug_memory.h"
#include "ug_pcm.h"
#include "ug_render.h"
#include "ug_mod.h"
#include "ug_minimal.h"
#include "ug_config.h"
#include "ug_s4.h"
#include "pico/stdlib.h"
#include <string.h>
#include "ultrags_protocol.h"
static ug_store_t store;
static ug_mixer mixer;
static bool mixer_ready, audio_available;
typedef struct {
    uint16_t id,handle,mask,repeats;
    uint8_t active,paused,priority,gain,pan,channels,flags,state,kind,mod_song_length;
    uint32_t offset;
    ug_pcm_info pcm; /* independent of the movable object table */
} ug_instance;
static ug_instance foreground, fx[4];
static ug_mod_player mod_player;
static ug_mod_info pending_mod_info, seal_mod_info;
static struct { uint32_t offset,size; } mod_object;
static uint32_t mod_lane_trigger[4];
/* Commands run on core1 between renders. Project accepted events so the next
 * command validates the ownership that will exist at the quantum boundary. */
static ug_instance pending_foreground, pending_fx[4];
enum { UG_AUDIO_EVENTS=16 };
typedef struct { uint8_t op,q[6]; ug_instance instance; } ug_audio_event;
static ug_audio_event events[UG_AUDIO_EVENTS];
static unsigned event_count;
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
    uint8_t direction, verified, fault, transport;
    bool cancelled_command;
} transfer;
static struct { bool active, parser_started; uint16_t handle; uint32_t cursor,crc,expected,started; bool verify; ug_wav_parser parser; } sealing;
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
    return __atomic_load_n(&transfer.phase,__ATOMIC_ACQUIRE)==T_GRANT?(transfer.direction?16:8):0;
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
    if(ug_storage_grant()!=8 || transfer.direction) return UG_ERR_STATE;
    if(__atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE)==transfer.length) { __atomic_store_n(&transfer.fault,UG_ERR_OVERFLOW,__ATOMIC_RELEASE); return UG_ERR_OVERFLOW; }
    transfer.buffers[0][__atomic_fetch_add(&transfer.done,1,__ATOMIC_ACQ_REL)]=byte; __atomic_store_n(&transfer.last,now,__ATOMIC_RELEASE); return 0;
}
uint8_t ug_storage_data_read(uint8_t *byte,uint32_t now) {
    if(ug_storage_grant()!=16 || !transfer.direction) return UG_ERR_STATE;
    if(__atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE)==transfer.length) { __atomic_store_n(&transfer.fault,UG_ERR_OVERFLOW,__ATOMIC_RELEASE); return UG_ERR_UNDERFLOW; }
    *byte=transfer.buffers[1][__atomic_fetch_add(&transfer.done,1,__ATOMIC_ACQ_REL)]; __atomic_store_n(&transfer.last,now,__ATOMIC_RELEASE); return 0;
}
/* Three SRAM snapshots: published, held by core0, and writer's spare.
 * Ownership is exchanged in one atomic word. No PSRAM or wait for core1
 * is possible in the ISA latch/read paths. */
static uint8_t snapshots[3][128];
static unsigned snap_owners; /* bits0..1=published, bits2..3=held */
static uint32_t snap_seq;
static void make_snapshot(uint8_t *r);
static uint64_t output_frames;
static uint32_t last_frames, last_underruns;
void ug_storage_audio(uint32_t frames,uint32_t underruns) {
    output_frames+=(uint32_t)(frames-last_frames); last_frames=frames;
    ug_stat_add(9,(uint32_t)(underruns-last_underruns)); last_underruns=underruns;
}
void ug_storage_snap_init(void) {
    snap_seq=0; snap_owners=4;
    for(unsigned i=0;i<3;i++) make_snapshot(snapshots[i]);
}
void ug_storage_latch(void) {
    unsigned v=__atomic_load_n(&snap_owners,__ATOMIC_ACQUIRE), n;
    do { n=(v&3)|((v&3)<<2); }
    while(!__atomic_compare_exchange_n(&snap_owners,&v,n,false,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE));
}
uint8_t ug_storage_snap_byte(unsigned i) {
    return snapshots[(__atomic_load_n(&snap_owners,__ATOMIC_ACQUIRE)>>2)&3][i];
}
static void make_snapshot(uint8_t *r) {
    memset(r,0,128); ug_put32(r,++snap_seq); memcpy(r+4,&store.session,8);
    memcpy(r+12,&output_frames,8); ug_put32(r+46,__atomic_load_n(stats+9,__ATOMIC_RELAXED));
    r[27]=255; r[50]=audio_error;
    for(unsigned i=0;i<8;i++) r[56+8*i]=127;
    put16(r+42,mixer.peaks[0]); put16(r+44,mixer.peaks[1]);
    if(foreground.state) {
        put16(r+20,foreground.id); r[24]=foreground.state; r[25]=foreground.kind;
        r[26]=foreground.channels; put16(r+28,foreground.handle);
        ug_put32(r+32,foreground.kind==2?0:foreground.state==3?foreground.pcm.frames:(uint32_t)(mixer.lanes[0].phase>>32));
        if(foreground.kind==2) { put16(r+36,mod_player.order);r[38]=mod_player.row;r[39]=mod_player.tick;r[40]=mod_player.speed;r[41]=mod_player.bpm; }
        uint16_t active=0;
        if(foreground.active && !foreground.paused)
            for(unsigned lane=0;lane<foreground.channels;lane++)
                if(mixer.lanes[lane].active) active|=(uint16_t)(1u<<lane);
        put16(r+52,active);
        for(unsigned lane=0;lane<foreground.channels;lane++) {
            uint8_t *rec=r+56+8*lane;
            if(foreground.kind==2) {
                const ug_mod_channel *c=&mod_player.channel[lane];
                rec[0]=c->note;rec[1]=c->mix_volume;rec[2]=c->pan;put16(rec+4,c->period);
            } else { rec[1]=foreground.gain;rec[2]=foreground.pan; }
            rec[3]=(active&(1u<<lane))?1:0;
            put16(rec+6,mixer.lane_peaks[lane]);
        }
    }
    for(unsigned i=0;i<4;i++) if(fx[i].active && !fx[i].paused) {
        uint16_t mask=get16(r+52)|fx[i].mask; put16(r+52,mask);
    }
    if(phase()!=T_NONE) { ug_put32(r+120,transfer.token); put16(r+124,__atomic_load_n(&transfer.done,__ATOMIC_ACQUIRE)); put16(r+126,transfer.length); }
}
void ug_storage_snapshot(uint8_t out[128]) { make_snapshot(out); }
static void publish_snapshot(void) {
    unsigned v=__atomic_load_n(&snap_owners,__ATOMIC_ACQUIRE);
    unsigned pub=v&3, held=(v>>2)&3;
    unsigned spare=pub==held?(pub+1)%3:3-pub-held;
    make_snapshot(snapshots[spare]);
    /* If core0 latches during generation it only retains the published
     * ownership, so spare remains ours. Retry only the pointer publication. */
    while(!__atomic_compare_exchange_n(&snap_owners,&v,(v&12)|spare,false,__ATOMIC_RELEASE,__ATOMIC_ACQUIRE)) {}
}
static uint8_t commit_step(void) {
    ug_object_t *o=ug_store_find(&store,transfer.handle);
    uint32_t start=time_us_32();
    unsigned n=transfer.length-transfer.cursor; if(n>256) n=256;
    if(!o || ug_psram_write(ps,o->offset+transfer.offset+transfer.cursor,transfer.buffers[0]+transfer.cursor,n)) {
        if(o) o->state=2; ug_stat_add(10,1); release_transfer(); return UG_ERR_PSRAM;
    }
    uint32_t elapsed=time_us_32()-start; if(elapsed>ug_spi_slice_max_us) ug_spi_slice_max_us=elapsed;
    transfer.cursor+=n;
    if(transfer.cursor==transfer.length) {
        uint32_t end=transfer.offset+transfer.length;
        if(end>o->uploaded) o->uploaded=end;
        ug_stat_add(2,transfer.length); ug_stat_add(4,1); release_transfer();
    }
    return 0;
}
bool ug_storage_abort(uint32_t now) {
    transfer.cancelled_command=false;
    if(phase()==T_COMMIT) { uint8_t e=commit_step(); if(e) ug_minimal_error(e); if(phase()==T_COMMIT) return false; }
    else if(phase()!=T_NONE) release_transfer();
    if(sealing.active) { ug_store_pin(&store,sealing.handle,false); __atomic_store_n(&sealing.active,false,__ATOMIC_RELEASE); }
    ug_storage_cancel(now); return true;
}
void ug_storage_gs_reset(bool cold,uint32_t now) {
    /* A reset during COMMITTING is deferred by the frame cancellation
     * path. Cold reset owns the explicit destructive store operation. */
    if(!ug_storage_abort(now)) return;
    stop_all_playback(); ug_store_reset(&store); transfer.next_token=1; boot();
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
            transfer.cancelled_command=p==T_PREP || p==T_CHECK;
            release_transfer();
        }
    }
    if(phase()==T_GRANT && (uint32_t)(now-__atomic_load_n(&transfer.last,__ATOMIC_ACQUIRE))>=5000000) {
        release_transfer(); ug_stat_add(8,1); ug_minimal_error(UG_ERR_TIMEOUT);
    }
    if(gs_job) {
        ug_memory_step(&job,now);
        if(!job.active) { running=gs_job=false; memory_error=job.status; prepare_mixer(); __atomic_store_n(&busy,0,__ATOMIC_RELEASE); boot(); }
    }
    publish_snapshot();
}
static void boot(void) { ug_minimal_ready(audio_error?3:memory_error?1:0,store.session); }
void ug_storage_bind(ug_psram_t *p,uint64_t session) {
    ps=p; ug_store_init(&store,0,session); memset(&job,0,sizeof(job));
    mixer_ready=audio_available=false; memset(&foreground,0,sizeof(foreground)); memset(fx,0,sizeof(fx));
    event_count=0; __atomic_store_n(&playback_busy,0,__ATOMIC_RELEASE);
    memset(&mod_player,0,sizeof(mod_player)); memset(&pending_mod_info,0,sizeof(pending_mod_info));
    memset(&mod_object,0,sizeof(mod_object)); memset(mod_lane_trigger,0,sizeof(mod_lane_trigger));
    output_frames=0; last_frames=last_underruns=0;
    next_play_id=next_fx_id=1; music_master=fx_master=music_gain=fx_gain=64;
    running=false; gs_job=false; memory_error=0; audio_error=0;
    memset(&transfer,0,sizeof(transfer)); transfer.next_token=1; memset(&sealing,0,sizeof(sealing));
    ug_stats_clear();
    __atomic_store_n(&busy,1,__ATOMIC_RELEASE); ug_minimal_ready(2,session);
}
void ug_storage_publish(uint32_t physical,uint8_t error,uint8_t ae) {
    store.pool=physical; memory_error=error; audio_error=ae;
    audio_available=!ae; prepare_mixer();
    __atomic_store_n(&busy,0,__ATOMIC_RELEASE); boot();
}
bool ug_storage_busy(void) { return __atomic_load_n(&busy,__ATOMIC_ACQUIRE)!=0 || ug_storage_transfer() || __atomic_load_n(&sealing.active,__ATOMIC_ACQUIRE); }
bool ug_storage_playback_busy(void) { return __atomic_load_n(&playback_busy,__ATOMIC_ACQUIRE)!=0; }
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
    bool value=foreground.active || event_count;
    for(unsigned i=0;i<4;i++) value=value || fx[i].active;
    __atomic_store_n(&playback_busy,value,__ATOMIC_RELEASE);
}
static uint16_t instance_id(bool is_fx) {
    uint16_t *next=is_fx?&next_fx_id:&next_play_id;
    for(unsigned tries=0;tries<65535;tries++) {
        uint16_t id=alloc_id(next,is_fx?fx:&foreground,is_fx?4:1);
        bool used=false;
        for(unsigned i=0;i<event_count;i++)
            if((is_fx?events[i].op==UG_OP_PLAY_FX:
                (events[i].op==UG_OP_PLAY_PCM || events[i].op==UG_OP_PLAY_MOD)) &&
                events[i].instance.id==id) used=true;
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
    uint32_t offset=mod_object.offset+mod_player.info.sample_offset;
    for(unsigned i=0;i<sample && i<31;i++) offset+=mod_player.info.samples[i].length;
    return offset;
}
static void mod_lane_sync(unsigned i,bool force) {
    ug_mod_channel *c=&mod_player.channel[i]; ug_lane *l=&mixer.lanes[i];
    if(l->failed && !force) { mod_player.error=1;mod_player.playing=0;l->active=0;return; }
    bool retrigger=force || mod_lane_trigger[i]!=c->trigger;
    if(retrigger) {
        mod_lane_trigger[i]=c->trigger;
        if(!c->period || c->voice_sample>=31 ||
           c->sample_offset>=mod_player.info.samples[c->voice_sample].length) {
            memset(l,0,sizeof(*l));return;
        }
        const ug_mod_sample *s=&mod_player.info.samples[c->voice_sample];
        if(ug_lane_set(&mixer,i,mod_sample_offset(c->voice_sample),s->length,s->loop_start,
              s->loop_start+s->loop_length,mod_step(c->period),c->mix_volume,c->pan,UG_FMT_S8,
              UG_LANE_MONO,s->loop_length!=0,0)) {
            l->active=0;mod_player.error=2;mod_player.playing=0;return;
        }
        /* Keep the original source/loop bounds. The intro and 9xx offset
         * affect only the initial phase, never the stored sample or loop. */
        l->phase=(uint64_t)c->sample_offset<<32;
    }
    l->step=mod_step(c->period);l->gain=c->mix_volume;l->pan=c->pan;
    if(mod_player.paused || foreground.paused) l->active=0;
    mod_lane_trigger[i]=c->trigger;l->class_gain=music_gain;l->class_master=music_master;
}
static void mod_sync_all(bool force) { for(unsigned i=0;i<4;i++)mod_lane_sync(i,force); }
static int instance_lanes(const ug_instance *in,unsigned first,bool is_fx) {
    const ug_pcm_info *p=&in->pcm;
    uint8_t fmt=p->sample_format==0?UG_FMT_U8:p->sample_format==1?UG_FMT_S8:UG_FMT_S16LE;
    for(unsigned side=0;side<p->channels;side++) {
        uint8_t mode=p->channels==1?UG_LANE_MONO:side?UG_LANE_RIGHT:UG_LANE_LEFT;
        if(ug_lane_set(&mixer,first+side,in->offset,p->frames,p->loop_start,p->loop_end,
                       0,in->gain,in->pan,fmt,mode,(p->flags&1)!=0,(uint8_t)side)) return -1;
        ug_lane *l=&mixer.lanes[first+side];
        ug_lane_pcm_rate(l,p->rate,48000,in->repeats);
        l->class_gain=is_fx?fx_gain:music_gain;
        l->class_master=is_fx?fx_master:music_master;
    }
    return 0;
}
static void drop_instance(ug_instance *in) {
    if(!in->active) return;
    for(unsigned lane=0;lane<UG_LANES;lane++) if(in->mask&(1u<<lane)) mixer.lanes[lane].active=0;
    if(in->kind==2) ug_mod_stop(&mod_player);
    ug_store_pin(&store,in->handle,false); in->active=0; in->paused=0; in->state=0;
}
static ug_instance new_instance(const ug_object_t *o,uint16_t id,uint16_t mask,
                                uint8_t gain,uint8_t pan,uint16_t repeats) {
    return (ug_instance){.id=id,.handle=o->handle,.mask=mask,.active=1,.state=1,
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
static int start_foreground(ug_object_t *o,uint16_t repeats,uint8_t gain,uint8_t pan) {
    if(event_count==UG_AUDIO_EVENTS) return UG_ERR_BUSY;
    uint8_t rc=playable(o); if(rc) return rc;
    if((o->pcm.flags&1) && repeats!=1) return UG_ERR_BAD_ARGUMENT;
    project_playback();
    uint16_t id=instance_id(false); if(!id) return UG_ERR_NO_VOICE;
    rc=ug_store_pin(&store,o->handle,true); if(rc) return rc;
    ug_instance in=new_instance(o,id,o->pcm.channels==2?3:1,gain,pan,repeats);
    pending_foreground=in; queue_event(UG_OP_PLAY_PCM,NULL,0,&in);
    return 0;
}
static int start_mod(ug_object_t *o,uint8_t flags) {
    if(event_count==UG_AUDIO_EVENTS) return UG_ERR_BUSY;
    for(unsigned i=0;i<event_count;i++) if(events[i].op==UG_OP_PLAY_MOD) return UG_ERR_BUSY;
    if(!o) return UG_ERR_HANDLE;
    if(o->state!=1) return UG_ERR_STATE;
    if(o->kind!=3 || !o->mod_valid) return UG_ERR_FORMAT;
    if(!mixer_ready) return UG_ERR_PSRAM;
    if(flags&~1u) return UG_ERR_BAD_ARGUMENT;
    int parsed=ug_mod_parse(&pending_mod_info,mod_object_read,o,o->size);
    if(parsed) { if(parsed==-2)ug_stat_add(10,1);return parsed==-2?UG_ERR_PSRAM:UG_ERR_FORMAT; }
    project_playback();
    uint16_t id=instance_id(false);if(!id)return UG_ERR_NO_VOICE;
    uint8_t rc=ug_store_pin(&store,o->handle,true);if(rc)return rc;
    ug_instance in={.id=id,.handle=o->handle,.mask=0x0f,.active=1,.state=1,.channels=4,.kind=2,.flags=flags,
                    .gain=64,.mod_song_length=pending_mod_info.song_length};
    pending_foreground=in;queue_event(UG_OP_PLAY_MOD,NULL,0,&in);return 0;
}
static uint16_t occupied_fx(void) {
    uint16_t result=0;
    for(unsigned i=0;i<4;i++) if(pending_fx[i].active) result|=pending_fx[i].mask;
    return result;
}
static int fx_owner(unsigned lane) {
    for(unsigned i=0;i<4;i++) if(pending_fx[i].active && (pending_fx[i].mask&(1u<<lane))) return (int)i;
    return -1;
}
static int start_fx(ug_object_t *o,uint16_t mask,uint8_t priority,uint8_t gain,uint8_t pan,uint8_t flags,uint16_t *id_out,uint16_t *mask_out) {
    if(event_count==UG_AUDIO_EVENTS) return UG_ERR_BUSY;
    uint8_t rc=playable(o); if(rc) return rc;
    if(gain>64 || priority==0 || priority==255 || (flags&~3u) || (mask&~0x0f00u)) return UG_ERR_BAD_ARGUMENT;
    if((flags&2) && (o->pcm.flags&1)) return UG_ERR_BAD_ARGUMENT;
    project_playback();
    unsigned need=o->pcm.channels;
    uint16_t candidates=mask?mask:0x0f00u, occupied=occupied_fx(), chosen=0;
    for(unsigned lane=8;lane<12;lane+=need) {
        uint16_t bits=(uint16_t)(((1u<<need)-1)<<lane);
        if((candidates&bits)==bits && !(occupied&bits)) { chosen=bits; break; }
    }
    if(!chosen && (flags&1)) {
        unsigned best=255;
        for(unsigned lane=8;lane<12;lane+=need) {
            uint16_t bits=(uint16_t)(((1u<<need)-1)<<lane);
            if((candidates&bits)!=bits) continue;
            unsigned score=0; bool allowed=true;
            for(unsigned side=0;side<need;side++) {
                int owner=fx_owner(lane+side);
                if(owner>=0) {
                    unsigned pr=pending_fx[owner].priority;
                    if(pr>=priority) allowed=false;
                    if(pr>score) score=pr;
                }
            }
            if(allowed && score<best) { best=score; chosen=bits; }
        }
    }
    if(!chosen) return UG_ERR_NO_VOICE;
    int slot=-1;
    for(unsigned i=0;i<4;i++) if(!pending_fx[i].active || (pending_fx[i].mask&chosen)) { slot=(int)i; break; }
    if(slot<0) return UG_ERR_NO_VOICE;
    uint16_t id=instance_id(true); if(!id) return UG_ERR_NO_VOICE;
    rc=ug_store_pin(&store,o->handle,true); if(rc) return rc;
    ug_instance in=new_instance(o,id,chosen,gain,pan,(flags&2)?0:1);
    in.priority=priority; in.flags=flags;
    for(unsigned i=0;i<4;i++) if(pending_fx[i].active && (pending_fx[i].mask&chosen)) pending_fx[i].active=0;
    pending_fx[slot]=in; queue_event(UG_OP_PLAY_FX,NULL,0,&in);
    *id_out=id; *mask_out=chosen; return 0;
}
static bool any_playing(void) {
    if(foreground.active && !foreground.paused) return true;
    for(unsigned i=0;i<4;i++) if(fx[i].active && !fx[i].paused) return true;
    return false;
}
static void stop_all_playback(void) {
    for(unsigned i=0;i<event_count;i++)
        if(events[i].op==UG_OP_PLAY_PCM || events[i].op==UG_OP_PLAY_MOD || events[i].op==UG_OP_PLAY_FX) ug_store_pin(&store,events[i].instance.handle,false);
    event_count=0;
    drop_instance(&foreground);
    for(unsigned i=0;i<4;i++) drop_instance(&fx[i]);
    memset(&foreground,0,sizeof(foreground)); memset(fx,0,sizeof(fx));
    update_playback_busy();
}
static void control_instance(ug_instance *in,uint8_t action) {
    if(action==0) { drop_instance(in); return; }
    in->paused=action==1; in->state=in->paused?2:1;
    if(in->kind==2) mod_player.paused=in->paused;
    for(unsigned lane=0;lane<UG_LANES;lane++) if(in->mask&(1u<<lane)) {
        ug_lane *l=&mixer.lanes[lane];
        l->active=!in->paused && l->len_samples && !l->ended && !l->failed;
    }
}
static void sync_mod_pause(void) {
    if(foreground.active && foreground.kind==2 && mod_player.paused) {
        foreground.paused=1;foreground.state=2;
        for(unsigned lane=0;lane<4;lane++) mixer.lanes[lane].active=0;
    }
}
static void apply_audio_events(void) {
    for(unsigned index=0;index<event_count;index++) {
        const ug_audio_event *e=&events[index];
        if(e->op==UG_OP_PLAY_PCM) {
            drop_instance(&foreground); foreground=e->instance;
            if(instance_lanes(&foreground,0,false)) { drop_instance(&foreground); foreground.state=4; audio_error=UG_ERR_FORMAT; }
        } else if(e->op==UG_OP_PLAY_MOD) {
            drop_instance(&foreground); foreground=e->instance;
            ug_object_t *o=ug_store_find(&store,foreground.handle);
            if(!o) { foreground.active=0;foreground.state=4;audio_error=UG_ERR_HANDLE;continue; }
            mod_object.offset=o->offset;mod_object.size=o->size;
            ug_mod_start(&mod_player,&pending_mod_info,mod_player_read,&mod_object,
                         (foreground.flags&1)!=0,0);
            memset(mod_lane_trigger,0,sizeof(mod_lane_trigger));
            for(unsigned lane=0;lane<4;lane++)mixer.lanes[lane].active=0;
            mod_sync_all(true);
            sync_mod_pause();
        } else if(e->op==UG_OP_SEEK_MOD) {
            if(ug_mod_seek(&mod_player,get16(e->q+2),e->q[4])) mod_player.playing=0;
            mod_sync_all(true);
            sync_mod_pause();
        } else if(e->op==UG_OP_SET_TEMPO) {
            ug_mod_tempo(&mod_player,e->q[0],e->q[1]);
        } else if(e->op==UG_OP_SET_PAN) {
            unsigned channel=e->q[0];mod_player.channel[channel].pan=e->q[1];mod_lane_sync(channel,false);
        } else if(e->op==UG_OP_PLAY_FX) {
            int slot=-1;
            for(unsigned i=0;i<4;i++) if(fx[i].active && (fx[i].mask&e->instance.mask)) drop_instance(&fx[i]);
            for(unsigned i=0;i<4;i++) if(!fx[i].active) { slot=(int)i; break; }
            if(slot>=0) {
                fx[slot]=e->instance;
                unsigned first=(unsigned)__builtin_ctz(e->instance.mask);
                if(instance_lanes(&fx[slot],first,true)) { drop_instance(&fx[slot]); audio_error=UG_ERR_FORMAT; }
            } else { ug_store_pin(&store,e->instance.handle,false); audio_error=UG_ERR_NO_VOICE; }
        } else if(e->op==UG_OP_CONTROL) control_instance(&foreground,e->q[2]);
        else if(e->op==UG_OP_CONTROL_FX) {
            for(unsigned i=0;i<4;i++) if(fx[i].active && fx[i].id==get16(e->q)) control_instance(&fx[i],e->q[2]);
        } else if(e->op==UG_OP_STOP_FX) {
            uint16_t mask=get16(e->q);
            for(unsigned i=0;i<4;i++) if(fx[i].active && (!mask || (fx[i].mask&mask))) drop_instance(&fx[i]);
        } else if(e->op==UG_OP_SET_MIX) {
            music_master=e->q[0]; fx_master=e->q[1]; music_gain=e->q[2]; fx_gain=e->q[3];
            for(unsigned lane=0;lane<UG_LANES;lane++) {
                mixer.lanes[lane].class_gain=lane>=8?fx_gain:music_gain;
                mixer.lanes[lane].class_master=lane>=8?fx_master:music_master;
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
    if(!out) return false;
    memset(out,0,(size_t)frames*2*sizeof(*out));
    if(!mixer_ready) return false;
    uint32_t clips=mixer.stats.clips, errors=mixer.stats.fetch_errors, started=time_us_32();
    apply_audio_events();
    mixer.vol_q15=(int32_t)mainvol_q15();
    if(foreground.active && foreground.kind==2 && mod_player.playing && !mod_player.paused) {
        uint32_t done=0;
        while(done<frames) {
            uint32_t to_tick=ug_mod_frames_to_tick(&mod_player);
            uint32_t take=frames-done;if(take>to_tick)take=to_tick;
            if(take) { ug_mixer_render(&mixer,out+done*2,take);ug_mod_advance_frames(&mod_player,take);done+=take; }
            mod_sync_all(false);
            sync_mod_pause();
            if(!mod_player.playing || mod_player.paused) {
                for(unsigned lane=0;lane<4;lane++) mixer.lanes[lane].active=0;
                if(done<frames) ug_mixer_render(&mixer,out+done*2,frames-done);
                done=frames;
            }
        }
    } else ug_mixer_render(&mixer,out,frames);
    ug_stat_max(11,time_us_32()-started);
    ug_stat_add(10,mixer.stats.fetch_errors-errors);
    bool failed=false;
    for(unsigned which=0;which<5;which++) {
        ug_instance *in=which?&fx[which-1]:&foreground;
        if(!in->active || (in->paused && !(in->kind==2 && mod_player.error))) continue;
        unsigned first=(unsigned)__builtin_ctz(in->mask);
        bool fault=false;
        for(unsigned lane=0;lane<UG_LANES;lane++)
            if((in->mask&(1u<<lane)) && mixer.lanes[lane].failed) fault=true;
        if(in->kind==2 && mod_player.error) fault=true;
        bool ended=in->kind==2?!mod_player.playing:!mixer.lanes[first].active;
        if(fault || ended) {
            uint8_t error=in->kind==2 && mod_player.error==2?UG_ERR_FORMAT:UG_ERR_PSRAM;
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
    return any_playing();
}
void ug_storage_main_volume(uint8_t percent) {
    if(percent>100) percent=100;
    __atomic_store_n(&main_volume,percent,__ATOMIC_RELEASE);
}
bool ug_storage_command(uint8_t op,const uint8_t *q,uint8_t n,uint8_t *r,
                        uint8_t *len,uint8_t *status,uint32_t now) {
    *len=*status=UG_ERR_OK;
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
        transfer.crc=crc_step(transfer.crc,transfer.buffers[0]+transfer.cursor,k);
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
    if(phase()==T_COMMIT) { *status=commit_step(); return phase()!=T_COMMIT; }
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
            int rc=ug_mod_parse(&seal_mod_info,mod_object_read,o,o->size);
            if(rc) {
                o->state=2;*status=rc==-2?UG_ERR_PSRAM:UG_ERR_FORMAT;
                if(rc==-2)ug_stat_add(10,1);
            }
            else o->mod_valid=1;
        }
        ug_seal_elapsed_us=time_us_32()-sealing.started;
        uint32_t actual=sealing.crc^UINT32_MAX;
        if(!*status && sealing.verify && actual!=sealing.expected) { o->state=2; *status=UG_ERR_CRC; }
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
    case UG_OP_CAPS: case UG_OP_MEM_INFO: case UG_OP_STATS: case UG_OP_CLEAR_STATS: case UG_OP_SNAPSHOT: expected=0; break;
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
    case UG_OP_SET_PAN: expected=2; break;
    case UG_OP_CONTROL: case UG_OP_CONTROL_FX: expected=3; break;
    case UG_OP_SET_MIX: expected=4; break;
    case UG_OP_PLAY_FX: expected=8; break;
    case UG_OP_STOP_FX: expected=2; break;
    case UG_OP_FX_STATUS: expected=2; break;
    case UG_OP_MEM_TEST: expected=1; break;
    case UG_OP_RESET_STORE: case UG_OP_ALLOC: expected=5; break;
    case UG_OP_FREE: case UG_OP_OBJECT_INFO: case UG_OP_OBJECT_ENUM: expected=2; break;
    default: *status=UG_ERR_BAD_OPCODE; return true;
    }
    if(n!=expected) { *status=UG_ERR_LENGTH; return true; }
    if(op==UG_OP_CAPS) {
        if(ug_storage_transfer()) { *status=UG_ERR_BUSY; return true; }
        memset(r,0,32); *len=32;
        /* GS musical (CAPS bit 0) is deliberately clear until the legacy
         * command dispatcher and stream lifecycle are implemented. Native
         * MOD4 support is represented independently by formats bit 3. */
        ug_put32(r,(230u|(ug_cfg.settings->UltraGS.bulkAlias!=0xffff?8u:0u)|
                    (ug_config_aliases(&ug_cfg)?512u:0u)|(mixer_ready?1280u:0u)));
        if(mixer_ready) ug_put32(r+4,15u); /* RAW8, RAW16, WAV PCM, MOD4 */
        ug_put32(r+8,48000); put16(r+12,1024); put16(r+14,128); put16(r+16,128);
        r[20]=8; r[21]=mixer_ready?4:0; r[22]=1;
        put16(r+24,ug_cfg.settings->UltraGS.basePort); put16(r+26,ug_cfg.settings->UltraGS.bulkAlias);
        return true;
    }
    if(__atomic_load_n(&busy,__ATOMIC_ACQUIRE)) { *status=UG_ERR_BUSY; return true; }
    if(ug_storage_transfer() && op!=UG_OP_MEM_INFO && op!=UG_OP_OBJECT_INFO &&
       op!=UG_OP_WRITE_END && op!=UG_OP_READ_END && op!=UG_OP_TRANSFER_CANCEL &&
       op!=UG_OP_STATS && op!=UG_OP_SNAPSHOT && op!=UG_OP_FX_STATUS) { *status=UG_ERR_BUSY; return true; }
    if(ug_storage_transfer() && op==UG_OP_OBJECT_INFO && get16(q)!=transfer.handle) {
        *status=UG_ERR_BUSY; return true;
    }
    if(op==UG_OP_STATS) { ug_stats_copy(r); *len=64; return true; }
    if(op==UG_OP_CLEAR_STATS) { ug_stats_clear(); return true; }
    if(op==UG_OP_SNAPSHOT) { ug_storage_snapshot(r); *len=128; return true; }
    if(op==UG_OP_WRITE_BEGIN || op==UG_OP_READ_BEGIN) {
        uint8_t trans=q[8];
        if(trans&126) { *status=UG_ERR_BAD_ARGUMENT; return true; }
        if(!ug_minimal_gs_idle()) { *status=UG_ERR_BUSY; return true; }
        ug_object_t *o=ug_store_find(&store,get16(q));
        uint32_t offset=ug_get32(q+2); uint16_t count=get16(q+6);
        if(!o) *status=UG_ERR_HANDLE;
        else if(!count || count>1024) *status=UG_ERR_LENGTH;
        else if(o->state==2 || (op==UG_OP_WRITE_BEGIN && o->state!=0)) *status=UG_ERR_STATE;
        else if(op==UG_OP_WRITE_BEGIN && o->pins) *status=UG_ERR_PINNED;
        else if(offset>o->size || count>o->size-offset) *status=UG_ERR_RANGE;
        else if(op==UG_OP_READ_BEGIN && (offset>o->uploaded || count>o->uploaded-offset)) *status=UG_ERR_RANGE;
        else if(op==UG_OP_WRITE_BEGIN && offset!=o->uploaded && !(o->kind==0 && offset<=o->uploaded && count<=o->uploaded-offset)) *status=UG_ERR_RANGE;
        else if(!transfer.next_token) *status=UG_ERR_OVERFLOW;
        else *status=ug_store_pin(&store,o->handle,true);
        if(*status) return true;
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
        if(phase()!=T_GRANT || transfer.direction!=(op==UG_OP_READ_END)) { *status=UG_ERR_STATE; return true; }
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
    if(op==UG_OP_PCM_CONFIG) {
        ug_object_t *o=ug_store_find(&store,get16(q));
        ug_pcm_info pcm;
        if(!o) *status=UG_ERR_HANDLE;
        else if(o->kind!=1) *status=UG_ERR_STATE;
        else if(o->state || o->pins) *status=UG_ERR_STATE;
        else if(ug_pcm_raw_config(&pcm,o->size,q+2)) *status=UG_ERR_FORMAT;
        else { o->pcm=pcm; o->pcm_valid=1; }
        return true;
    }
    if(op==UG_OP_SEAL) {
        ug_object_t *o=ug_store_find(&store,get16(q));
        if(q[2]>1 || (!q[2] && ug_get32(q+3))) *status=UG_ERR_BAD_ARGUMENT;
        else if(!o) *status=UG_ERR_HANDLE;
        else if(o->kind>3) *status=UG_ERR_BAD_OPCODE;
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
        else queue_event(op,q,5,NULL);
        return true;
    }
    if(op==UG_OP_SET_TEMPO) {
        project_playback();
        if(q[0]<1 || q[0]>31 || q[1]<32) *status=UG_ERR_BAD_ARGUMENT;
        else if(!pending_foreground.active || pending_foreground.kind!=2) *status=UG_ERR_STATE;
        else if(event_count==UG_AUDIO_EVENTS) *status=UG_ERR_BUSY;
        else queue_event(op,q,2,NULL);
        return true;
    }
    if(op==UG_OP_SET_PAN) {
        project_playback();
        if(q[0]>=4) *status=UG_ERR_RANGE;
        else if(!pending_foreground.active || pending_foreground.kind!=2) *status=UG_ERR_STATE;
        else if(event_count==UG_AUDIO_EVENTS) *status=UG_ERR_BUSY;
        else queue_event(op,q,2,NULL);
        return true;
    }
    if(op==UG_OP_CONTROL) {
        uint16_t id=get16(q); uint8_t action=q[2];
        project_playback();
        if(action>2) *status=UG_ERR_BAD_ARGUMENT;
        else if(!pending_foreground.active || (id && id!=pending_foreground.id)) *status=UG_ERR_STATE;
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
        ug_object_t *o=ug_store_find(&store,get16(q)); uint16_t id=0,mask=0;
        if(q[5]>64) *status=UG_ERR_BAD_ARGUMENT;
        else if(!o) *status=UG_ERR_HANDLE;
        else *status=start_fx(o,get16(q+2),q[4],q[5],q[6],q[7],&id,&mask);
        if(!*status) { put16(r,id); put16(r+2,mask); *len=4; }
        return true;
    }
    if(op==UG_OP_STOP_FX) {
        uint16_t mask=get16(q);
        if(mask&~0x0f00u) *status=UG_ERR_BAD_ARGUMENT;
        else if(event_count==UG_AUDIO_EVENTS) *status=UG_ERR_BUSY;
        else {
            project_playback();
            for(unsigned i=0;i<4;i++) if(pending_fx[i].active && (!mask || (pending_fx[i].mask&mask))) pending_fx[i].active=0;
            queue_event(op,q,2,NULL);
        }
        return true;
    }
    if(op==UG_OP_CONTROL_FX) {
        uint16_t id=get16(q); uint8_t action=q[2]; ug_instance *in=NULL;
        project_playback();
        for(unsigned i=0;i<4;i++) if(pending_fx[i].active && pending_fx[i].id==id) in=&pending_fx[i];
        if(action>2) *status=UG_ERR_BAD_ARGUMENT;
        else if(!in) *status=UG_ERR_HANDLE;
        else if(action==2 && !in->paused) *status=UG_ERR_STATE;
        else if(event_count==UG_AUDIO_EVENTS) *status=UG_ERR_BUSY;
        else { in->paused=action==1; if(!action) in->active=0; queue_event(op,q,3,NULL); }
        return true;
    }
    if(op==UG_OP_FX_STATUS) {
        uint8_t first=q[0], count=q[1];
        if(!count || count>7 || first>15 || count>16-first) { *status=UG_ERR_BAD_ARGUMENT; return true; }
        r[0]=first; r[1]=count; memset(r+2,0,16u*count); *len=2+16u*count;
        for(unsigned lane=first;lane<first+count;lane++) {
            ug_instance *in=NULL; for(unsigned i=0;i<4;i++) if(fx[i].active && (fx[i].mask&(1u<<lane))) in=&fx[i];
            uint8_t *rec=r+2+16u*(lane-first);
            if(in) {
                unsigned start=0; while(start<16 && !(in->mask&(1u<<start))) start++;
                put16(rec,in->id); put16(rec+2,in->mask); put16(rec+4,in->handle);
                rec[6]=in->paused?2:1; rec[7]=in->channels;
                if(start<16) ug_put32(rec+8,(uint32_t)(mixer.lanes[start].phase>>32));
                rec[12]=in->gain; rec[13]=in->pan; rec[14]=in->priority; rec[15]=(in->channels==2 && lane==(start+1))?2:0;
            }
        }
        return true;
    }
    if(op==UG_OP_MEM_INFO) {
        uint32_t free_bytes,largest; ug_store_space(&store,&free_bytes,&largest);
        ug_put32(r,store.pool); ug_put32(r+4,store.pool); ug_put32(r+8,free_bytes);
        ug_put32(r+12,largest); put16(r+16,store.count); put16(r+18,128); *len=20;
    } else if(op==UG_OP_MEM_TEST || op==UG_OP_RESET_STORE) {
        uint8_t mode=op==UG_OP_MEM_TEST?q[0]:q[4];
        if(mode>1 || (op==UG_OP_RESET_STORE && ug_get32(q)!=UG_RESET_STORE_KEY)) { *status=UG_ERR_BAD_ARGUMENT; return true; }
        if(op==UG_OP_MEM_TEST && store.count) { *status=UG_ERR_BUSY; return true; }
        if(op==UG_OP_RESET_STORE) { stop_all_playback(); ug_store_reset(&store); transfer.next_token=1; boot(); }
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
            ug_put32(r+14,o->crc);
            if(o->pcm_valid) {
                ug_put32(r+18,o->pcm.data_offset); ug_put32(r+22,o->pcm.data_length);
                ug_put32(r+26,o->pcm.rate); ug_put32(r+30,o->pcm.frames);
                r[34]=o->pcm.channels; r[35]=o->pcm.bits; r[36]=o->pcm.sample_format;
            }
            if(o->kind==3 && o->mod_valid) r[37]=4;
            *len=38;
        }
    }
    return true;
}
