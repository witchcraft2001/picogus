/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  Ultra GS S0a standalone diagnostic image ("pg-ultrags-diag").
 *  Mirrors the baseline picogus.cpp startup (clock, board detect,
 *  transceiver enable, ISA PIO) minus mode emulation; core 1 runs
 *  the synthetic render spike. Flash origin is the standalone SDK
 *  base (0x10000000); this image is NOT slot-linked and cannot run
 *  inside a multifw bundle.
 */
#include <stdio.h>
#include <string.h>
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "pico/rand.h"
#include "hardware/clocks.h"
#include "hardware/adc.h"
#include "hardware/irq.h"
#include "hardware/structs/xip_ctrl.h"
#include "hardware/watchdog.h"
#include "hardware/structs/vreg_and_chip_reset.h"
#include "include/pg_debug.h"
#include "system/overclock.h"
#include "diag_iow.pio.h"
#ifdef UG_DIAG_NO_DACK
#define iow_program diag_iow_no_dack_program
#define iow_program_init diag_iow_no_dack_program_init
#else
#define iow_program diag_iow_program
#define iow_program_init diag_iow_program_init
#endif
#define ior_program diag_ior_program
#define ior_program_init diag_ior_program_init
#include "ug_diag_guard.h"
#include "isa/isa_bus.h"
#include "M62429.pio.h"
#include "picogus.h"
#include "ug_hwmap.h"
#include "ug_spike.h"
#include "M62429/M62429.h"

/* PIN constants shared with isa_io.pio */
#define IOW_PIN 4
#define IOR_PIN 5
#define AD0_PIN 6
#define DACK_PIN 19
#define IRQ_PIN 21
#define IOCHRDY_PIN 26
#define ADS_PIN 27

#define IOW_PIO_SM 0
#define IOR_PIO_SM 1

uint8_t BOARD_TYPE;   /* common/picogus.h board_type_t */

const char *firmware_string = PICO_PROGRAM_NAME " v" PICO_PROGRAM_VERSION_STRING;

static M62429 *m62429;

extern "C" void handle_iow(void);
extern "C" void handle_ior(void);
extern "C" void ug_diag_maybe_reboot(void);
extern "C" void ug_diag_isa_boot(uint32_t nonce);

static bool iow_has_data(void) {
    return (pio0->fstat & (1u << (PIO_FSTAT_RXEMPTY_LSB + IOW_PIO_SM))) == 0;
}
static bool ior_has_data(void) {
    return (pio0->fstat & (1u << (PIO_FSTAT_RXEMPTY_LSB + IOR_PIO_SM))) == 0;
}

static void err_blink(void) {
    /* same panic LED loop as baseline */
    for (;;) {
        gpio_xor_mask(1u << (BOARD_TYPE == PICOGUS_2 ? 23 : PICO_DEFAULT_LED_PIN));
        busy_wait_ms(250);
    }
}

