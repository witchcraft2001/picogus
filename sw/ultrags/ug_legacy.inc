/* SPDX-License-Identifier: GPL-2.0-or-later
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 */
/* Legacy GS backend included in ug_storage.c. State belongs to core1.
 * No copied GS ROM code; core0 observes the published atomic busy flag. */
typedef struct {
    uint16_t handle;
    uint8_t note,volume,fine,priority,first,last,loop;
    uint32_t loop_start,loop_end;
} ug_legacy_sample;
static ug_legacy_sample legacy_samples[61];
static struct {
    uint16_t module,pending,next_fx;
    uint8_t selected,last_fx,pending_id,kind,sign,stream_error;
    uint8_t post_op,post[3],post_used,post_need;
    uint8_t reply[4],reply_used,reply_size;
    bool loading,closing;
    uint16_t buffered;
    uint32_t crc,cursor;
    uint8_t buffer[256];
} legacy;
static ug_mod_info legacy_mod_info;
static ug_mod_parser legacy_mod_parser;
static unsigned legacy_busy;
static void legacy_publish(void) {
    __atomic_store_n(&legacy_busy,(legacy.loading || legacy.post_need || legacy.reply_size?1u:0u)|(legacy.loading?2u:0u),__ATOMIC_RELEASE);
}
bool ug_legacy_busy(void) { return __atomic_load_n(&legacy_busy,__ATOMIC_ACQUIRE)!=0; }
bool ug_legacy_loading(void) { return (__atomic_load_n(&legacy_busy,__ATOMIC_ACQUIRE)&2u)!=0; }
void ug_legacy_reset(bool cold) {
    memset(&legacy,0,sizeof(legacy));memset(legacy_samples,0,sizeof(legacy_samples));legacy.next_fx=1;
    legacy_automatic=true;legacy_ticks=0;mod_player.dirty_note=mod_player.dirty_volume=15;
    if(cold) { legacy_f00=0;legacy_relooper=0; }
    legacy_publish();
}
static uint8_t legacy_error(uint8_t e) {
    return e==UG_ERR_PSRAM?0xe1:e==UG_ERR_SHORT_TRANSFER?0xe0:e==UG_ERR_NO_MEMORY?0x10:e==UG_ERR_NO_HANDLES?0x11:e;
}
static uint8_t legacy_sample_id(uint8_t value) {
    return value?value:legacy.selected?legacy.selected:legacy.last_fx;
}
static ug_legacy_sample *legacy_sample(uint8_t value) {
    uint8_t id=legacy_sample_id(value);
    return id && id<=60 && legacy_samples[id].handle?&legacy_samples[id]:NULL;
}
static ug_legacy_sample *legacy_selected(void) { return legacy_sample(0); }
static uint8_t legacy_flush(void) {
    if(!legacy.buffered) return 0;
    ug_object_t *o=ug_store_find(&store,legacy.pending);
    if(!o) { legacy.buffered=0;legacy.stream_error=UG_ERR_HANDLE;return UG_ERR_HANDLE; }
    if(ug_psram_write(ps,o->offset+o->uploaded,legacy.buffer,legacy.buffered)) {
        legacy.buffered=0;legacy.stream_error=UG_ERR_PSRAM;ug_stat_add(10,1);return UG_ERR_PSRAM;
    }
    o->uploaded+=legacy.buffered;ug_stat_add(2,legacy.buffered);legacy.buffered=0;return 0;
}
static unsigned legacy_own_pins(uint16_t handle) {
    unsigned pins=foreground.active && foreground.legacy && foreground.handle==handle;
    for(unsigned i=0;i<4;i++) if(legacy_fx[i].active && legacy_fx[i].handle==handle) ++pins;
    return pins;
}
static uint8_t legacy_free_all(void) {
    apply_audio_events();
    for(unsigned i=0;i<=60;i++) {
        uint16_t h=i?legacy_samples[i].handle:legacy.module;
        const ug_object_t *o=ug_store_find(&store,h);
        if(o && o->pins>legacy_own_pins(h)) return UG_ERR_PINNED;
    }
    for(unsigned i=0;i<4;i++) drop_instance(&legacy_fx[i]);
    if(foreground.legacy) drop_instance(&foreground);
    for(unsigned i=0;i<=60;i++) {
        uint16_t h=i?legacy_samples[i].handle:legacy.module;
        if(h) (void)ug_store_free(&store,h);
    }
    legacy.module=0;legacy.selected=legacy.last_fx=0;legacy.next_fx=1;
    memset(legacy_samples,0,sizeof(legacy_samples));update_playback_busy();return 0;
}
static uint8_t legacy_begin(bool module,uint8_t sign,uint8_t *out) {
    *out=0;uint8_t e=0;
    if(module && (e=legacy_free_all())) return e;
    legacy.loading=true;legacy.kind=module?3:1;legacy.sign=sign;legacy.stream_error=0;
    legacy.buffered=0;legacy.pending=0;legacy.pending_id=module?1:legacy.next_fx<=60?(uint8_t)legacy.next_fx:0;
    uint32_t free_bytes,largest;ug_store_space(&store,&free_bytes,&largest);
    ug_object_t *o=NULL;
    e=!legacy.pending_id?UG_ERR_NO_HANDLES:!largest?UG_ERR_NO_MEMORY:ug_store_reserve(&store,legacy.kind,largest,&o);
    if(e) { legacy.stream_error=e;*out=0;legacy_publish();return e; }
    legacy.pending=o->handle;o->pins=1;*out=legacy.pending_id;legacy_publish();return 0;
}
static bool legacy_close(uint8_t *out,uint8_t *error) {
    if(ug_storage_transfer()) { *error=UG_ERR_BUSY;return true; }
    if(!legacy.loading) { *error=UG_ERR_STATE;*out=0;return true; }
    ug_object_t *o=ug_store_find(&store,legacy.pending);
    if(!legacy.closing) {
        /* A native BULK commit can poison the pending object without going
         * through GS DATA. Never publish its last successful prefix as READY. */
        if(o && o->state==2) legacy.stream_error=UG_ERR_PSRAM;
        if(legacy.stream_error) legacy.buffered=0;
        else { uint8_t e=legacy_flush();if(e && !legacy.stream_error) legacy.stream_error=e; }
        legacy.closing=true;legacy.cursor=0;legacy.crc=UINT32_MAX;
        ug_mod_parser_init(&legacy_mod_parser,&legacy_mod_info,o?o->uploaded:0);
        if(!o || !o->uploaded) { if(!legacy.stream_error) legacy.stream_error=UG_ERR_FORMAT; }
        if(o) { o->size=o->uploaded;o->reserved=(o->size+15)&~15u; }
    }
    if(o && !legacy.stream_error && legacy.cursor<o->size) {
        unsigned n=o->size-legacy.cursor;if(n>sizeof(legacy.buffer)) n=sizeof(legacy.buffer);
        if(ug_psram_read(ps,o->offset+legacy.cursor,legacy.buffer,n)) { legacy.stream_error=UG_ERR_PSRAM;ug_stat_add(10,1); }
        else { legacy.crc=crc_step(legacy.crc,legacy.buffer,n);legacy.cursor+=n; }
        if(!legacy.stream_error && legacy.cursor<o->size) return false;
    }
    if(o && !legacy.stream_error) {
        if(legacy.kind==3) {
            int parsed=ug_mod_parser_step(&legacy_mod_parser,&legacy_mod_info,mod_object_read,o);
            if(!parsed) return false;
            if(parsed<0) legacy.stream_error=parsed==-2?UG_ERR_PSRAM:UG_ERR_FORMAT;
            else { o->mod_valid=1;o->mod_channels=legacy_mod_info.channels; }
        } else {
            o->pcm=(ug_pcm_info){.rate=16574,.channels=1,.bits=8,.sample_format=legacy.sign?0:1,
                .data_offset=0,.data_length=o->size,.frames=o->size};o->pcm_valid=1;
        }
    }
    *out=0;
    if(legacy.stream_error || !o) {
        *error=legacy.stream_error?legacy.stream_error:UG_ERR_HANDLE;
        if(o) { o->pins=0;(void)ug_store_free(&store,o->handle); }
    } else {
        o->state=1;o->crc=legacy.crc^UINT32_MAX;o->pins=0;*out=legacy.pending_id;
        if(legacy.kind==3) legacy.module=o->handle;
        else {
            ug_legacy_sample *s=&legacy_samples[legacy.pending_id];
            *s=(ug_legacy_sample){.handle=o->handle,.note=60,.volume=64,.priority=128,.first=15,.last=15};
            legacy.selected=legacy.last_fx=legacy.pending_id;++legacy.next_fx;
        }
    }
    legacy.loading=legacy.closing=false;legacy.pending=0;legacy.buffered=0;legacy_publish();return true;
}
static uint64_t legacy_step(uint8_t note,uint8_t fine) {
    static const uint16_t semitone[12]={856,808,762,720,678,640,604,570,538,508,480,453};
    static const uint32_t tuning[16]={69433,68933,68438,67945,67456,66971,66489,66011,65536,65065,64596,64132,63670,63212,62757,62306};
    unsigned index=(fine>>1)&15;int signed_fine=index>=8?(int)index-16:(int)index;
    uint64_t period=(uint64_t)semitone[note%12]*tuning[signed_fine+8];
    int octave=(int)(note/12)-3;if(octave>0) period>>=octave;else if(octave<0) period<<=-octave;
    /* period is Q16: retain fractional periods in the extended octaves. */
    return (((uint64_t)3546895<<32)/48000*65536)/period;
}
static uint8_t legacy_play(unsigned channel,ug_legacy_sample *s,uint8_t note,uint8_t volume) {
    if(!s) return UG_ERR_HANDLE;
    ug_object_t *o=ug_store_find(&store,s->handle);if(!o) return UG_ERR_HANDLE;
    if(s->loop && !(s->loop_start<s->loop_end && s->loop_end<=o->size)) return UG_ERR_RANGE;
    if(note>95) return UG_ERR_RANGE;
    apply_audio_events();
    unsigned logical=(unsigned[]){0,3,1,2}[channel],voice;
    bool overrides=foreground.active && foreground.kind==2;
    if(overrides) voice=foreground.voice[logical];
    else if(legacy_fx[channel].active) voice=legacy_fx[channel].voice[0];
    else {
        project_playback();ug_instance candidate={.channels=1};
        if(!reserve_voices(&candidate,false,UINT16_MAX,false,0)) return UG_ERR_NO_VOICE;
        voice=candidate.voice[0];
    }
    uint8_t e=ug_store_pin(&store,o->handle,true);if(e) return e;
    drop_instance(&legacy_fx[channel]);
    if(overrides) hidden_music[logical]=mixer.lanes[voice];
    ug_instance in=new_instance(o,instance_id(true),volume,logical==0 || logical==3?0:255,1);
    in.legacy=1;in.legacy_fine=s->fine;in.priority=s->priority;in.voice[0]=(uint16_t)voice;
    legacy_fx[channel]=in;
    if(ug_lane_set(&mixer,voice,o->offset,o->size,s->loop_start,s->loop_end,
                   legacy_step(note,s->fine),volume,in.pan,o->pcm.sample_format?UG_FMT_S8:UG_FMT_U8,
                   UG_LANE_MONO,s->loop,0)) { drop_instance(&legacy_fx[channel]);return UG_ERR_FORMAT; }
    mixer.lanes[voice].phase=0;mixer.lanes[voice].class_gain=fx_gain;mixer.lanes[voice].class_master=fx_master;
    update_playback_busy();return 0;
}
static uint8_t legacy_seek_fx(ug_legacy_sample *s) {
    if(!s) return UG_ERR_HANDLE;
    for(unsigned pass=0;pass<2;pass++) for(unsigned c=0;c<4;c++)
        if(((pass?s->last:s->first)&(1u<<c)) && !legacy_fx[c].active) return legacy_play(c,s,s->note,s->volume);
    int best=-1;unsigned priority=255;
    for(unsigned c=0;c<4;c++) if((s->last&(1u<<c)) && legacy_fx[c].priority<priority) { priority=legacy_fx[c].priority;best=(int)c; }
    return best<0 || s->priority<=priority?UG_ERR_NO_VOICE:legacy_play((unsigned)best,s,s->note,s->volume);
}
static uint8_t legacy_post_apply(void) {
    ug_legacy_sample *s=legacy_selected();uint8_t cmd=legacy.post_op;
    if(cmd==0x6b) {
        unsigned n=legacy.post[0]|((unsigned)legacy.post[1]<<8);legacy_relooper=n>16384?512:(uint16_t)n;return 0;
    }
    if(cmd==0x48 || cmd==0x49) {
        if(!s) return UG_ERR_HANDLE;
        uint32_t n=legacy.post[0]|((uint32_t)legacy.post[1]<<8)|((uint32_t)legacy.post[2]<<16);
        if(cmd==0x48) { s->loop=legacy.post[2]!=255;s->loop_start=n; } else s->loop_end=n;
        return 0;
    }
    unsigned c=cmd&3;uint8_t id=legacy_sample_id(legacy.post[0]);
    s=legacy_sample(id);if(!s) return UG_ERR_HANDLE;
    uint8_t note=(cmd&0x18)==8 || (cmd&0x18)==24?legacy.post[1]:s->note;
    uint8_t volume=(cmd&0x18)==16?legacy.post[1]:(cmd&0x18)==24?legacy.post[2]:s->volume;
    return legacy_play(c,s,note,volume>64?64:volume);
}
bool ug_legacy_accepts_data(void) { return legacy.loading || legacy.post_need; }
void ug_legacy_data(uint8_t value,uint8_t *error) {
    if(legacy.loading) {
        if(ug_storage_transfer()) { *error=UG_ERR_BUSY;return; }
        ug_object_t *o=ug_store_find(&store,legacy.pending);
        if(legacy.stream_error) return;
        if(o && o->state==2) { legacy.stream_error=UG_ERR_PSRAM;*error=UG_ERR_PSRAM;return; }
        if(!o || o->uploaded+legacy.buffered>=o->size) { legacy.stream_error=UG_ERR_OVERFLOW;*error=UG_ERR_OVERFLOW;return; }
        legacy.buffer[legacy.buffered++]=value;
        if(legacy.buffered==sizeof(legacy.buffer)) {
            uint8_t e=legacy_flush();if(e) { legacy.stream_error=e;*error=e; }
        }
    } else if(legacy.post_need) {
        legacy.post[legacy.post_used++]=value;
        if(legacy.post_used==legacy.post_need) { *error=legacy_post_apply();legacy.post_need=0;legacy_publish(); }
    }
}
bool ug_legacy_reply(uint8_t *v) {
    if(legacy.reply_used==legacy.reply_size) return false;
    *v=legacy.reply[legacy.reply_used++];return true;
}
void ug_legacy_reply_consumed(void) {
    if(legacy.reply_used==legacy.reply_size) { legacy.reply_size=legacy.reply_used=0;legacy_publish(); }
}
bool ug_legacy_command(uint8_t cmd,bool has_pre,uint8_t pre,uint8_t *out,bool *db,uint8_t *error) {
    *db=false;*error=0;
    if(legacy.loading) {
        if(cmd==0xd2) { bool done=legacy_close(out,error);*error=legacy_error(*error);return done; }
        return true; /* LOAD whitelist: reset handled by frame coordinator */
    }
    if(legacy.post_need && legacy.post_op==0x6b) legacy_relooper=512;
    legacy.post_need=legacy.post_used=legacy.reply_size=legacy.reply_used=0;
    uint8_t e=0;ug_legacy_sample *s=legacy_selected();
    bool needs_pre=cmd==0x2a || cmd==0x2b || cmd==0x2e || cmd==0x31 || cmd==0x35 || cmd==0x39 || cmd==0x3a || cmd==0x3d || cmd==0x3e ||
        ((cmd>=0x40 && cmd<=0x42) || (cmd>=0x45 && cmd<=0x49)) || cmd==0x65 || cmd==0x66 || cmd==0x6a || ((cmd>=0x80 && cmd<=0x83) || (cmd>=0x88 && cmd<=0x8b) || (cmd>=0x90 && cmd<=0x93) || (cmd>=0x98 && cmd<=0x9b) || (cmd>=0xa0 && cmd<=0xa3) || (cmd>=0xa8 && cmd<=0xab));
    if(needs_pre && !has_pre) { *error=UG_ERR_BAD_ARGUMENT;legacy_publish();return true; }
    apply_audio_events();
    switch(cmd) {
    case 0: break;
    case 8:case 0xd0:case 0xd1:case 0xf0:break;
    case 0x20:case 0x21: {
        uint32_t free_bytes,largest;ug_store_space(&store,&free_bytes,&largest);uint32_t n=cmd==0x20?store.pool:free_bytes;
        for(unsigned i=0;i<3;i++)legacy.reply[i]=(uint8_t)(n>>(8*i));legacy.reply_size=3;break;
    }
    case 0x23:legacy.reply[0]=(uint8_t)(store.pool/32768>255?255:store.pool/32768);legacy.reply_size=1;break;
    case 0x2a:*out=music_master;music_master=pre>64?64:pre;break;
    case 0x2b:*out=fx_master;fx_master=pre>64?64:pre;break;
    case 0x35:*out=music_gain;music_gain=pre>64?64:pre;break;
    case 0x3d:*out=fx_gain;fx_gain=pre>64?64:pre;break;
    case 0x2e:*out=legacy.selected;if(pre && !legacy_sample(pre))e=UG_ERR_HANDLE;else legacy.selected=pre;break;
    case 0x30:e=legacy_begin(true,1,out);break;
    case 0x38:case 0x3e:if(cmd==0x3e && pre>1)e=UG_ERR_BAD_ARGUMENT;else e=legacy_begin(false,cmd==0x38?1:pre,out);break;
    case 0x31: {
        *out=0;if(pre>1 || !legacy.module) { e=UG_ERR_HANDLE;break; }
        ug_object_t *o=ug_store_find(&store,legacy.module);e=start_mod(o,1);
        if(!e) { events[event_count-1].instance.legacy=1;pending_foreground.legacy=1;music_gain=64;*out=1; }
        break;
    }
    case 0x32:case 0x33:
        *out=foreground.active && foreground.kind==2?(foreground.handle==legacy.module?1:0):0;
        if(foreground.active && foreground.kind==2) control_instance(&foreground,cmd==0x32?1:2);break;
    case 0x36:*out=255;break;
    case 0x37:e=legacy_free_all();break;
    case 0x39:e=legacy_seek_fx(legacy_sample(pre));break;
    case 0x3a:for(unsigned c=0;c<4;c++)if(pre&(128u>>c))drop_instance(&legacy_fx[c]);break;
    case 0x40:case 0x41:case 0x42:case 0x45:case 0x46:case 0x47: {
        if(!s) { e=UG_ERR_HANDLE;break; }
        uint8_t *v=cmd==0x40?&s->note:cmd==0x41?&s->volume:cmd==0x42?&s->fine:cmd==0x45?&s->priority:cmd==0x46?&s->first:&s->last;
        *out=*v;
        if((cmd==0x40 && pre>95) || (cmd==0x45 && (!pre || pre==255))) e=UG_ERR_BAD_ARGUMENT;
        else *v=cmd==0x41 && pre>64?64:cmd==0x46 || cmd==0x47?pre&15:pre;
        break;
    }
    case 0x48:case 0x49:legacy.post_op=cmd;legacy.post[0]=pre;legacy.post_used=1;legacy.post_need=3;break;
    case 0x60:case 0x61:case 0x62:
        legacy.reply[0]=!foreground.active || foreground.kind!=2?0:cmd==0x60?(uint8_t)mod_player.order:cmd==0x61?mod_player.row:(uint8_t)(((mod_player.order&3)<<6)|mod_player.row);legacy.reply_size=1;break;
    case 0x63:case 0x64: {
        uint8_t *dirty=cmd==0x63?&mod_player.dirty_note:&mod_player.dirty_volume;
        for(unsigned c=0;c<4;c++) {
            uint8_t value=cmd==0x63?mod_player.channel[c].note:mod_player.channel[c].mix_volume;
            if(!foreground.active || foreground.kind!=2)value=cmd==0x63?127:0;
            legacy.reply[c]=value|((*dirty&(1u<<c))?0:128);
        }
        *dirty=0;legacy.reply_size=4;break;
    }
    case 0x65:if(foreground.active && foreground.kind==2) { if(ug_mod_seek(&mod_player,pre,0)) e=UG_ERR_RANGE;else mod_sync_all(true); }break;
    case 0x66:
        if(foreground.active && foreground.kind==2) {
            if(!pre) { if(!legacy_f00) { mod_player.paused=1;sync_mod_pause(); } }
            else ug_mod_tempo(&mod_player,pre<32?pre:mod_player.speed,pre>=32?pre:mod_player.bpm);
        }
        break;
    case 0x67:case 0x68:legacy.reply[0]=cmd==0x67?mod_player.speed:mod_player.bpm;legacy.reply_size=1;break;
    case 0x69:if(legacy_ticks==UG_AUDIO_EVENTS)e=UG_ERR_BUSY;else if(foreground.active && foreground.kind==2)++legacy_ticks;break;
    case 0x6a:
        *out=legacy_f00;legacy_f00=pre!=0;
        if(!mod_player.f00_policy) mod_player.f00_mode=legacy_f00;
        break;
    case 0x6b:legacy.post_op=cmd;legacy.post[0]=has_pre?pre:0;legacy.post_used=1;legacy.post_need=2;break;
    case 0xd2:e=UG_ERR_STATE;*out=0;break;
    case 0xf5:legacy_automatic=false;break;
    case 0xf6:legacy_automatic=true;mod_player.tempo_fraction=0;break;
    default:
        if((cmd>=0x80 && cmd<=0x83) || (cmd>=0x88 && cmd<=0x8b) || (cmd>=0x90 && cmd<=0x93) || (cmd>=0x98 && cmd<=0x9b)) {
            legacy.post_op=cmd;legacy.post[0]=pre;legacy.post_used=1;legacy.post_need=cmd<0x88?1:cmd<0x98?2:3;
            if(legacy.post_need==1) { e=legacy_post_apply();legacy.post_need=0; }
        } else if((cmd>=0xa0 && cmd<=0xa3) || (cmd>=0xa8 && cmd<=0xab)) {
            unsigned c=cmd&3;ug_instance *in=&legacy_fx[c];
            if(!in->active)e=UG_ERR_STATE;
            else if(cmd<0xa8) { if(pre>95)e=UG_ERR_RANGE;else mixer.lanes[in->voice[0]].step=legacy_step(pre,in->legacy_fine); }
            else { in->gain=pre>64?64:pre;mixer.lanes[in->voice[0]].gain=in->gain; }
        } else e=UG_ERR_BAD_OPCODE;
    }
    for(unsigned n=0;n<=UG_LANES+4;n++) {
        ug_instance *in=!n?&foreground:n<=UG_LANES?&fx[n-1]:&legacy_fx[n-UG_LANES-1];
        if(in->active)for(unsigned c=0;c<in->channels;c++) {
            ug_lane *l=in->kind==2?music_lane(c):&mixer.lanes[in->voice[c]];
            l->class_gain=n?fx_gain:music_gain;l->class_master=n?fx_master:music_master;
        }
    }
    if(legacy.reply_size) { *out=legacy.reply[legacy.reply_used++];*db=true; }
    legacy_publish();update_playback_busy();*error=legacy_error(e);return true;
}

static bool legacy_pending(uint16_t handle) { return legacy.loading && handle && legacy.pending==handle; }
static void legacy_info(uint8_t *r) {
    ug_legacy_sample *s=legacy_selected();const ug_object_t *o=ug_store_find(&store,legacy.pending);
    put16(r,legacy.module);put16(r+2,s?s->handle:0);put16(r+4,legacy.pending);
    ug_put32(r+6,o?o->uploaded:0);
}
