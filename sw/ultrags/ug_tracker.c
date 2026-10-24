/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_tracker.h"
#include <string.h>
static void pull(ug_tracker *t) {
#define COPY(p) do { t->state.order=(p)->order;t->state.row=(p)->row;t->state.tick=(p)->tick; \
    t->state.speed=(p)->speed;t->state.bpm=(p)->bpm;t->state.playing=(p)->playing; \
    t->state.paused=(p)->paused;t->state.error=(p)->error; } while(0)
    if(t->s3m) {
        ug_s3m_player *p=&t->engine.s3m;COPY(p);
        for(unsigned c=0;c<32;c++) {
            ug_mod_channel *o=&t->state.channel[c];const ug_s3m_channel *s=&p->channel[c];
            o->period=s->period/1024>65535?65535:(uint16_t)(s->period/1024);
            o->note=s->note;o->pan=s->pan;o->mix_volume=s->mix_volume;
        }
    } else {
        ug_mod_player *p=&t->engine.mod;COPY(p);
        t->state.f00_policy=p->f00_policy;t->state.f00_mode=p->f00_mode;
        memcpy(t->state.channel,p->channel,sizeof(p->channel));
    }
#undef COPY
}
static void push(ug_tracker *t) {
    if(t->s3m) { t->engine.s3m.paused=t->state.paused;t->engine.s3m.playing=t->state.playing; }
    else { t->engine.mod.paused=t->state.paused;t->engine.mod.playing=t->state.playing;t->engine.mod.f00_mode=t->state.f00_mode; }
}
void ug_tracker_start_mod(ug_tracker *t,const ug_mod_info *i,ug_mod_read_fn r,void *ctx,uint8_t f,uint8_t f00) {
    memset(t,0,sizeof(*t));ug_mod_start(&t->engine.mod,i,r,ctx,f,f00);pull(t);
}
void ug_tracker_start_s3m(ug_tracker *t,const ug_s3m_info *i,ug_mod_read_fn r,void *ctx,uint8_t f) {
    memset(t,0,sizeof(*t));t->s3m=1;ug_s3m_start(&t->engine.s3m,i,r,ctx,f);pull(t);
}
void ug_tracker_stop(ug_tracker *t) { t->state.playing=0;push(t); }
void ug_tracker_tick(ug_tracker *t) { push(t);if(t->s3m)ug_s3m_tick(&t->engine.s3m);else ug_mod_tick(&t->engine.mod);pull(t); }
int ug_tracker_seek(ug_tracker *t,uint16_t order,uint8_t row) {
    push(t);int rc=t->s3m?ug_s3m_seek(&t->engine.s3m,order,row):ug_mod_seek(&t->engine.mod,order,row);
    if(!rc)t->state.tempo_fraction=0;pull(t);return rc;
}
void ug_tracker_tempo(ug_tracker *t,uint8_t speed,uint8_t bpm) {
    if(t->s3m) { if(speed && bpm>=32) { t->engine.s3m.pending_speed=speed;t->engine.s3m.pending_bpm=bpm; } }
    else ug_mod_tempo(&t->engine.mod,speed,bpm);
}
void ug_tracker_pan(ug_tracker *t,unsigned ch,uint8_t pan) {
    if(ch>=32)return;
    if(t->s3m)t->engine.s3m.channel[ch].pan=pan;else t->engine.mod.channel[ch].pan=pan;
    t->state.channel[ch].pan=pan;
}
uint32_t ug_tracker_frames_to_tick(const ug_tracker *t) {
    return t->state.bpm?(120000u-t->state.tempo_fraction+t->state.bpm-1u)/t->state.bpm:128;
}
void ug_tracker_advance_frames(ug_tracker *t,uint32_t n) {
    while(t->state.playing && !t->state.paused && n) {
        uint32_t take=ug_tracker_frames_to_tick(t);if(take>n)take=n;
        t->state.tempo_fraction+=take*t->state.bpm;n-=take;
        if(t->state.tempo_fraction>=120000u) { t->state.tempo_fraction-=120000u;ug_tracker_tick(t); }
    }
}
