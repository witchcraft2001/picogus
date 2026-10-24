/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * PCM Scream Tracker 3. Source bytes are immutable; the private index is
 * owned by the source object, and all backing-store operations are <=256 B.
 */
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "ug_mod.h"

typedef int (*ug_s3m_write_fn)(void *,uint32_t,const uint8_t *,uint32_t);
typedef struct {
    uint32_t offset, length, loop_start, loop_end, c2spd;
    uint8_t volume, flags, reserved[2]; /* flags: loop/stereo/16bit */
} ug_s3m_sample;
typedef struct {
    uint32_t file_size, aux_size, enabled, stereo;
    uint16_t orders, instruments, patterns;
    uint8_t channels, speed, bpm, volume, signed_samples, fast_slides, amiga_limits;
    uint8_t order[256], pan[32];
} ug_s3m_info;
/* Private layout: info, instruments, 64 u32 row pointers per pattern, then
 * rows (u8 count followed by count * {channel,note,instrument,volume,fx,arg}). */
typedef struct {
    ug_s3m_info info;
    uint32_t cursor, end, event_bytes, written, table_end;
    uint16_t instrument, pattern, cache_used, cache_size;
    uint8_t stage, row, pan_present, stereo_output, empty_pattern;
    uint8_t used[32], stereo_instruments[32], events[32][5], present[32];
    uint8_t cache[256];
} ug_s3m_parser;
void ug_s3m_parser_init(ug_s3m_parser *,uint32_t);
/* First pass (write=NULL) validates/counts; second pass writes the index.
 * 0=pending, 1=complete, -1=format, -2=I/O. No allocation inside the parser. */
int ug_s3m_parser_step(ug_s3m_parser *,ug_mod_read_fn,void *,ug_s3m_write_fn,void *);
uint32_t ug_s3m_rows_offset(const ug_s3m_info *);

typedef struct {
    ug_s3m_sample sample;
    uint64_t period, base_period, target_period;
    uint32_t trigger, sample_offset;
    uint8_t instrument, note, volume, mix_volume, pan, effect, param, memory;
    uint8_t porta, vibrato, vib_speed, vib_depth, vib_pos, vib_wave;
    uint8_t trem_speed, trem_depth, trem_pos, trem_wave, tremor_count;
    uint8_t retrig_count, retrig_param, loop_row, loop_count, gliss;
    uint8_t delayed[5], delay, cut, fine;
    uint32_t random;
} ug_s3m_channel;
typedef struct {
    ug_s3m_info info;
    ug_s3m_channel channel[32];
    ug_mod_read_fn read;
    void *ctx;
    uint16_t order,row_tick;
    uint8_t row, tick, speed, bpm, volume, playing, paused, error, loop_song;
    uint8_t delay, pending_speed, pending_bpm;
    int16_t jump, break_row, loop_row;
    uint32_t tempo_fraction, dirty_note, dirty_volume;
} ug_s3m_player;
void ug_s3m_start(ug_s3m_player *,const ug_s3m_info *,ug_mod_read_fn,void *,uint8_t);
void ug_s3m_tick(ug_s3m_player *);
int ug_s3m_seek(ug_s3m_player *,uint16_t,uint8_t);
uint64_t ug_s3m_step(const ug_s3m_channel *);
