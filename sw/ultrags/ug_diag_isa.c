/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  Ultra GS S1 standalone diagnostic -- ISA front-end (core 0).
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
#include "ug_diag_guard.h"
#include <string.h>

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

/* Core0-only SRAM transport: one bounded grant, no core1 wait/PSRAM/CRC. */
static uint8_t sram[UGD_MAX_BLOCK], bus_snapshot[UGD_BUS_SIZE];
static uint16_t length, position, stored_length;
static uint8_t bus_state, write_pattern = 7, read_pattern = 7;
static uint32_t session = 1, written, read_bytes, errors, blocks;
static uint16_t assertion_us, response_us, staged_delay;
static void put32(uint8_t *dst, uint32_t n) {
    for (unsigned i = 0; i < 4; i++) dst[i] = (uint8_t)(n >> (8*i));
}
static void bus_latch(void) {
    memset(bus_snapshot, 0, sizeof(bus_snapshot));
    put32(bus_snapshot+UGD_BUS_SESSION, session);
    put32(bus_snapshot+UGD_BUS_WRITTEN, written);
    put32(bus_snapshot+UGD_BUS_READ, read_bytes);
    put32(bus_snapshot+UGD_BUS_ERRORS, errors);
    put32(bus_snapshot+UGD_BUS_BLOCKS, blocks);
    bus_snapshot[20] = position; bus_snapshot[21] = position >> 8;
    bus_snapshot[22] = length; bus_snapshot[23] = length >> 8;
    bus_snapshot[24] = bus_state;
    bus_snapshot[25] = ug_diag_guard_failed() ? 1 : 0;
#ifdef UG_DIAG_NO_DACK
    bus_snapshot[25] |= 2;
#endif
}
static void bus_command(uint8_t cmd) {
    if (ug_diag_guard_failed()) { errors++; return; }
    if (cmd == UGD_RESET) {
        session++; written = read_bytes = errors = blocks = 0;
        length = position = stored_length = 0; bus_state = 0;
        write_pattern = read_pattern = 7; return;
    }
    if (cmd == UGD_CANCEL) { bus_state = 0; position = 0; return; }
    if (cmd == UGD_END) {
        if (!bus_state || position != length) { errors++; bus_state = 0; return; }
        if (bus_state == UGD_WRITE) stored_length = length;
        blocks++; bus_state = 0; return;
    }
    if (bus_state || !length || length > UGD_MAX_BLOCK ||
        cmd < UGD_WRITE || cmd > UGD_PATTERN ||
        (cmd == UGD_ECHO && stored_length != length)) { errors++; return; }
    /* A new WRITE immediately supersedes the previous echo grant. CANCEL
     * or a short END must never expose a partially overwritten old block. */
    if (cmd == UGD_WRITE) stored_length = 0;
    bus_state = cmd; position = 0;
}
static void bus_write(uint8_t value) {
    if (bus_state != UGD_WRITE || position >= length) { errors++; bus_state = 0; return; }
    sram[position++] = value;
    if (value != write_pattern) errors++;
    write_pattern += 13; written++;
}
static uint8_t bus_read(void) {
    if ((bus_state != UGD_ECHO && bus_state != UGD_PATTERN) || position >= length) {
        errors++; bus_state = 0; return 0xff;
    }
    uint8_t value = bus_state == UGD_ECHO ? sram[position] : read_pattern;
    position++; read_bytes++; read_pattern += 13;
    return value;
}
/* Reboot only (not a diagnostic session reset) clears a fatal guard. */
void ug_diag_isa_reset(void) {
    control_active = snapshot_valid = reboot_pending = false;
    sel_reg = cmd_result = 0; cur_read = n_iow = n_ior = 0;
    assertion_us = response_us = staged_delay = 0;
    bus_command(UGD_RESET);
}

/* Boot nonce is supplied once, before PIO starts. Session RESET remains
 * monotonic within this boot; it never clears a fatal hardware guard. */
void ug_diag_isa_boot(uint32_t nonce) {
    session = nonce ? nonce - 1u : 0;
    ug_diag_isa_reset();
}

/* verdict helpers ---------------------------------------------------- */
static inline void iow_end(void) {
    if (!ug_diag_guard_failed()) pio_sm_put(pio0, UG_IOW_SM, IO_END);
}
static inline bool iow_wait(void) {
    ug_diag_guard_arm(4);
    if (!ug_diag_guard_delay(assertion_us)) return false;
    pio_sm_put(pio0, UG_IOW_SM, IO_WAIT);
    return true;
}
static inline void iow_done(void) {
    /* second word finishes a WAITed write */
    if (!ug_diag_guard_delay(response_us)) return;
    if (!ug_diag_guard_failed()) pio_sm_put(pio0, UG_IOW_SM, IO_END);
}
static inline bool ior_wait(void) {
    ug_diag_guard_arm(5);
    if (!ug_diag_guard_delay(assertion_us)) return false;
    pio_sm_put(pio0, UG_IOR_SM, IO_WAIT);
    return ug_diag_guard_delay(response_us);
}
static inline void ior_value(uint8_t v) {
    if (!ug_diag_guard_failed()) pio_sm_put(pio0, UG_IOR_SM, IOR_SET_VALUE | v);
}
static inline void ior_passthrough(void) {
    pio_sm_put(pio0, UG_IOR_SM, IO_END);  /* 0 condition -> bus floats */
}

