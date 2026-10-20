/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * E1MAGIC / Pico-based GPIO25 diagnostic. Not a production status API.
 */
#ifndef UG_LED_DIAG_H
#define UG_LED_DIAG_H
#include <stdint.h>
#include <stdbool.h>
enum {
    UG_LED_INIT=1, UG_LED_WAIT_CORE1=2, UG_LED_RUNNING=3,
    UG_LED_CONFIG_READS=4, UG_LED_HOLD_TIMEOUT=5, UG_LED_MAP_PC=6,
    UG_LED_MAP_INVALID=7, UG_LED_CORE0_STALLED=8, UG_LED_GUARD_STALLED=9
};
#ifdef UG_LED_DIAG
#ifdef __cplusplus
extern "C" {
#endif
/* Single writers; aligned counters are sampled by TIMER_IRQ_1 on core0. */
extern uint32_t ug_led_main_beats,ug_led_guard_beats,ug_led_config_reads;
void ug_led_diag_init(bool pico_based);
void ug_led_diag_stage(unsigned stage);
void ug_led_diag_fault(unsigned reason);
#ifdef __cplusplus
}
#endif
static inline void ug_led_diag_main_beat(void) {
    __atomic_store_n(&ug_led_main_beats,__atomic_load_n(&ug_led_main_beats,__ATOMIC_RELAXED)+1u,__ATOMIC_RELAXED);
}
static inline void ug_led_diag_guard_beat(void) {
    __atomic_store_n(&ug_led_guard_beats,__atomic_load_n(&ug_led_guard_beats,__ATOMIC_RELAXED)+1u,__ATOMIC_RELAXED);
}
static inline void ug_led_diag_read(uint16_t port) {
    if(port>=0x1d0 && port<=0x1d2)
        __atomic_store_n(&ug_led_config_reads,__atomic_load_n(&ug_led_config_reads,__ATOMIC_RELAXED)+1u,__ATOMIC_RELAXED);
}
#else
static inline void ug_led_diag_init(bool pico_based) {(void)pico_based;}
static inline void ug_led_diag_stage(unsigned stage) {(void)stage;}
static inline void ug_led_diag_fault(unsigned reason) {(void)reason;}
static inline void ug_led_diag_main_beat(void) {}
static inline void ug_led_diag_guard_beat(void) {}
static inline void ug_led_diag_read(uint16_t port) {(void)port;}
#endif
#endif
