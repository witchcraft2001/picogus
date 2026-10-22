/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#ifndef UG_COMPAT_H
#define UG_COMPAT_H
#include "ug_handshake.h"
#include "hardware/pio.h"
#ifdef __cplusplus
extern "C" {
#endif
void ug_compat_init(unsigned offset, uint16_t base, uint16_t alias, bool gs);
/* Publish BASE/ALIAS and the GS alias block (00A0h..00BFh) to the PIO
 * classifier. Called before every write acknowledge; cheap when unchanged. */
bool ug_compat_sync_ports(uint16_t base, uint16_t alias, bool gs);
void ug_compat_note_write(uint32_t verdict);
/* First TX word for a PIO-owned read; absolute instruction address. */
extern uint32_t ug_compat_read_entry;
extern uint32_t ug_compat_read_restart;
/* Serviced replies and WAIT releases, read by the core1 fuse. */
extern unsigned ug_compat_completions;
static inline void ug_compat_note_read(void) {
    __atomic_fetch_add(&ug_compat_completions, 1u, __ATOMIC_RELEASE);
}
#if !PICO_NO_HARDWARE /* real builds define it as 0; host mocks as 1 */
/* IOR verdicts are relocated PCs for the classifier's OUT PC: IO_WAIT
 * becomes the value entry (stretch, then 0xFF00|byte), IO_END the restart
 * (ignore/release). IOW words are passed through unchanged. */
static inline void ug_compat_put(PIO pio, unsigned sm, uint32_t word) {
    if (sm != 1) { pio_sm_put(pio, sm, word); return; }
    if (word == UINT32_MAX) { pio_sm_put(pio, sm, ug_compat_read_entry); return; }
    pio_sm_put(pio, sm, word ? word : ug_compat_read_restart);
    ug_compat_note_read();
}
#endif
#ifdef __cplusplus
}
#endif
#endif
