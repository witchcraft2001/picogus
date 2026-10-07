/* SPDX-License-Identifier: GPL-2.0-or-later
 *  Ultra GS standalone diagnostic interface introduced by S0a.
 *
 *  Scope: ONLY the standalone diagnostic's status record -- the
 *  bytes a host tool reads back over the PicoGUS control channel from
 *  the pg-ultrags-diag image. The real Ultra GS wire ABI (mode 8,
 *  object protocol, events) is NOT defined here; schema is a task of S0b.
 *  Selector codes 0x80-0x82 below are private to the standalone
 *  diagnostic image and are NOT part of the permanent wire contract.
 */
#ifndef UG_DIAG_H
#define UG_DIAG_H

#include <stdint.h>

#define UG_DIAG_MAGIC0   'U'
#define UG_DIAG_MAGIC1   'G'
#define UG_DIAG_VERSION  0x02   /* diagnostic only: adds distinct fetch_errors */

/* Diagnostic-private selectors on the PicoGUS control port (0x1D0/1D2).
 * NOT allocated in common/picogus.h -- valid only while the standalone
 * diag image is loaded. */
#define UGD_SEL_STATUS   0x80   /* DATA_HIGH: stream of ug_diag_status */
#define UGD_SEL_CMD      0x81   /* DATA_HIGH write: 1=profile A, 2=B, 3=stop */
#define UGD_SEL_ARG      0x82   /* DATA_LOW/HIGH: run length in quanta (LE) */

#define UGD_STATE_IDLE   0
#define UGD_STATE_RUN    1
#define UGD_STATE_DONE   2
#define UGD_STATE_ERR    3
#define UGD_STATE_INIT   4
#define UGD_CMD_OK       0
#define UGD_CMD_BUSY     1
#define UGD_CMD_BAD_ARGUMENT 2

/* Status snapshot published by core1, read byte-wise by core0 on
 * UGD_SEL_STATUS. Packed, little-endian, fixed size. */
typedef struct __attribute__((packed)) {
    uint8_t  magic0, magic1;      /* 'U','G' */
    uint8_t  version;             /* UG_DIAG_VERSION */
    uint8_t  state;               /* UGD_STATE_* */
    uint8_t  board_type;          /* 0 PICO_BASED, 1 PICOGUS_2 */
    uint8_t  profile;             /* 0 none, 1 = A(8+4m), 2 = B(8+2st) */
    uint8_t  psram_backend;       /* 0 none, 1 normal, 2 fudge */
    uint8_t  flags;               /* bit0: audit_ok, bit1: m62429 */
    uint32_t sys_clk_khz;
    uint32_t i2s_div_q8;          /* SM clkdiv, Q8 */
    uint32_t lrclk_hz;            /* derived */
    uint32_t psram_pool_bytes;    /* declared test pool */
    uint32_t iow_count, ior_count;
    uint32_t frames, quanta;      /* rendered; STOP can discard queued output */
    uint32_t underruns;
    uint32_t cache_fills, cache_misses;
    uint32_t fetch_errors;
    uint32_t render_max_us;
    uint32_t render_sum_us;
    uint32_t bg_bytes, bg_errors;
    uint32_t out_checksum;        /* FNV-1a of rendered stereo S16LE bytes */
    uint32_t res_faults;          /* ug_hw_audit bitmask */
} ug_diag_status;

#define UG_DIAG_STATUS_SIZE (sizeof(ug_diag_status))

#endif /* UG_DIAG_H */
