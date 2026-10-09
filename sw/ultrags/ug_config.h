/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#pragma once
#include "system/flash_settings.h"
#include "multifw/ug_catalog.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
    Settings *settings;
    uint8_t catalog[148], snapshot[148];
    uint16_t index;
    uint8_t selector, low, active, boot_result, result;
    bool catalog_ok, aliases;
    uint32_t verified;
    /* Mainline core0 publishes immutable SAVE snapshot with release ordering. */
    unsigned maintenance;
    Settings save_snapshot;
} ug_config;
extern ug_config ug_cfg;
extern volatile uint32_t ug_raw_watchdog_reason,ug_raw_chip_reset;
void ug_config_init(ug_config *c, Settings *s, uint8_t active, const uint8_t *catalog,
                    uint32_t magic, uint32_t packed, uint32_t checked);
bool ug_config_selector(uint8_t s);
void ug_config_select(ug_config *c, uint8_t selector);
uint8_t ug_config_read(ug_config *c, bool high);
void ug_config_write(ug_config *c, bool high, uint8_t value, bool idle);
uint8_t ug_ports_validate(uint16_t base, uint16_t alias);
bool ug_config_busy(const ug_config *c);
/* Core0 may toggle aliases while core1 is preparing CAPS. */
bool ug_config_aliases(const ug_config *c);
void ug_config_save_done(ug_config *c, bool verified);
void ug_maintenance_poll(void);
void ug_runtime_init(Settings *s, uint8_t active);
bool ug_runtime_idle(void);
bool ug_runtime_gs_idle(void);
#ifdef __cplusplus
}
#endif
