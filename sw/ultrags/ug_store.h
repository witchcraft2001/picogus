/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "ug_pcm.h"
#define UG_OBJECT_LIMIT 128u
typedef struct {
    uint32_t offset, reserved, size, uploaded, crc;
    uint16_t handle, pins;
    uint8_t kind, state;
    uint8_t pcm_valid, mod_valid;
    ug_pcm_info pcm;
} ug_object_t;
typedef struct {
    ug_object_t objects[UG_OBJECT_LIMIT];
    uint32_t pool, next_handle;
    uint16_t count;
    uint64_t session;
} ug_store_t;
void ug_store_init(ug_store_t *s, uint32_t pool, uint64_t session);
void ug_store_reset(ug_store_t *s);
/* Shared reservation path for EXT and future legacy LOAD. No heap; free
 * extents are the gaps in the ordered live table and coalesce implicitly. */
uint8_t ug_store_reserve(ug_store_t *s, uint8_t kind, uint32_t size, ug_object_t **out);
uint8_t ug_store_free(ug_store_t *s, uint16_t handle);
ug_object_t *ug_store_find(ug_store_t *s, uint16_t handle);
uint8_t ug_store_pin(ug_store_t *s, uint16_t handle, bool pin);
uint16_t ug_store_enum(const ug_store_t *s, uint16_t after);
void ug_store_space(const ug_store_t *s, uint32_t *free_bytes, uint32_t *largest);
