/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#pragma once
#include "ug_psram.h"
#define UG_QUICK_POINTS 64
/* Core1 only. Each step performs at most 256 bytes of PSRAM I/O. */
typedef struct {
    ug_psram_t *ps;
    uint32_t physical, tested, first_bad, started, elapsed_ms, offset;
    uint32_t points[UG_QUICK_POINTS];
    uint8_t expected, actual, status, phase, pass, index, count, mode;
    bool active, probe;
    uint8_t buffer[UG_PSRAM_CHUNK];
} ug_memory_job_t;
#ifdef __cplusplus
extern "C" {
#endif
void ug_memory_start(ug_memory_job_t *j,ug_psram_t *ps,bool probe,uint8_t mode,uint32_t now);
void ug_memory_step(ug_memory_job_t *j,uint32_t now);
void ug_memory_cancel(ug_memory_job_t *j,uint32_t now);

#ifdef __cplusplus
}
#endif
