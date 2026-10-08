/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include "mock.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {uint32_t reason,scratch[8];} mock_watchdog_t;
extern mock_watchdog_t mock_watchdog;
#define watchdog_hw (&mock_watchdog)
#ifdef __cplusplus
}
#endif
