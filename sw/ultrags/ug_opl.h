/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#ifndef UG_OPL_H
#define UG_OPL_H
#include <stdbool.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
enum { UG_OPL_PORT=0x388, UG_OPL_CAPACITY=256 };
typedef struct { uint8_t reg, value; } ug_opl_command;
typedef struct {
    uint32_t producer, consumer;
    ug_opl_command commands[UG_OPL_CAPACITY];
} ug_opl_queue;
bool ug_opl_enqueue(ug_opl_queue *q, uint8_t reg, uint8_t value);
unsigned ug_opl_snapshot(const ug_opl_queue *q);
bool ug_opl_pop(ug_opl_queue *q, ug_opl_command *out);
/* Core0: false means retain and retry the data write under IOCHRDY. */
bool ug_opl_write(uint16_t port, uint8_t value, uint32_t now);
uint8_t ug_opl_status(uint32_t now);
/* Core0-owned cached reply. Nothing in the ISA polling loop touches the
 * timers: a one-shot core0 alarm (picogus.cpp) calls ug_opl_poll at
 * ug_opl_timer_deadline, the earliest pending overflow, valid while
 * ug_opl_timer_poll_needed. Flags stay set until a reset, so one alarm per
 * start/reset suffices. */
extern uint8_t ug_opl_status_value;
extern bool ug_opl_timer_poll_needed;
extern uint32_t ug_opl_timer_deadline;
void ug_opl_poll(uint32_t now);
/* Firmware hook: (re)arm or disarm that alarm after a timer change. */
void ug_opl_timer_schedule(void);
bool ug_opl_busy(void);
void ug_opl_volume(uint8_t percent);
/* Core1 only. Initialization does not erase already captured commands. */
void ug_opl_init(void);
const int32_t *ug_opl_render(unsigned frames);
#ifdef __cplusplus
}
#endif
#endif