int main() {
    busy_wait_ms(250);
    overclock_370mhz();
    stdio_init_all();
    DBG_PUTS(firmware_string);

    io_rw_32 *reset_reason =
        (io_rw_32 *)(VREG_AND_CHIP_RESET_BASE +
                     VREG_AND_CHIP_RESET_CHIP_RESET_OFFSET);
    if (*reset_reason & VREG_AND_CHIP_RESET_CHIP_RESET_HAD_POR_BITS) {
        DBG_PUTS("POR/BOD reset");
    } else if (*reset_reason &
               VREG_AND_CHIP_RESET_CHIP_RESET_HAD_RUN_BITS) {
        DBG_PUTS("RUN pin reset (ISA RESET or manual)");
    } else if (*reset_reason &
               VREG_AND_CHIP_RESET_CHIP_RESET_HAD_PSM_RESTART_BITS) {
        DBG_PUTS("debug port restart");
    }

    /* copy_to_ram image: XIP only needed for settings we do not read */
    hw_clear_bits(&xip_ctrl_hw->ctrl, XIP_CTRL_EN_BITS);

    /* Board detect: GPIO29 grounded on PicoGUS 2.0, ~1.666V on Pico.
     * GPIO25 must be driven high on Pico to read VSYS/3. */
    gpio_init(25);
    gpio_set_dir(25, GPIO_OUT);
    gpio_put(25, 1);
    adc_init();
    adc_gpio_init(29);
    adc_select_input(3);
    adc_read(); adc_read(); adc_read(); adc_read(); adc_read();
    uint16_t adc_v = adc_read();
    DBG_PRINTF("ADC: 0x%03x ", adc_v);
    gpio_put(25, 0);
    gpio_deinit(25);

    if (adc_v > 0x100) {
        DBG_PUTS("Pico-based board");
        gpio_init(PICO_DEFAULT_LED_PIN);
        gpio_set_dir(PICO_DEFAULT_LED_PIN, GPIO_OUT);
        BOARD_TYPE = PICO_BASED;
    } else {
        DBG_PUTS("PicoGUS 2.0");
        gpio_init(23);
        gpio_set_dir(23, GPIO_OUT);
        BOARD_TYPE = PICOGUS_2;
    }
    gpio_set_mask(1u << (BOARD_TYPE == PICOGUS_2 ? 23 : PICO_DEFAULT_LED_PIN));

    if (BOARD_TYPE == PICOGUS_2) {
        /* PIO1 SM0 is claimed explicitly so the audit sees it */
        if (!pio_can_add_program(pio1, &m62429_program) ||
            ug_hw_claim_m62429(pio1) != 0) err_blink();
        {
            m62429 = new M62429();
            m62429->begin(24, 25, pio1, UG_M62429_SM);
        }
    }

    gpio_init(IRQ_PIN);
    gpio_put(IRQ_PIN, 0); /* Set inactive latch BEFORE enabling output. */
    gpio_set_dir(IRQ_PIN, GPIO_OUT);
    gpio_set_drive_strength(IRQ_PIN, GPIO_DRIVE_STRENGTH_12MA);

    DBG_PUTS("Enabling bus transceivers (ADS waggle)");
    for (uint i = AD0_PIN; i < AD0_PIN + 10; i++) {
        gpio_init(i);
        gpio_set_dir(i, GPIO_IN);
    }
    isa_bus_prepare(AD0_PIN, IOW_PIN, IOR_PIN, IOCHRDY_PIN, ADS_PIN);
    irq_set_enabled(PIO0_IRQ_1, false);
    irq_set_enabled(DMA_IRQ_0, false);

    ug_diag_isa_boot(get_rand_32());
    ug_spike_link_init();
    multicore_launch_core1(ug_spike_core1);
    while (!ug_diag_guard_ready()) tight_loop_contents();
    DBG_PUTS("Starting ISA PIO");
    if (!pio_can_add_program(pio0, &iow_program) ||
        !pio_can_add_program(pio0, &ior_program)) {
        ERR_PUTS("PIO0 instruction space exhausted");
        err_blink();
    }
    ug_hw_claim_isa();
    uint iow_offset = pio_add_program(pio0, &iow_program);
    if (!pio_can_add_program(pio0, &ior_program)) err_blink();
    uint ior_offset = pio_add_program(pio0, &ior_program);
    ug_hw_note_program(pio0, iow_offset, iow_program.length, "iow");
    ug_hw_note_program(pio0, ior_offset, ior_program.length, "ior");

    constexpr float iow_clkdiv = (float)RP2_CLOCK_SPEED / 183000.0f;
    iow_program_init(pio0, IOW_PIO_SM, iow_offset, iow_clkdiv);
    ior_program_init(pio0, IOR_PIO_SM, ior_offset);

    ug_diag_guard_bus_started();
    for (;;) {
        /* drain all pending IOW before serving IOR: keeps the
         * write-before-read ordering the control protocol expects */
        while (iow_has_data()) handle_iow();
        if (ior_has_data()) handle_ior();
        ug_diag_maybe_reboot();
    }
}
