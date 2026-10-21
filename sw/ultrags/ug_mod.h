/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * Native Ultra GS MOD4/MOD8 reader and tracker. All source bytes remain in the
 * immutable object store and are accessed through a bounded reader callback.
 */
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef int (*ug_mod_read_fn)(void *ctx, uint32_t offset, uint8_t *dst, uint32_t len);

typedef struct {
    uint32_t length, loop_start, loop_length;
    uint32_t sample_bytes;
    int8_t finetune;
    uint8_t volume;
} ug_mod_sample;

typedef struct {
    uint32_t pattern_offset, sample_offset, file_size;
    ug_mod_sample samples[31];
    uint8_t song_length, restart, order[128], channels;
} ug_mod_info;

typedef struct {
    uint16_t period, base_period, target_period;
    uint8_t sample, voice_sample, volume, mix_volume, pan, effect, param, note;
    uint8_t vibrato_pos, tremolo_pos;
    uint8_t loop_row, loop_count, porta_speed, vibrato_speed, vibrato_depth;
    uint8_t tremolo_speed, tremolo_depth, delayed_sample, delayed_note, delayed_tick;
    uint16_t delayed_period;
    uint32_t sample_offset, offset_memory, random_state;
    uint32_t trigger;
    uint8_t wave_vibrato, wave_tremolo, glissando;
    int8_t fine;
} ug_mod_channel;

typedef struct {
    ug_mod_info info;
    ug_mod_channel channel[8];
    uint16_t order;
    uint8_t row, tick, speed, bpm, paused, playing, loop_song, f00_mode, pattern_delay;
    uint8_t f00_policy; /* PLAY_MOD explicit bits; zero follows legacy 6A. */
    uint8_t dirty_note, dirty_volume;
    uint32_t tempo_fraction;
    uint8_t pending_speed, pending_bpm, error;
    int16_t global_jump_order;
    int8_t global_break_row;
    ug_mod_read_fn read;
    void *read_ctx;
} ug_mod_player;

/* Cooperative SEAL validation: one <=256-byte read per step, including events.
 * The caller owns the descriptor and cursor until completion. */
typedef struct { uint32_t cursor,total; uint8_t stage,sample; } ug_mod_parser;
void ug_mod_parser_init(ug_mod_parser *p, ug_mod_info *out, uint32_t size);
/* 0=pending, 1=done, -1=format, -2=read error. */
int ug_mod_parser_step(ug_mod_parser *p, ug_mod_info *out, ug_mod_read_fn read, void *ctx);
/* Validate a 31-instrument M.K./M!K!/8CHN header/layout. -1=format, -2=backend read error. */
int ug_mod_parse(ug_mod_info *out, ug_mod_read_fn read, void *ctx, uint32_t size);
void ug_mod_start(ug_mod_player *p, const ug_mod_info *info, ug_mod_read_fn read,
                  void *ctx, uint8_t flags, uint8_t legacy_f00_mode);
void ug_mod_stop(ug_mod_player *p);
void ug_mod_tick(ug_mod_player *p);
/* Stage an atomic speed/BPM update at the next tick boundary. */
void ug_mod_tempo(ug_mod_player *p, uint8_t speed, uint8_t bpm);
int ug_mod_seek(ug_mod_player *p, uint16_t order, uint8_t row);
uint32_t ug_mod_frames_to_tick(const ug_mod_player *p);
void ug_mod_advance_frames(ug_mod_player *p, uint32_t frames);

