/* SPDX-License-Identifier: GPL-2.0-or-later
 *
 * check-wire.c - independent C consumer of the generated Ultra GS wire header.
 *
 * Serializes request frames and LE fields using ONLY the generated constants
 * and a private CRC32 written from spec 6.1, then compares produced bytes with
 * handwritten expected vectors (vectors-expected.h, reformatted from
 * vectors.json). This file is a test program, not production code.
 *
 * Build: cc -O0 -Wall -Wextra -Werror -I<gen_dir> -o check-wire check-wire.c
 * Exit : 0 + "WIRE-C PASS <n>" ; nonzero on first failure with detail.
 */

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include "ug_wire.h"
#include "vectors-expected.h"

static int failures;
static int checks;

#define CHECK(cond, name) do { \
    checks++; \
    if (!(cond)) { failures++; \
      printf("FAIL %s: %s:%d\n", name, __FILE__, __LINE__); } \
  } while (0)

static void expect_bytes(const char *name, const unsigned char *got,
                         unsigned int got_len, const unsigned char *exp,
                         unsigned int exp_len) {
  checks++;
  if (got_len != exp_len || memcmp(got, exp, exp_len) != 0) {
    unsigned int i;
    failures++;
    printf("FAIL %s: got_len=%u exp_len=%u\n  got:", name, got_len, exp_len);
    for (i = 0; i < got_len; i++) printf(" %02X", got[i]);
    printf("\n  exp:");
    for (i = 0; i < exp_len; i++) printf(" %02X", exp[i]);
    printf("\n");
  }
}

/* ---- private CRC-32/ISO-HDLC (reflected), per spec 6.1 ---- */
static uint32_t ug_crc32(const unsigned char *data, unsigned int len) {
  uint32_t crc = UG_CRC_INIT;
  unsigned int i;
  int bit;
  for (i = 0; i < len; i++) {
    crc ^= data[i];
    for (bit = 0; bit < 8; bit++)
      crc = (crc >> 1) ^ (crc & 1 ? UG_CRC_POLY : 0);
  }
  return crc ^ UG_CRC_XOROUT;
}

/* ---- private LE writers ---- */
static unsigned int put_u8(unsigned char *b, unsigned int o, uint8_t v)  { b[o] = v; return o + 1; }
static unsigned int put_u16(unsigned char *b, unsigned int o, uint16_t v) {
  b[o] = (unsigned char)(v & 0xFF); b[o + 1] = (unsigned char)(v >> 8); return o + 2;
}
static unsigned int put_u32(unsigned char *b, unsigned int o, uint32_t v) {
  b[o] = (unsigned char)v; b[o + 1] = (unsigned char)(v >> 8);
  b[o + 2] = (unsigned char)(v >> 16); b[o + 3] = (unsigned char)(v >> 24);
  return o + 4;
}
static unsigned int put_u64(unsigned char *b, unsigned int o, uint64_t v) {
  int i; for (i = 0; i < 8; i++) { b[o + i] = (unsigned char)(v & 0xFF); v >>= 8; }
  return o + 8;
}

/* ---- private request serializer: header2 + payload + optional CRC trailer */
static unsigned int ug_build_request(unsigned char *buf, uint8_t opcode,
                                     int frame_crc,
                                     const unsigned char *payload,
                                     unsigned int payload_len) {
  unsigned int n;
  uint32_t c;
  if (opcode > 0x7F || payload_len > UG_MAX_PAYLOAD) return 0;
  n = put_u8(buf, 0, opcode | (frame_crc ? UG_FRAME_CRC_BIT : 0));
  n = put_u8(buf, n, (uint8_t)payload_len);
  memcpy(buf + n, payload, payload_len);
  n += payload_len;
  if (frame_crc) {
    c = ug_crc32(buf, n); /* header + payload, LE trailer */
    n = put_u32(buf, n, c);
  }
  return n;
}

static uint8_t payload_scratch[UG_MAX_PAYLOAD];
static uint8_t frame_scratch[UG_MAX_FRAME];

