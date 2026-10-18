/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * Native Ultra GS MOD4 reader and tracker. All source bytes remain in the
 * immutable object store and are accessed through a bounded reader callback.
 */
#include "ug_mod.h"
#include <string.h>

static uint16_t be16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
/* PAL C-1..B-1, with note 36 = C-1. Other octaves use exact shifts. */
static const uint16_t periods[12]={856,808,762,720,678,640,604,570,538,508,480,453};
static uint16_t note_period(unsigned note) {
    unsigned value=periods[note%12];int octave=(int)(note/12)-3;
    if(octave>0)value=(value+(1u<<(octave-1)))>>octave;
    else if(octave<0)value<<=-octave;
    return (uint16_t)value;
}
int ug_mod_parse(ug_mod_info *out,ug_mod_read_fn read,void *ctx,uint32_t size) {
    /* Core1 has a 2-KiB stack. Never materialize the 1084-byte header or a
     * second descriptor here; output is defined only after return == 0. */
    uint8_t h[240];
    if(!out || !read || size<1084) return -1;
    if(read(ctx,950,h,134)) return -2;
    if(memcmp(h+130,"M.K.",4) && memcmp(h+130,"M!K!",4)) return -1;
    memset(out,0,sizeof(*out));out->file_size=size;
    out->song_length=h[0];out->restart=h[1];
    if(!out->song_length || out->song_length>128) return -1;
    uint8_t max_pattern=0;
    for(unsigned i=0;i<128;i++) {
        uint8_t order=h[i+2];out->order[i]=order;
        if(i<out->song_length && order>=128) return -1;
        if(order<128 && order>max_pattern) max_pattern=order;
    }
    out->pattern_offset=1084;
    uint32_t patterns=(uint32_t)(max_pattern+1)*1024u;
    if(patterns>size-1084) return -1;
    out->sample_offset=1084+patterns;
    uint32_t total=0;
    for(unsigned first=0;first<31;) {
        unsigned count=31-first;if(count>8)count=8;
        if(read(ctx,20+first*30,h,count*30)) return -2;
        for(unsigned i=0;i<count;i++) {
            const uint8_t *s=h+i*30;ug_mod_sample *o=&out->samples[first+i];
            o->length=(uint32_t)be16(s+22)*2;
            o->finetune=(int8_t)(s[24]&15);if(o->finetune>7)o->finetune-=16;
            o->volume=s[25];o->loop_start=(uint32_t)be16(s+26)*2;o->loop_length=(uint32_t)be16(s+28)*2;
            if(o->volume>64) return -1;
            if(o->loop_length<=2) { o->loop_start=0;o->loop_length=0; }
            else if(o->loop_start>=o->length || o->loop_length>o->length-o->loop_start) return -1;
            if(o->length>UINT32_MAX-total) return -1;
            o->sample_bytes=o->length;total+=o->length;
        }
        first+=count;
    }
    return total>size-out->sample_offset?-1:0;
}

/* Equal-tempered eighth-semitone ratios in Q16. Arbitrary input periods
 * remain periods; only E3 glissando quantizes the output to a note. */
