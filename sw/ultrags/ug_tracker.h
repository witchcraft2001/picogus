/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * Internal transport/snapshot adapter. MOD effects remain in ug_mod.c.
 */
#pragma once
#include "ug_s3m.h"
typedef struct {
    ug_mod_channel channel[32];
    uint16_t order;
    uint8_t row,tick,speed,bpm,playing,paused,error,f00_policy,f00_mode;
    uint32_t dirty_note,dirty_volume,tempo_fraction;
} ug_tracker_state;
typedef struct {
    union { ug_mod_player mod;ug_s3m_player s3m; } engine;
    ug_tracker_state state;
    uint8_t s3m;
} ug_tracker;
void ug_tracker_start_mod(ug_tracker *,const ug_mod_info *,ug_mod_read_fn,void *,uint8_t,uint8_t);
void ug_tracker_start_s3m(ug_tracker *,const ug_s3m_info *,ug_mod_read_fn,void *,uint8_t);
void ug_tracker_stop(ug_tracker *);
void ug_tracker_tick(ug_tracker *);
int ug_tracker_seek(ug_tracker *,uint16_t,uint8_t);
void ug_tracker_tempo(ug_tracker *,uint8_t,uint8_t);
void ug_tracker_pan(ug_tracker *,unsigned,uint8_t);
uint32_t ug_tracker_frames_to_tick(const ug_tracker *);
void ug_tracker_advance_frames(ug_tracker *,uint32_t);