static void req_eq(const char *name, uint8_t opcode, const unsigned char *pl,
                   unsigned int pl_len, int fcrc,
                   const unsigned char *exp, unsigned int exp_len) {
  unsigned int n = ug_build_request(frame_scratch, opcode, fcrc, pl, pl_len);
  expect_bytes(name, frame_scratch, n, exp, exp_len);
}

int main(void) {
  /* ===== schema constant checks (spec text -> generated defines) ===== */
  CHECK(UG_ULTRAGS_MODE_ID == 8, "mode_id");
  CHECK(UG_API_MAJOR == 1 && UG_API_MINOR == 0, "api_version");
  CHECK(UG_MAX_PAYLOAD == 128, "max_payload");
  CHECK(UG_MAX_BLOCK == 1024, "max_block");
  CHECK(UG_MAX_OBJECTS == 128, "max_objects");
  CHECK(UG_QUEUE_MAX == 32, "queue_max");
  CHECK(UG_SNAPSHOT_SIZE == 64, "snapshot_size");
  CHECK(UG_DEFAULT_BASE == 0x02A0, "default_base");
  CHECK(UG_DEFAULT_ALIAS == 0xFFFF, "default_alias");
  CHECK(UG_INFO_MAGIC == 0x31534755u, "info_magic_UGS1");
  CHECK(UG_RESET_STORE_KEY == 0x55475253u, "reset_key");
  CHECK(UG_CATALOG_MAGIC == 0x46434755u, "catalog_magic_UGCF");
  CHECK(UG_GS_STATUS_IDLE == 0x7E, "gs_idle");
  CHECK(UG_FRAME_RX_MS == 1000, "frame_rx_ms");
  CHECK(UG_GRANT_IDLE_MS == 5000, "grant_idle_ms");
  CHECK(UG_OP_SEAL_MS == 30000, "op_seal_ms");
  CHECK(UG_PCM_RATE_MIN == 8000 && UG_PCM_RATE_MAX == 48000, "pcm_rates");
  CHECK(UG_CRC_POLY == 0xEDB88320u, "crc_poly");

  CHECK(UG_XS_READY == 0x01 && UG_XS_BUSY == 0x02 && UG_XS_REPLY == 0x04 &&
        UG_XS_WRITE_GRANT == 0x08 && UG_XS_READ_GRANT == 0x10 &&
        UG_XS_XERR == 0x20 && UG_XS_GSERR == 0x40 && UG_XS_AUDIO == 0x80,
        "xstatus_masks");
  CHECK(UG_XC_TRANSPORT_RESET == 0xA0 && UG_XC_TRANSFER_CANCEL == 0xA1 &&
        UG_XC_CLEAR_ERRORS == 0xA2 && UG_XC_SNAP_LATCH == 0xA3, "xcontrol");
  CHECK(UG_TRANSPORT_BULK_FAST == 0x00 && UG_TRANSPORT_GS_FAST == 0x01 &&
        UG_TRANSPORT_BULK_VERIFIED == 0x80 && UG_TRANSPORT_GS_VERIFIED == 0x81,
        "transport_values");

  /* error codes */
  CHECK(UG_ERR_OK == 0 && UG_ERR_BAD_OPCODE == 1 && UG_ERR_BAD_ARGUMENT == 2 &&
        UG_ERR_LENGTH == 3 && UG_ERR_CRC == 4 && UG_ERR_BUSY == 5 &&
        UG_ERR_STATE == 6 && UG_ERR_HANDLE == 7 && UG_ERR_RANGE == 8 &&
        UG_ERR_NO_MEMORY == 9 && UG_ERR_NO_HANDLES == 10 && UG_ERR_FORMAT == 11 &&
        UG_ERR_NO_VOICE == 12 && UG_ERR_TIMEOUT == 13 && UG_ERR_OVERFLOW == 14 &&
        UG_ERR_UNDERFLOW == 15 && UG_ERR_SHORT_TRANSFER == 16 &&
        UG_ERR_PSRAM == 17 && UG_ERR_PINNED == 18 &&
        UG_ERR_UNSUPPORTED_MEMORY == 19 && UG_ERR_BAD_REGISTER == 20 &&
        UG_ERR_CANCELLED == 21 && UG_ERR_INTERNAL == 22, "error_codes");

  /* registers */
  CHECK(UG_REG_BULK_DATA == 0x00 && UG_REG_X_STATUS == 0x01 &&
        UG_REG_X_CONTROL == 0x02 && UG_REG_X_REQUEST == 0x03 &&
        UG_REG_SNAP_INDEX == 0x04 && UG_REG_SNAP_DATA == 0x05 &&
        UG_REG_X_ERROR == 0x06 && UG_REG_GS_ERROR == 0x07 &&
        UG_REG_API_MAJOR == 0x08 && UG_REG_API_MINOR == 0x09 &&
        UG_REG_GS_DATA == 0x13 && UG_REG_GS_CMDSTAT == 0x1B, "register_offsets");

  /* config ports/selectors */
  CHECK(UG_CFG_CONTROL == 0x01D0 && UG_CFG_DATA_LOW == 0x01D1 &&
        UG_CFG_DATA_HIGH == 0x01D2 && UG_CFG_UNLOCK == 0xCC &&
        UG_CFG_PROTOCOL_VER == 4 && UG_CFG_MAGIC_BYTE == 0xDD, "config_ports");
  CHECK(UG_CFG_SEL_UG_BASE == 0x76 && UG_CFG_SEL_UG_ALIAS == 0x77 &&
        UG_CFG_SEL_UG_CFG_RESULT == 0x78 && UG_CFG_SEL_UG_GS_ALIASES == 0x79 &&
        UG_CFG_SEL_FW_CATALOG == 0xE3 && UG_CFG_SEL_FW_ACTIVE == 0xE4 &&
        UG_CFG_SEL_FW_BOOT_RESULT == 0xE5, "config_selectors");

  /* opcodes */
  CHECK(UG_OP_INFO == 0x00 && UG_OP_CAPS == 0x01 && UG_OP_MEM_INFO == 0x02 &&
        UG_OP_STATS == 0x03 && UG_OP_CLEAR_STATS == 0x04 && UG_OP_MEM_TEST == 0x05 &&
        UG_OP_RESET_STORE == 0x06 && UG_OP_ALLOC == 0x10 && UG_OP_FREE == 0x11 &&
        UG_OP_OBJECT_INFO == 0x12 && UG_OP_SEAL == 0x13 && UG_OP_PCM_CONFIG == 0x14 &&
        UG_OP_OBJECT_ENUM == 0x15 && UG_OP_LEGACY_INFO == 0x16 &&
        UG_OP_WRITE_BEGIN == 0x20 && UG_OP_WRITE_END == 0x21 &&
        UG_OP_READ_BEGIN == 0x22 && UG_OP_READ_END == 0x23 &&
        UG_OP_TRANSFER_CANCEL == 0x24 && UG_OP_SNAPSHOT == 0x50 &&
        UG_OP_FX_STATUS == 0x51, "opcodes");

  /* GS commands (sample of the mandatory profile set) */
  CHECK(UG_GS_GS_POOL_SIZE == 0x20 && UG_GS_GS_POOL_FREE == 0x21 &&
        UG_GS_GS_POOL_PAGES == 0x23 && UG_GS_GS_LOAD_MODULE == 0x30 &&
        UG_GS_GS_PLAY_MODULE == 0x31 && UG_GS_GS_LOAD_CLOSE == 0xD2 &&
        UG_GS_GS_READ_ERROR == 0xF0 && UG_GS_GS_WARM_RESET == 0xF3 &&
        UG_GS_GS_COLD_RESET == 0xF4 && UG_GS_GS_RELOOPER == 0x6B, "gs_commands");

  /* ===== struct layout checks vs vectors ===== */
  CHECK(sizeof(ug_info_t) == UG_INFO_LEN && UG_INFO_LEN == 40, "info_size");
  CHECK(sizeof(ug_caps_t) == 44, "caps_size");
  CHECK(sizeof(ug_mem_info_t) == 20, "mem_info_size");
  CHECK(sizeof(ug_stats_t) == 64, "stats_size");
  CHECK(sizeof(ug_object_info_t) == 38, "objinfo_size");
  CHECK(sizeof(ug_pcm_desc_t) == 24, "pcm_desc_size");
  CHECK(sizeof(ug_snapshot_t) == 64, "snapshot_size128");
  CHECK(sizeof(ug_fxrec_t) == 16, "fxrec_size");
  CHECK(sizeof(ug_voicerec_t) == 20, "chanrec_size");
  CHECK(sizeof(ug_gs_desc_t) == 9, "gs_desc_size");
  CHECK(sizeof(ug_fw_catalog_t) == 148, "catalog_size");
  CHECK(sizeof(ug_write_begin_req_t) == 13, "write_begin_req_vsize");
  CHECK(UG_WRITE_BEGIN_REQ_LEN == 9 && UG_WRITE_BEGIN_REQ_VLEN == 13, "write_begin_req_sizes");
  CHECK(UG_READ_BEGIN_REQ_LEN == 9, "read_begin_req_size");
  CHECK(sizeof(ug_read_begin_req_t) == 9, "read_begin_req_no_crc_field");
  CHECK(UG_WRITE_END_REQ_LEN == 4 && UG_READ_END_REQ_LEN == 4 &&
        UG_READ_END_REQ_VLEN == 8, "xfer_end_sizes");
  CHECK(sizeof(ug_write_end_req_t) == 4, "write_end_req_no_hostcrc");
  /* per-opcode normalized lengths (opcode-specific VERIFIED expansion) */
  CHECK(UG_OP_WRITE_BEGIN_REQ_LEN == 9 && UG_OP_WRITE_BEGIN_REQ_VLEN == 13 &&
        UG_OP_WRITE_BEGIN_RESP_LEN == 4, "op_write_begin_lens");
  CHECK(UG_OP_READ_BEGIN_REQ_LEN == 9 &&
        UG_OP_READ_BEGIN_RESP_LEN == 4 && UG_OP_READ_BEGIN_RESP_VLEN == 8,
        "op_read_begin_lens");
  CHECK(UG_OP_WRITE_END_REQ_LEN == 4 && UG_OP_READ_END_REQ_LEN == 4 &&
        UG_OP_READ_END_REQ_VLEN == 8, "op_end_lens");
  CHECK(UG_OP_INFO_REQ_LEN == 0 && UG_OP_INFO_RESP_LEN == 40, "op_info_lens");
  CHECK(sizeof(ug_mem_test_resp_t) == 14, "mem_test_resp");
  CHECK(sizeof(ug_alloc_req_t) == 5 && sizeof(ug_alloc_resp_t) == 6, "alloc_sizes");
  CHECK(sizeof(ug_seal_req_t) == 7 && sizeof(ug_seal_resp_t) == 4, "seal_sizes");
  CHECK(sizeof(ug_pcm_config_req_t) == 26, "pcm_config_req");
  CHECK(sizeof(ug_legacy_info_resp_t) == 10, "legacy_info");
  CHECK(sizeof(ug_play_pcm_req_t) == 6 && sizeof(ug_play_mod_req_t) == 3 &&
        sizeof(ug_control_req_t) == 3 && sizeof(ug_seek_mod_req_t) == 5 &&
        sizeof(ug_set_mix_req_t) == 4 && sizeof(ug_set_tempo_req_t) == 2 &&
        sizeof(ug_play_fx_req_t) == 8 && sizeof(ug_play_fx_resp_t) == 4 &&
        sizeof(ug_queue_add_req_t) == 6 && sizeof(ug_queue_info_resp_t) == 8,
        "play_queue_sizes");

  /* field offsets (handwritten expectations) */
  CHECK(UG_INFO_SESSION_OFF == 12 && UG_INFO_BUILD_ID_OFF == 20, "info_offs");
  CHECK(UG_CAPS_BASE_OFF == 28 && UG_CAPS_PCM_RATE_MAX_OFF == 36, "caps_offs");
  CHECK(UG_OBJECT_INFO_SIZE_OFF == 6 && UG_OBJECT_INFO_MOD_CHANNELS_OFF == 37, "objinfo_offs");
  CHECK(UG_PCM_DESC_DATA_OFFSET_OFF == 8 && UG_PCM_DESC_LOOP_END_OFF == 20, "pcm_desc_offs");
  CHECK(UG_SNAPSHOT_SESSION_OFF == 4 && UG_SNAPSHOT_STATE_OFF == 24 &&
        UG_SNAPSHOT_VOICE_COUNT_OFF == 52 && UG_SNAPSHOT_TRANSFER_ID_OFF == 56 &&
        UG_SNAPSHOT_TRANSFER_LENGTH_OFF == 62, "snap_offs");
  CHECK(UG_GS_DESC_REPLY_PTR_OFF == 7, "gs_desc_offs");
  CHECK(UG_FXREC_SOURCE_FRAME_OFF == 8 && UG_FXREC_FLAGS_OFF == 15, "fxrec_offs");
  CHECK(UG_VOICEREC_PERIOD_OFF == 14, "chanrec_offs");
  CHECK(UG_FW_CATALOG_RECORDS_OFF == 16 && UG_FW_CATALOG_CATALOG_CRC32_OFF == 144, "catalog_offs");
  CHECK(UG_WRITE_BEGIN_REQ_TRANSPORT_OFF == 8 && UG_WRITE_BEGIN_REQ_CRC_OFF == 9, "xfer_offs");

  /* ===== CRC32 vectors (independent expected values) ===== */
  {
    static const unsigned char d_check[] = { '1','2','3','4','5','6','7','8','9' };
    static const unsigned char d_00010203[] = { 0x00, 0x01, 0x02, 0x03 };
    static const unsigned char d_8000[] = { 0x80, 0x00 };
    static const unsigned char d_ff[] = { 0xFF };
    CHECK(ug_crc32(NULL, 0) == 0x00000000u, "crc_empty");
    CHECK(ug_crc32(d_check, 9) == 0xCBF43926u, "crc_123456789");
    CHECK(ug_crc32(d_00010203, 4) == 0x8BB98613u, "crc_00010203");
    CHECK(ug_crc32(d_8000, 2) == 0x7A5A8AB4u, "crc_8000");
    CHECK(ug_crc32(d_ff, 1) == 0xFF000000u, "crc_ff");
  }

  /* ===== LE encoding vectors ===== */
  {
    unsigned char b[8];
    put_u16(b, 0, 0x0001); expect_bytes("u16_0001", b, 2, V_LE_U16_0001, 2);
    put_u16(b, 0, 0x00FF); expect_bytes("u16_00FF", b, 2, V_LE_U16_00FF, 2);
    put_u16(b, 0, 0x0100); expect_bytes("u16_0100", b, 2, V_LE_U16_0100, 2);
    put_u16(b, 0, 0x7FFF); expect_bytes("u16_7FFF", b, 2, V_LE_U16_7FFF, 2);
    put_u16(b, 0, 0x8000); expect_bytes("u16_8000", b, 2, V_LE_U16_8000, 2);
    put_u16(b, 0, 0xFFFF); expect_bytes("u16_FFFF", b, 2, V_LE_U16_FFFF, 2);
    put_u32(b, 0, 0);        expect_bytes("u32_0", b, 4, V_LE_U32_0, 4);
    put_u32(b, 0, 0x00010000); expect_bytes("u32_64K", b, 4, V_LE_U32_64K, 4);
    put_u32(b, 0, 0x00100000); expect_bytes("u32_1MiB", b, 4, V_LE_U32_1MIB, 4);
    put_u32(b, 0, 0x007FFFFF); expect_bytes("u32_8MiB_m1", b, 4, V_LE_U32_8MIB_M1, 4);
    put_u32(b, 0, 0xFFFFFFFF); expect_bytes("u32_max", b, 4, V_LE_U32_MAX, 4);
    put_u64(b, 0, 0x0102030405060708ULL);
    expect_bytes("u64_session", b, 8, V_LE_U64_SESSION, 8);
  }

  /* ===== frame vectors ===== */
  req_eq("info_fast", UG_OP_INFO, NULL, 0, 0, V_REQ_INFO_FAST, V_REQ_INFO_FAST_LEN);
  req_eq("info_crc", UG_OP_INFO, NULL, 0, 1, V_REQ_INFO_CRC, V_REQ_INFO_CRC_LEN);

  {
    unsigned int n;
    /* WRITE_BEGIN h=0x1234 off=0 N=1024 BULK_FAST (spec 12.6) */
    n = 0;
    n = put_u16(payload_scratch, n, 0x1234);
    n = put_u32(payload_scratch, n, 0);
    n = put_u16(payload_scratch, n, 1024);
    n = put_u8(payload_scratch, n, UG_TRANSPORT_BULK_FAST);
    req_eq("write_begin_fast_h1234", UG_OP_WRITE_BEGIN, payload_scratch, n, 0,
           V_REQ_WRITE_BEGIN_FAST_H1234, V_REQ_WRITE_BEGIN_FAST_H1234_LEN);
    /* WRITE_END token=1 */
    n = 0; n = put_u32(payload_scratch, n, 1);
    req_eq("write_end_fast_tok1", UG_OP_WRITE_END, payload_scratch, n, 0,
           V_REQ_WRITE_END_FAST_TOK1, V_REQ_WRITE_END_FAST_TOK1_LEN);
    /* READ_BEGIN same args */
    n = 0;
    n = put_u16(payload_scratch, n, 0x1234);
    n = put_u32(payload_scratch, n, 0);
    n = put_u16(payload_scratch, n, 1024);
    n = put_u8(payload_scratch, n, UG_TRANSPORT_BULK_FAST);
    req_eq("read_begin_fast", UG_OP_READ_BEGIN, payload_scratch, n, 0,
           V_REQ_READ_BEGIN_FAST, V_REQ_READ_BEGIN_FAST_LEN);
    /* READ_END token=1 */
    n = 0; n = put_u32(payload_scratch, n, 1);
    req_eq("read_end_fast", UG_OP_READ_END, payload_scratch, n, 0,
           V_REQ_READ_END_FAST, V_REQ_READ_END_FAST_LEN);
    /* WRITE_BEGIN VERIFIED: transport=0x80 + crc field */
    n = 0;
    n = put_u16(payload_scratch, n, 0x1234);
    n = put_u32(payload_scratch, n, 0);
    n = put_u16(payload_scratch, n, 1024);
    n = put_u8(payload_scratch, n, UG_TRANSPORT_BULK_VERIFIED);
    n = put_u32(payload_scratch, n, 0x12345678);
    req_eq("write_begin_verified", UG_OP_WRITE_BEGIN, payload_scratch, n, 0,
           V_REQ_WRITE_BEGIN_VERIFIED, V_REQ_WRITE_BEGIN_VERIFIED_LEN);
    /* READ_BEGIN VERIFIED: no crc field in request, transport=0x80 only */
    n = 0;
    n = put_u16(payload_scratch, n, 0x1234);
    n = put_u32(payload_scratch, n, 0);
    n = put_u16(payload_scratch, n, 1024);
    n = put_u8(payload_scratch, n, UG_TRANSPORT_BULK_VERIFIED);
    req_eq("read_begin_verified", UG_OP_READ_BEGIN, payload_scratch, n, 0,
           V_REQ_READ_BEGIN_VERIFIED, V_REQ_READ_BEGIN_VERIFIED_LEN);
    /* WRITE_END in VERIFIED mode: request unchanged (token only) */
    n = 0; n = put_u32(payload_scratch, n, 1);
    req_eq("write_end_verified_tok1", UG_OP_WRITE_END, payload_scratch, n, 0,
           V_REQ_WRITE_END_VERIFIED_TOK1, V_REQ_WRITE_END_VERIFIED_TOK1_LEN);
    /* READ_END VERIFIED: token + host_crc */
    n = 0;
    n = put_u32(payload_scratch, n, 1);
    n = put_u32(payload_scratch, n, 0x8BB98613);
    req_eq("read_end_verified_tok1", UG_OP_READ_END, payload_scratch, n, 0,
           V_REQ_READ_END_VERIFIED_TOK1, V_REQ_READ_END_VERIFIED_TOK1_LEN);
    /* STATS + FRAME_CRC: len-0 payload still carries the 4-byte trailer */
    req_eq("stats_crc", UG_OP_STATS, NULL, 0, 1,
           V_REQ_STATS_CRC, V_REQ_STATS_CRC_LEN);
    /* ALLOC kind=RAW_PCM(1) size=0x1000 */
    n = 0;
    n = put_u8(payload_scratch, n, UG_KIND_RAW_PCM);
    n = put_u32(payload_scratch, n, 0x1000);
    req_eq("alloc_raw_4k", UG_OP_ALLOC, payload_scratch, n, 0,
           V_REQ_ALLOC_RAW_4K, V_REQ_ALLOC_RAW_4K_LEN);
    /* SEAL handle=1 flags=0 crc=0 */
    n = 0;
    n = put_u16(payload_scratch, n, 1);
    n = put_u8(payload_scratch, n, 0);
    n = put_u32(payload_scratch, n, 0);
    req_eq("seal_h1_noflags", UG_OP_SEAL, payload_scratch, n, 0,
           V_REQ_SEAL_H1_NOFLAGS, V_REQ_SEAL_H1_NOFLAGS_LEN);
    /* PCM_CONFIG: handle=1, rate=44100, ch=2, bits=16, fmt=S16LE(2), flags=0,
       data_offset=0, data_length=0x8000, loops=0 */
    n = 0;
    n = put_u16(payload_scratch, n, 1);
    n = put_u32(payload_scratch, n, 44100);
    n = put_u8(payload_scratch, n, 2);
    n = put_u8(payload_scratch, n, 16);
    n = put_u8(payload_scratch, n, 2);
    n = put_u8(payload_scratch, n, 0);
    n = put_u32(payload_scratch, n, 0);
    n = put_u32(payload_scratch, n, 0x8000);
    n = put_u32(payload_scratch, n, 0);
    n = put_u32(payload_scratch, n, 0);
    req_eq("pcm_config_44100_s16le_stereo", UG_OP_PCM_CONFIG, payload_scratch, n, 0,
           V_REQ_PCM_CONFIG_44100_S16LE_STEREO, V_REQ_PCM_CONFIG_44100_S16LE_STEREO_LEN);
    /* OBJECT_INFO handle=1 */
    n = 0; n = put_u16(payload_scratch, n, 1);
    req_eq("object_info_h1", UG_OP_OBJECT_INFO, payload_scratch, n, 0,
           V_REQ_OBJECT_INFO_H1, V_REQ_OBJECT_INFO_H1_LEN);
    /* MEM_INFO / CAPS / STATS / SNAPSHOT (no payload) */
    req_eq("mem_info", UG_OP_MEM_INFO, NULL, 0, 0, V_REQ_MEM_INFO, V_REQ_MEM_INFO_LEN);
    req_eq("caps", UG_OP_CAPS, NULL, 0, 0, V_REQ_CAPS, V_REQ_CAPS_LEN);
    req_eq("stats", UG_OP_STATS, NULL, 0, 0, V_REQ_STATS, V_REQ_STATS_LEN);
    req_eq("snapshot", UG_OP_SNAPSHOT, NULL, 0, 0, V_REQ_SNAPSHOT, V_REQ_SNAPSHOT_LEN);
    /* TRANSFER_CANCEL transfer=0xDEADBEEF */
    n = 0; n = put_u32(payload_scratch, n, 0xDEADBEEF);
    req_eq("transfer_cancel", UG_OP_TRANSFER_CANCEL, payload_scratch, n, 0,
           V_REQ_TRANSFER_CANCEL, V_REQ_TRANSFER_CANCEL_LEN);
    /* QUEUE_ADD h=0x1234 repeats=3 gain=64 pan=0x20 */
    n = 0;
    n = put_u16(payload_scratch, n, 0x1234);
    n = put_u16(payload_scratch, n, 3);
    n = put_u8(payload_scratch, n, 64);
    n = put_u8(payload_scratch, n, 0x20);
    req_eq("queue_add", UG_OP_QUEUE_ADD, payload_scratch, n, 0,
           V_REQ_QUEUE_ADD, V_REQ_QUEUE_ADD_LEN);
    /* max payload 128 accepted by serializer */
    memset(payload_scratch, 0xAA, UG_MAX_PAYLOAD);
    CHECK(ug_build_request(frame_scratch, UG_OP_PCM_CONFIG, 0,
                           payload_scratch, UG_MAX_PAYLOAD) == 130,
          "max_payload_128_accepted");
    /* frame_128_crc: opcode 0x50 + 128-byte pattern payload + FRAME_CRC -> 134B */
    {
      unsigned int i, n2;
      for (i = 0; i < 128; i++) payload_scratch[i] = (unsigned char)i;
      n2 = ug_build_request(frame_scratch, UG_OP_SNAPSHOT, 1,
                            payload_scratch, UG_MAX_PAYLOAD);
      CHECK(n2 == 134, "frame_128_crc_total_len");
      expect_bytes("frame_128_crc_prefix", frame_scratch, 2,
                   V_REQP_FRAME_128_CRC, V_REQP_FRAME_128_CRC_LEN);
      expect_bytes("frame_128_crc_payload", frame_scratch + 2, 128,
                   payload_scratch, 128);
      expect_bytes("frame_128_crc_trailer", frame_scratch + 130, 4,
                   V_REQT_FRAME_128_CRC, V_REQT_FRAME_128_CRC_LEN);
    }
    /* payload 129 rejected at build boundary */
    memset(payload_scratch, 0xAA, UG_MAX_PAYLOAD);
    CHECK(ug_build_request(frame_scratch, UG_OP_PCM_CONFIG, 0,
                           payload_scratch, UG_MAX_PAYLOAD) == 130 &&
          ug_build_request(frame_scratch, UG_OP_PCM_CONFIG, 0,
                           payload_scratch, 129) == 0,
          "payload_129_rejected");
    /* opcode >= 0x80 rejected (bit7 reserved for FRAME_CRC) */
    CHECK(ug_build_request(frame_scratch, 0x80, 0, NULL, 0) == 0, "opcode_80_rejected");
  }

  /* response header examples from vectors */
  {
    /* INFO ok reply header: status=0 len=36 */
    unsigned char rh[2];
    rh[0] = UG_ERR_OK; rh[1] = UG_INFO_LEN;
    expect_bytes("info_resp_header", rh, 2, V_RH_INFO_FAST, V_RH_INFO_FAST_LEN);
    rh[1] = 20; expect_bytes("mem_info_resp_header", rh, 2, V_RH_MEM_INFO, 2);
    rh[1] = 44; expect_bytes("caps_resp_header", rh, 2, V_RH_CAPS, 2);
    rh[1] = 64; expect_bytes("stats_resp_header", rh, 2, V_RH_STATS, 2);
    rh[1] = 64; expect_bytes("snapshot_resp_header", rh, 2, V_RH_SNAPSHOT, 2);
    /* WRITE_BEGIN ok resp token=1 */
    {
      unsigned char r[6]; unsigned int n = 0;
      n = put_u8(r, n, UG_ERR_OK); n = put_u8(r, n, 4); n = put_u32(r, n, 1);
      expect_bytes("write_begin_resp", r, n, V_RESP_WRITE_BEGIN_FAST_H1234, 6);
    }
  }

  if (failures) { printf("WIRE-C FAIL: %d/%d failed\n", failures, checks); return 1; }
  printf("WIRE-C PASS %d checks\n", checks);
  return 0;
}
