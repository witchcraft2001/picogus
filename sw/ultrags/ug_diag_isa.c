/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  Ultra GS S0a standalone diagnostic -- ISA front-end (core 0).
 *  Implements the standard PicoGUS control channel (0x1D0 unlock 0xCC
 *  + selector, 0x1D1/0x1D2 data) for the fixed read-only registers
 *  plus diagnostic-private selectors 0x80-0x82 (ug_spike control).
 *  Write-side counters (iow/ior) feed the status record.
 *
 *  Contract inherited from picogus.cpp: every captured IOW/IOR must
 *  get a verdict word pushed back (IO_WAIT then IO_END/value, or
 *  IO_END alone), and core0 never blocks on core1 work.
 */
#include <stdint.h>
#include <stdbool.h>
#include "hardware/pio.h"
#include "pico/platform.h"
#include "pico/stdlib.h"
#include "hardware/watchdog.h"
#include "picogus.h"
#include "ug_diag.h"
#include "ug_spike.h"
#include "ug_hwmap.h"

#define IO_WAIT       0xffffffffu
#define IO_END        0x0u
#define IOR_SET_VALUE 0x0000ff00u

extern const char *firmware_string;
extern uint8_t BOARD_TYPE;   /* set by diag_main after ADC probe */

static bool control_active;
static uint8_t sel_reg;
static uint32_t cur_read;
static uint16_t diag_arg;    /* staged via UGD_SEL_ARG */
static volatile uint32_t n_iow, n_ior;
static ug_diag_status snapshot;
static bool snapshot_valid;
static uint8_t cmd_result;
static bool reboot_pending;

/* verdict helpers ---------------------------------------------------- */
static inline void iow_end(void) {
    pio_sm_put(pio0, UG_IOW_SM, IO_END);
}
static inline void iow_wait(void) {
    pio_sm_put(pio0, UG_IOW_SM, IO_WAIT);
}
static inline void iow_done(void) {
    /* second word finishes a WAITed write */
    pio_sm_put(pio0, UG_IOW_SM, IO_END);
}
static inline void ior_value(uint8_t v) {
    pio_sm_put(pio0, UG_IOR_SM, IO_WAIT);
    pio_sm_put(pio0, UG_IOR_SM, IOR_SET_VALUE | v);
}
static inline void ior_passthrough(void) {
    pio_sm_put(pio0, UG_IOR_SM, IO_END);  /* 0 condition -> bus floats */
}

static uint8_t diag_read_high(void) {
    const uint8_t *b = (const uint8_t *)&snapshot;
    switch (sel_reg) {
    case CMD_MAGIC:    return 0xDD;
    case CMD_PROTOCOL: return PICOGUS_PROTOCOL_VER;
    case CMD_FWSTRING: {
        uint8_t c = (uint8_t)firmware_string[cur_read++];
        if (c == 0) cur_read = 0;
        return c;
    }
    case CMD_HWTYPE:   return BOARD_TYPE;
    case CMD_BOOTMODE: return 0;   /* INVALID_MODE: diag is not a mode */
    case UGD_SEL_CMD: {
        ug_diag_status current;
        return ug_spike_status(&current) ? current.state : 0xFF;
    }
    case UGD_SEL_STATUS: {
        if (!snapshot_valid || cur_read >= UG_DIAG_STATUS_SIZE) return 0xFF;
        return b[cur_read++];
    }
    default: return 0xFF;
    }
}

void __time_critical_func(handle_iow)(void) {
    uint32_t iow_read = pio_sm_get(pio0, UG_IOW_SM);
    /* autopushed word = addr(10)<<8 | data(8), same as baseline */
    uint16_t port = (iow_read >> 8) & 0x3FF;
    uint8_t value = iow_read & 0xFF;
    n_iow++;
    switch (port) {
    case CONTROL_PORT:
        if (!control_active) {
            iow_end();
            if (value == 0xCC) control_active = true;
            return;
        }
        iow_wait();
        sel_reg = value;
        if (sel_reg == CMD_FWSTRING || sel_reg == UGD_SEL_STATUS)
            cur_read = 0;
        if (sel_reg == UGD_SEL_ARG) diag_arg = 0;
        if (sel_reg == UGD_SEL_STATUS)
            snapshot_valid = ug_spike_status(&snapshot);
        iow_done();
        return;
    case DATA_PORT_LOW:
        iow_end();
        if (control_active && sel_reg == UGD_SEL_ARG)
            diag_arg = (diag_arg & 0xFF00) | value;
        return;
    case DATA_PORT_HIGH:
        if (!control_active) { iow_end(); return; }
        iow_wait();
        switch (sel_reg) {
        case CMD_REBOOT:
            if (value == 0xFF) reboot_pending = true;
            break;
        case UGD_SEL_CMD:
            cmd_result = ug_spike_cmd(value, diag_arg);
            break;
        case UGD_SEL_ARG:
            diag_arg = (diag_arg & 0x00FF) | ((uint16_t)value << 8);
            break;
        default:
            break;
        }
        iow_done();
        return;
    default:
        iow_end();
        return;
    }
}

void __time_critical_func(handle_ior)(void) {
    uint16_t port = pio_sm_get(pio0, UG_IOR_SM) & 0x3FF;
    n_ior++;
    switch (port) {
    case CONTROL_PORT:
        ior_value(sel_reg);
        return;
    case DATA_PORT_HIGH:
        if (!control_active) { ior_passthrough(); return; }
        ior_value(diag_read_high());
        return;
    case DATA_PORT_LOW:
        if (!control_active) { ior_passthrough(); return; }
        ior_value(sel_reg == UGD_SEL_CMD ? cmd_result :
                  sel_reg == UGD_SEL_STATUS && !snapshot_valid ? UGD_CMD_BUSY : 0);
        return;
    default:
        ior_passthrough();
        return;
    }
}

void ug_diag_maybe_reboot(void) {
    if (reboot_pending && gpio_get(4)) {
        reboot_pending = false;
        watchdog_reboot(0, 0, 1); /* Verdict/IOW complete before MCU reset. */
    }
}

void ug_diag_isa_stats(uint32_t *iow, uint32_t *ior) {
    *iow = n_iow;
    *ior = n_ior;
}