static uint8_t diag_read_high(void) {
    const uint8_t *b = (const uint8_t *)&snapshot;
    switch (sel_reg) {
    case UGD_SEL_VERSION: return UG_DIAG_VERSION;
    case UGD_SEL_BASE: return UGD_BASE >> 8;
    case UGD_SEL_BUS:
        return cur_read < UGD_BUS_SIZE ? bus_snapshot[cur_read++] : 0xff;
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
    if (ug_diag_guard_failed()) return; /* hardware already released and stopped */
    if (port >= UGD_BASE && port <= UGD_BASE + UGD_REG_SNAPSHOT) {
        if (port == UGD_BASE + UGD_REG_DATA) { bus_write(value); iow_end(); return; }
        if (!iow_wait()) return;
        switch (port - UGD_BASE) {
        case UGD_REG_CMD: bus_command(value); break;
        case UGD_REG_LEN_LO: if (bus_state) errors++; else length = (length & 0xff00) | value; break;
        case UGD_REG_LEN_HI: if (bus_state) errors++; else length = (length & 0xff) | ((uint16_t)value << 8); break;
        case UGD_REG_SNAPSHOT: bus_latch(); cur_read = 0; break;
        }
        iow_done(); return;
    }
    switch (port) {
    case CONTROL_PORT:
        if (!control_active) {
            iow_end();
            if (value == 0xCC) control_active = true;
            return;
        }
        if (!iow_wait()) return;
        sel_reg = value;
        if (sel_reg == UGD_SEL_BUS) { bus_latch(); cur_read = 0; }
        if (sel_reg == UGD_SEL_ASSERT_US || sel_reg == UGD_SEL_RESPONSE_US) staged_delay = 0;
        if (sel_reg == CMD_FWSTRING || sel_reg == UGD_SEL_STATUS)
            cur_read = 0;
        if (sel_reg == UGD_SEL_ARG) diag_arg = 0;
        if (sel_reg == UGD_SEL_STATUS)
            snapshot_valid = ug_spike_status(&snapshot);
        iow_done();
        return;
    case DATA_PORT_LOW:
        iow_end();
        if (control_active && (sel_reg == UGD_SEL_ASSERT_US || sel_reg == UGD_SEL_RESPONSE_US))
            staged_delay = value;
        if (control_active && sel_reg == UGD_SEL_ARG)
            diag_arg = (diag_arg & 0xFF00) | value;
        return;
    case DATA_PORT_HIGH:
        if (!control_active) { iow_end(); return; }
        if (!iow_wait()) return;
        switch (sel_reg) {
        case UGD_SEL_ASSERT_US:
        case UGD_SEL_RESPONSE_US: {
            uint16_t delay = staged_delay | ((uint16_t)value << 8);
            if (delay > UGD_MAX_DELAY_US) { cmd_result = UGD_CMD_BAD_ARGUMENT; break; }
            if (sel_reg == UGD_SEL_ASSERT_US) assertion_us = delay;
            else response_us = delay;
            cmd_result = UGD_CMD_OK; break;
        }
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
    if (ug_diag_guard_failed()) return;
    if (port >= UGD_BASE && port <= UGD_BASE + UGD_REG_SNAPSHOT) {
        /* Guard and assert IOCHRDY before processing the selected read. */
        if (!ior_wait()) return;
        uint8_t value = 0xff;
        switch (port - UGD_BASE) {
        case UGD_REG_DATA: value = bus_read(); break;
        case UGD_REG_CMD: value = errors ? 0x80 : bus_state; break;
        case UGD_REG_LEN_LO: value = length; break;
        case UGD_REG_LEN_HI: value = length >> 8; break;
        case UGD_REG_SNAPSHOT: value = cur_read < UGD_BUS_SIZE ? bus_snapshot[cur_read++] : 0xff; break;
        }
        ior_value(value); return;
    }
    switch (port) {
    case CONTROL_PORT:
        if (!ior_wait()) return;
        ior_value(sel_reg);
        return;
    case DATA_PORT_HIGH:
        if (!control_active) { ior_passthrough(); return; }
        if (!ior_wait()) return;
        ior_value(diag_read_high());
        return;
    case DATA_PORT_LOW:
        if (!control_active) { ior_passthrough(); return; }
        if (!ior_wait()) return;
        ior_value(sel_reg == UGD_SEL_BASE ? UGD_BASE & 0xff : sel_reg == UGD_SEL_CMD ? cmd_result :
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
