/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  Ultra GS S0a render spike orchestration (runs on core 1).
 */
#ifndef UG_SPIKE_H
#define UG_SPIKE_H

#include <stdint.h>
#include <stdbool.h>
#include "ug_diag.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Declared test pool (8 MiB expectation of the PicoGUS 2.0 APS6404;
 * a quick probe pass does NOT prove this). */
#define UG_SPIKE_POOL_BYTES (8u << 20)

/* core1 entry: inits PSRAM + I2S + mixer, serves the render loop.
 * Never returns; on init fault publishes UGD_STATE_ERR. */
void ug_spike_core1(void);

/* core0 -> core1 command channel (written by ISA handler) */
void ug_spike_link_init(void); /* core0, before launching core1 */
uint8_t ug_spike_cmd(uint8_t cmd, uint16_t arg_quanta);

/* published snapshot for the ISA read path */
bool ug_spike_status(ug_diag_status *out); /* nonblocking coherent copy */
void ug_spike_publish(void);


#ifdef __cplusplus
}
#endif
#endif /* UG_SPIKE_H */
