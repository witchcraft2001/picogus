/* SPDX-License-Identifier: GPL-2.0-or-later */
#include <stdint.h>
typedef struct {uint32_t intr, inte, alarm[4];} s1_timer;
extern s1_timer mock_timer;
#define timer_hw (&mock_timer)
#define hw_set_bits(p,v) (*(p) |= (v))
