/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_config.h"
#include "hardware/structs/watchdog.h"
#include "hardware/structs/xip_ctrl.h"
#include "hardware/structs/vreg_and_chip_reset.h"
#include "pico/stdlib.h"
#include <string.h>
#ifdef SOUND_ULTRAGS
#include "ug_minimal.h"
extern void ug_save_prepare(void);
extern void ug_save_restore(void);
#endif
/* The bootloader's SRAM is overwritten by copy-to-RAM startup. Capture
 * the same hardware registers in each runtime so SWD can inspect them
 * after the selected image has started. Do not consume SDK scratch[4..7]. */
volatile uint32_t ug_raw_watchdog_reason,ug_raw_chip_reset;
void ug_runtime_init(Settings *s,uint8_t active) {
    ug_raw_watchdog_reason=watchdog_hw->reason;
    ug_raw_chip_reset=vreg_and_chip_reset_hw->chip_reset;
#ifdef UG_BUNDLE
    ug_config_init(&ug_cfg,s,active,(const uint8_t *)(XIP_BASE+UG_CATALOG_OFFSET),
        watchdog_hw->scratch[0],watchdog_hw->scratch[1],watchdog_hw->scratch[2]);
#else
    ug_config_init(&ug_cfg,s,active,NULL,0,0,0);
#endif
    watchdog_hw->scratch[0]=watchdog_hw->scratch[1]=watchdog_hw->scratch[2]=0;
}
bool ug_runtime_idle(void) {
#ifdef SOUND_ULTRAGS
    return ug_minimal_idle();
#else
    return true;
#endif
}
bool ug_runtime_gs_idle(void) {
#ifdef SOUND_ULTRAGS
    return ug_minimal_gs_idle();
#else
    return true;
#endif
}
void ug_maintenance_poll(void) {
    if(!ug_config_busy(&ug_cfg)) return;
#ifdef SOUND_ULTRAGS
    /* The pending flag prevents core0 starting a transaction after the idle gate. */
    if(!ug_runtime_idle()) { ug_config_save_done(&ug_cfg,false); return; }
    ug_save_prepare();
#endif
    saveSettings(&ug_cfg.save_snapshot);
    /* flash_range_program restores XIP. Read back before disabling it again. */
    bool ok=!memcmp((const void *)(XIP_BASE+UG_SETTINGS_OFFSET),&ug_cfg.save_snapshot,sizeof(Settings));
    hw_clear_bits(&xip_ctrl_hw->ctrl,XIP_CTRL_EN_BITS);
#ifdef SOUND_ULTRAGS
    ug_save_restore();
#endif
    ug_config_save_done(&ug_cfg,ok);
}
