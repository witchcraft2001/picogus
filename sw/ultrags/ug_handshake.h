/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#ifndef UG_HANDSHAKE_H
#define UG_HANDSHAKE_H
#include <stdbool.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* The PIO snapshots the active-low strobe before classifying the address,
 * then complements the snapshot ONLY for its owned branch. /IOW is bit25,
 * /IOR bit26 in the GPIO11-rotated word. This does not sample WAIT feedback. */
static inline bool ug_handshake_native(unsigned sm,uint32_t snapshot) {
    return (snapshot&(1u<<(sm?26:25)))!=0;
}
/* A5 is bit0; the full pin snapshot wraps A0..A4 into bits27..31. */
static inline uint16_t ug_handshake_port(unsigned sm,uint32_t snapshot) {
    if(ug_handshake_native(sm,snapshot)) snapshot=~snapshot;
    return ((snapshot>>27)&31u)|((snapshot&31u)<<5);
}
static inline uint8_t ug_handshake_data(uint32_t snapshot) {
    return (uint8_t)((snapshot>>27)|((snapshot&7u)<<5));
}
void ug_handshake_init(unsigned offset,uint16_t base,uint16_t alias,bool gs);
bool ug_handshake_sync_ports(uint16_t base,uint16_t alias,bool gs);
/* IOR CONFIG is stretched immediately on capture, before a pending write's
 * work. False for a stale/foreign read: its consuming handler must not run. */
bool ug_handshake_capture(unsigned sm,uint16_t port,bool owned);
/* A software CONFIG wait is not proof that the host accepted stretching.
 * Recheck before a consuming handler after applying a preceding IOW. */
bool ug_handshake_read_active(void);
void ug_handshake_put(unsigned sm,uint32_t word);
void ug_handshake_poll(void);
void ug_handshake_guard_core1(void);
bool ug_handshake_guard_ready(void);
bool ug_handshake_failed(void);
#ifdef __cplusplus
}
#endif
#endif
