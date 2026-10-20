// SPDX-License-Identifier: GPL-2.0-or-later
//
// check-wire.cpp - C++ consumer smoke test: the generated ug_wire.h must be
// usable from C++ firmware code (PicoGUS main firmware is C/C++) without
// warnings or redefinition issues under -Werror.

#include <cstdint>
#include "ug_wire.h"

static_assert(UG_ULTRAGS_MODE_ID == 8, "mode id");
static_assert(UG_INFO_LEN == 40, "info len");
static_assert(UG_SNAPSHOT_LEN == 64, "snapshot len");
static_assert(UG_OP_WRITE_BEGIN_REQ_VLEN == 13, "verified write_begin len");
static_assert(UG_OP_READ_END_REQ_VLEN == 8, "verified read_end len");
static_assert(sizeof(ug_info_t) == 40, "info struct");
static_assert(sizeof(ug_snapshot_t) == 64, "snapshot struct");
static_assert(sizeof(ug_read_begin_req_t) == 9, "read_begin has no crc field");

// generated struct types must behave as normal C++ PODs
static inline uint16_t info_api_major(const ug_info_t& i) { return i.api_major; }

static ug_info_t g_info;
int main() { return info_api_major(g_info) == 1 || g_info.api_major != 1 ? 1 : 0; }
