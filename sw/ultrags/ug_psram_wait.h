/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * Force-included ONLY in Ultra GS targets, before the pinned backend header.
 * Keep upstream source/gitlink and the behavior of every other mode intact.
 */
#pragma once
#ifndef __ASSEMBLER__
#include "hardware/dma.h"
#ifdef __cplusplus
extern "C" {
#endif
void ug_psram_dma_wait(unsigned channel);
extern bool ug_psram_dma_fault;
#ifdef __cplusplus
}
#endif
#define dma_channel_wait_for_finish_blocking ug_psram_dma_wait

#endif /* !__ASSEMBLER__ */
