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
#pragma once
#include <stdint.h>
#include <stdbool.h>
/* Core1-only legacy state; core0 observes only the published idle flag. */
bool ug_legacy_busy(void);
bool ug_legacy_loading(void);
void ug_legacy_reset(bool cold);
bool ug_legacy_command(uint8_t command,bool has_pre,uint8_t pre,
                       uint8_t *out,bool *db,uint8_t *error);
bool ug_legacy_accepts_data(void);
void ug_legacy_data(uint8_t value,uint8_t *error);
bool ug_legacy_reply(uint8_t *value);
void ug_legacy_reply_consumed(void);
