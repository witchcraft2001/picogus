/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#ifndef UG_COMPAT_H
#define UG_COMPAT_H
#include "ug_handshake.h"
#ifdef __cplusplus
extern "C" {
#endif
void ug_compat_init(unsigned offset, uint16_t base, uint16_t alias);
bool ug_compat_sync_ports(uint16_t base, uint16_t alias);
void ug_compat_note_write(uint32_t verdict);
/* First TX word for a PIO-owned read; absolute instruction address. */
extern uint32_t ug_compat_read_entry;
extern uint32_t ug_compat_read_restart;
#ifdef __cplusplus
}
#endif
#endif
