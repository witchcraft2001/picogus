/* SPDX-License-Identifier: GPL-2.0-or-later
 * Only short SRAM copies under lock; core0 never waits for a core1 operation.
 */
#include "ug_diag_link.h"
#include "pico/mutex.h"
#include <string.h>
static mutex_t lock;
static bool pending;
static uint8_t command;
static uint16_t argument;
static ug_diag_status snapshot;

void ug_diag_link_init(void) {
    mutex_init(&lock);
    pending = false;
    memset(&snapshot, 0, sizeof(snapshot));
    snapshot.magic0 = UG_DIAG_MAGIC0;
    snapshot.magic1 = UG_DIAG_MAGIC1;
    snapshot.version = UG_DIAG_VERSION;
    snapshot.state = UGD_STATE_INIT;
}
bool ug_diag_link_send(uint8_t cmd, uint16_t arg) {
    if (!mutex_try_enter(&lock, NULL)) return false;
    bool accepted = !pending;
    if (accepted) { command = cmd; argument = arg; pending = true; }
    mutex_exit(&lock);
    return accepted;
}
bool ug_diag_link_take(uint8_t *cmd, uint16_t *arg) {
    mutex_enter_blocking(&lock);
    bool ready = pending;
    if (ready) { *cmd = command; *arg = argument; pending = false; }
    mutex_exit(&lock);
    return ready;
}
void ug_diag_link_publish(const ug_diag_status *status) {
    mutex_enter_blocking(&lock);
    snapshot = *status;
    mutex_exit(&lock);
}
bool ug_diag_link_snapshot(ug_diag_status *out) {
    if (!mutex_try_enter(&lock, NULL)) return false;
    *out = snapshot;
    mutex_exit(&lock);
    return true;
}
