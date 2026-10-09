/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#pragma once
#include "hardware/pio.h"
#ifdef __cplusplus
extern "C" {
#endif
/* SRAM-only diagnostics, deliberately outside STATS/SNAPSHOT wire ABI.
 * Microseconds here are coarse instrumentation, never physical ISA evidence. */
typedef struct {
    uint32_t drained, backlog_max, service_hiatus_max_us, service_max_us;
    uint32_t fence_max_us, fences, overflow, in_flight;
} ug_posted_diagnostics;
extern volatile ug_posted_diagnostics ug_posted_diag;
void ug_posted_init(unsigned offset);
void ug_posted_check(void (*fault)(void));
void ug_posted_write(uint32_t word, void (*apply)(uint32_t));
void ug_posted_read(uint16_t port, bool (*owns)(uint16_t,const uint32_t *,unsigned),
                    void (*apply)(uint32_t), uint8_t (*read)(uint16_t),void (*fault)(void));
/* Diagnostic-only finite assertion/response injection. A false guard
 * verdict means an independent hardware fuse has already released ISA. */
void ug_posted_read_guarded(uint16_t port,bool (*owns)(uint16_t,const uint32_t *,unsigned),
                    void (*apply)(uint32_t),uint8_t (*read)(uint16_t),void (*fault)(void),
                    bool (*guard)(bool value_phase));
#ifdef __cplusplus
}
#endif
