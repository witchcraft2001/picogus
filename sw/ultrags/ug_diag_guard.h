/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 * This program is distributed without any warranty; see the GNU General
 * Public License for more details.
 * */
#ifndef UG_DIAG_GUARD_H
#define UG_DIAG_GUARD_H
#include <stdbool.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
void ug_diag_guard_init_core1(void);
bool ug_diag_guard_ready(void);
bool ug_diag_guard_failed(void);
void ug_diag_guard_arm(unsigned pin);
bool ug_diag_guard_delay(uint16_t us);
void ug_diag_guard_bus_started(void);
void ug_diag_guard_wait_bus(void);
#ifdef __cplusplus
}
#endif
#endif
