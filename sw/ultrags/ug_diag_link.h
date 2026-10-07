/* SPDX-License-Identifier: GPL-2.0-or-later
 * Bounded diagnostic mailbox and coherent snapshots. No production wire ABI.
 */
#ifndef UG_DIAG_LINK_H
#define UG_DIAG_LINK_H
#include <stdbool.h>
#include "ug_diag.h"
void ug_diag_link_init(void);
bool ug_diag_link_send(uint8_t cmd, uint16_t arg);
bool ug_diag_link_take(uint8_t *cmd, uint16_t *arg);
void ug_diag_link_publish(const ug_diag_status *status);
bool ug_diag_link_snapshot(ug_diag_status *out);
#endif
