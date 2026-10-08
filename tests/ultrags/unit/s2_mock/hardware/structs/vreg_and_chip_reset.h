/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include "mock.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct { uint32_t chip_reset; } mock_chip_reset_t;
extern mock_chip_reset_t mock_chip_reset;
#define vreg_and_chip_reset_hw (&mock_chip_reset)
#ifdef __cplusplus
}
#endif
