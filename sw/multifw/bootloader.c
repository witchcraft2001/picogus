/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "pico/stdlib.h"
#include "hardware/watchdog.h"
#include "hardware/structs/watchdog.h"
#include "hardware/regs/vreg_and_chip_reset.h"
#include "system/flash_settings.h"
#include "ug_catalog.h"
#include "recovery.h"
/* Kept in SRAM for SWD diagnosis, without occupying SDK scratch[4..7]. */
volatile uint32_t ug_raw_watchdog_reason, ug_raw_chip_reset;
int main(void) {
    bool wd=watchdog_caused_reboot();
    ug_raw_watchdog_reason=watchdog_hw->reason;
    ug_raw_chip_reset=*(volatile uint32_t *)(VREG_AND_CHIP_RESET_BASE+VREG_AND_CHIP_RESET_CHIP_RESET_OFFSET);
    uint32_t request=watchdog_hw->scratch[3];
    watchdog_hw->scratch[3]=0;
    const Settings *s=(const Settings *)(XIP_BASE+UG_SETTINGS_OFFSET);
    bool valid=s->magic==SETTINGS_MAGIC && s->version>=1 && s->version<=SETTINGS_VERSION;
    static const ug_image recovery=UG_RECOVERY;
    ug_boot b=ug_boot_select((const uint8_t *)XIP_BASE,0x200000,&recovery,wd,&request,valid?s->startupMode:1,valid);
    watchdog_hw->scratch[0]=UG_HANDOFF_MAGIC;
    watchdog_hw->scratch[1]=(b.requested&255)|((uint32_t)b.active<<8)|((uint32_t)b.result<<16)|0x01000000u;
    watchdog_hw->scratch[2]=b.verified;
    if(b.safe) for(;;) tight_loop_contents();
    uint32_t vector=XIP_BASE+b.image.offset+0x100;
    __asm volatile("str %0, [%1]\n ldmia %0!, {r0,r1}\n msr msp,r0\n bx r1\n"
        : : "r"(vector), "r"(PPB_BASE+M0PLUS_VTOR_OFFSET) : "r0","r1","memory");
    __builtin_unreachable();
}