static uint16_t clamp_period(int value) {
    return (uint16_t)(value<1?1:value>4095?4095:value);
}
static uint16_t tuned_period(uint16_t period,int8_t fine) {
    static const uint32_t ratio[16]={69433,68933,68438,67945,67456,66971,66489,66011,
                                    65536,65065,64596,64132,63670,63212,62757,62306};
    return period?clamp_period((int)(((uint32_t)period*ratio[fine+8]+32768u)>>16)):0;
}
static uint8_t period_note(uint16_t period) {
    if(!period) return 127;
    unsigned best=0,distance=UINT32_MAX;
    for(unsigned note=0;note<96;note++) {
        unsigned n=note_period(note),d=period>n?period-n:n-period;
        if(d<distance) { distance=d;best=note; }
    }
    return (uint8_t)best;
}
static void instrument(ug_mod_player *p,ug_mod_channel *c,uint8_t sample) {
    if(sample) {
        c->sample=(uint8_t)(sample-1);
        c->volume=p->info.samples[c->sample].volume;
        c->fine=p->info.samples[c->sample].finetune;
    }
}
static void trigger_note(ug_mod_channel *c,uint16_t period,uint32_t offset) {
    c->base_period=tuned_period(period,c->fine);
    c->period=c->target_period=c->base_period;
    c->note=period_note(period);c->voice_sample=c->sample;
    c->sample_offset=offset;c->trigger++;
    if(!(c->wave_vibrato&4)) c->vibrato_pos=0;
    if(!(c->wave_tremolo&4)) c->tremolo_pos=0;
}
static void volume_slide(ug_mod_channel *c,unsigned up,unsigned down) {
    int v=(int)c->volume+(up?(int)up:-(int)down);
    c->volume=(uint8_t)(v<0?0:v>64?64:v);
}
static void apply_row(ug_mod_player *p) {
    uint8_t row[16];
    uint32_t off=p->info.pattern_offset+(uint32_t)p->info.order[p->order]*1024u+(uint32_t)p->row*16u;
    if(p->read(p->read_ctx,off,row,sizeof(row))) { p->error=1;p->playing=0;return; }
    p->global_jump_order=-1;p->global_break_row=-1;
    for(unsigned i=0;i<4;i++) {
        const uint8_t *e=row+i*4;ug_mod_channel *c=&p->channel[i];
        uint8_t sample=(e[0]&0xf0)|(e[2]>>4);
        uint16_t period=(uint16_t)(((e[0]&15)<<8)|e[1]);
        if(sample>31) { p->error=2;p->playing=0;return; }
        c->effect=e[2]&15;c->param=e[3];c->delayed_note=0;
        c->period=c->base_period;c->mix_volume=c->volume;
        uint8_t sub=c->param>>4,x=c->param&15;
        if(c->effect==14 && sub==4) c->wave_vibrato=x&7;
        if(c->effect==14 && sub==7) c->wave_tremolo=x&7;
        bool delay=c->effect==14 && sub==13 && x;
        if(c->effect==9 && c->param) c->offset_memory=(uint32_t)c->param*256u;
        if(delay) {
            /* Defer both instrument/volume and note. EDx with x>=speed is
             * discarded at the next row; no stale delayed event survives. */
            c->delayed_note=1;c->delayed_sample=sample;c->delayed_period=period;c->delayed_tick=x;
        } else {
            instrument(p,c,sample);
            if(c->effect==14 && sub==5) c->fine=(int8_t)(x<8?x:(int)x-16);
            if(period) {
                if(c->effect==3 || c->effect==5) {
                    c->target_period=tuned_period(period,c->fine);
                } else trigger_note(c,period,c->effect==9?c->offset_memory:0);
            }
        }
        if(c->effect==3 && c->param) c->porta_speed=c->param;
        if(c->effect==4) {
            if(sub) c->vibrato_speed=sub;
            if(x) c->vibrato_depth=x;
        }
        if(c->effect==7) {
            if(sub) c->tremolo_speed=sub;
            if(x) c->tremolo_depth=x;
        }
        switch(c->effect) {
        case 8: c->pan=c->param;break;
        case 11: p->global_jump_order=c->param;break;
        case 12: c->volume=c->param>64?64:c->param;break;
        case 13: {
            unsigned r=sub*10u+x;
            p->global_break_row=(int8_t)(sub>9 || x>9 || r>63?0:r);break;
        }
        case 15:
            if(c->param>=32) p->bpm=c->param;
            else if(c->param) p->speed=c->param;
            else if(!p->f00_mode) p->paused=1;
            break;
        case 14:
            switch(sub) {
            case 1: if(c->base_period)c->base_period=clamp_period((int)c->base_period-x);break;
            case 2: if(c->base_period)c->base_period=clamp_period((int)c->base_period+x);break;
            case 3: c->glissando=x!=0;break;
            case 4: c->wave_vibrato=x&7;break;
            case 6:
                if(!x) c->loop_row=p->row;
                else {
                    if(!c->loop_count) c->loop_count=x;
                    else --c->loop_count;
                    if(c->loop_count) { p->global_jump_order=p->order;p->global_break_row=(int8_t)c->loop_row; }
                }
                break;
            case 7: c->wave_tremolo=x&7;break;
            case 8: c->pan=x*17u;break;
            case 10: volume_slide(c,x,0);break;
            case 11: volume_slide(c,0,x);break;
            case 12: if(!x)c->volume=0;break;
            case 14: p->pattern_delay=x;break;
            default: break; /* E0/EF intentionally ignored (§10.3). */
            }
            break;
        default: break;
        }
        c->period=c->base_period;c->mix_volume=c->volume;
    }
}
static int waveform(ug_mod_channel *c,unsigned position,unsigned type) {
    static const uint8_t sine[32]={0,24,49,74,97,120,141,161,180,197,212,224,235,244,250,253,
                                   255,253,250,244,235,224,212,197,180,161,141,120,97,74,49,24};
    position&=63;
    switch(type&3) {
    case 0: return position<32?sine[position]:-(int)sine[position-32];
    case 1: return 255-(int)position*8;
    case 2: return position<32?255:-255;
    default:
        c->random_state=c->random_state*1664525u+1013904223u;
        return (int)(c->random_state>>23)-255;
    }
}
static void tone_porta(ug_mod_channel *c) {
    int v=c->base_period,t=c->target_period,s=c->porta_speed;
    if(!v || !t) return;
    if(v<t) { v+=s;if(v>t)v=t; }
    else if(v>t) { v-=s;if(v<t)v=t; }
    c->base_period=clamp_period(v);c->period=c->base_period;
    if(c->glissando) {
        unsigned distance=UINT32_MAX;
        for(unsigned i=0;i<96;i++) {
            uint16_t n=tuned_period(note_period(i),c->fine);
            unsigned d=n>c->base_period?n-c->base_period:c->base_period-n;
            if(d<distance) { distance=d;c->period=n; }
        }
    }
}
static void vibrato(ug_mod_channel *c) {
    if(c->base_period) c->period=clamp_period((int)c->base_period+
        waveform(c,c->vibrato_pos,c->wave_vibrato)*c->vibrato_depth/128);
    c->vibrato_pos=(uint8_t)((c->vibrato_pos+c->vibrato_speed)&63);
}
static void tick_effect(ug_mod_player *p,unsigned i) {
    ug_mod_channel *c=&p->channel[i];unsigned x=c->param>>4,y=c->param&15;
    c->period=c->base_period;c->mix_volume=c->volume;
    if(!p->tick) return;
    switch(c->effect) {
    case 0:
        if(c->param && c->base_period) {
            static const uint32_t ratio[16]={65536,61858,58386,55109,52016,49097,46341,43740,
                                            41285,38968,36781,34716,32768,30929,29193,27554};
            unsigned n=p->tick%3==1?x:p->tick%3==2?y:0;
            c->period=clamp_period((int)(((uint32_t)c->base_period*ratio[n]+32768u)>>16));
        }break;
    case 1: if(c->base_period)c->base_period=clamp_period((int)c->base_period-c->param);c->period=c->base_period;break;
    case 2: if(c->base_period)c->base_period=clamp_period((int)c->base_period+c->param);c->period=c->base_period;break;
    case 3: tone_porta(c);break;
    case 4: vibrato(c);break;
    case 5: tone_porta(c);volume_slide(c,x,y);break;
    case 6: vibrato(c);volume_slide(c,x,y);break;
    case 7: {
        int v=(int)c->volume+waveform(c,c->tremolo_pos,c->wave_tremolo)*c->tremolo_depth/64;
        c->mix_volume=(uint8_t)(v<0?0:v>64?64:v);
        c->tremolo_pos=(uint8_t)((c->tremolo_pos+c->tremolo_speed)&63);break;
    }
    case 10: volume_slide(c,x,y);break;
    case 14:
        if(x==9 && y && p->tick%y==0) { c->sample_offset=0;c->voice_sample=c->sample;c->trigger++; }
        if(x==12 && p->tick==y) c->volume=0;
        if(x==13 && c->delayed_note && p->tick==c->delayed_tick) {
            instrument(p,c,c->delayed_sample);
            if(c->delayed_period) trigger_note(c,c->delayed_period,0);
            c->delayed_note=0;
        }break;
    default: break;
    }
    if(c->effect!=7) c->mix_volume=c->volume;
}
static void init_channels(ug_mod_player *p) {
    static const uint8_t pans[4]={0,255,255,0};
    memset(p->channel,0,sizeof(p->channel));
    for(unsigned i=0;i<4;i++) {
        ug_mod_channel *c=&p->channel[i];
        c->pan=pans[i];c->volume=c->mix_volume=64;c->note=127;
        c->sample=c->voice_sample=255;c->random_state=i+1;
    }
}
void ug_mod_start(ug_mod_player *p,const ug_mod_info *info,ug_mod_read_fn read,void *ctx,bool loop,uint8_t f00) {
    memset(p,0,sizeof(*p));p->info=*info;p->read=read;p->read_ctx=ctx;
    p->speed=6;p->bpm=125;p->playing=1;p->loop_song=loop;p->f00_mode=f00;
    init_channels(p);apply_row(p); /* Tick zero starts at the PLAY boundary. */
}
void ug_mod_stop(ug_mod_player *p) { if(p)p->playing=0; }
void ug_mod_tempo(ug_mod_player *p,uint8_t speed,uint8_t bpm) {
    if(!p || speed<1 || speed>31 || bpm<32) return;
    p->pending_speed=speed;p->pending_bpm=bpm;
}
uint32_t ug_mod_frames_to_tick(const ug_mod_player *p) {
    if(!p || !p->bpm) return 128;
    return (120000u-p->tempo_fraction+p->bpm-1u)/p->bpm;
}
void ug_mod_tick(ug_mod_player *p) {
    if(!p || !p->playing || p->paused) return;
    if(p->pending_speed) {
        p->speed=p->pending_speed;p->bpm=p->pending_bpm;p->pending_speed=0;
    }
    if(++p->tick<p->speed) {
        for(unsigned i=0;i<4;i++)tick_effect(p,i);
        return;
    }
    if(p->pattern_delay) {
        --p->pattern_delay;p->tick=0;
        for(unsigned i=0;i<4;i++)tick_effect(p,i);
        return;
    }
    uint16_t order=p->order;uint8_t row=(uint8_t)(p->row+1);
    if(p->global_jump_order>=0 || p->global_break_row>=0) {
        order=p->global_jump_order>=0?(uint16_t)p->global_jump_order:(uint16_t)(order+1);
        row=p->global_break_row>=0?(uint8_t)p->global_break_row:0;
    } else if(row==64) { ++order;row=0; }
    if(order>=p->info.song_length) {
        if(!p->loop_song) { p->playing=0;--p->tick;return; }
        order=p->info.restart<p->info.song_length?p->info.restart:0;
    }
    p->order=order;p->row=row;p->tick=0;apply_row(p);
}
void ug_mod_advance_frames(ug_mod_player *p,uint32_t n) {
    while(p && p->playing && !p->paused && n) {
        uint32_t take=ug_mod_frames_to_tick(p);if(take>n)take=n;
        p->tempo_fraction+=take*p->bpm;n-=take;
        if(p->tempo_fraction>=120000u) { p->tempo_fraction-=120000u;ug_mod_tick(p); }
    }
}
int ug_mod_seek(ug_mod_player *p,uint16_t order,uint8_t row) {
    if(!p || !p->playing || order>=p->info.song_length || row>=64)return -1;
    p->order=order;p->row=row;p->tick=0;p->speed=6;p->bpm=125;p->tempo_fraction=0;
    p->pending_speed=0;p->pattern_delay=0;p->error=0;
    init_channels(p);apply_row(p);
    return 0;
}
