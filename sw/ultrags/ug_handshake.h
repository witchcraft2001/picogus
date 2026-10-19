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
/* /IOR was low in the snapshot. Native PIO ownership inverts it to tag bit26
 * along with the other bits, preserving the complete captured address. */
static inline bool ug_handshake_native(uint32_t snapshot) {
    return (snapshot & (1u << 26)) != 0;
}
/* IN_BASE=A5: A0..A4 wrap to bits 27..31, A5..A9 occupy bits 0..4. */
static inline uint16_t ug_handshake_port(uint32_t snapshot) {
    if(ug_handshake_native(snapshot)) snapshot=~snapshot;
    return ((snapshot >> 27) & 31u) | ((snapshot & 31u) << 5);
}
void ug_handshake_init(unsigned offset, uint16_t base, uint16_t alias);
bool ug_handshake_sync_ports(uint16_t base, uint16_t alias);
void ug_handshake_guard_core1(void);
bool ug_handshake_guard_ready(void);
bool ug_handshake_failed(void);
#ifdef __cplusplus
}
#endif
#endif
