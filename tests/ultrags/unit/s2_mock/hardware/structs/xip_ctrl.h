/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include "mock.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {uint32_t ctrl;} mock_xip_t;
extern mock_xip_t mock_xip;
#define xip_ctrl_hw (&mock_xip)
#define XIP_CTRL_EN_BITS 1
static inline void hw_clear_bits(uint32_t *p,uint32_t b){*p&=~b;}
#ifdef __cplusplus
}
#endif
