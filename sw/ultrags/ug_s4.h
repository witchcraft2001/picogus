/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#pragma once
#include <stdint.h>
#include <stdbool.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Core0 only accesses SRAM. Core1 alone prepares/commits PSRAM. */
uint8_t ug_storage_grant(void);
bool ug_storage_bulk(void);
bool ug_storage_read_available(void);
bool ug_storage_transfer(void);
void ug_storage_grant_ack(uint32_t now);
void ug_storage_touch(uint32_t now);
uint8_t ug_storage_data_write(uint8_t byte,uint32_t now);
uint8_t ug_storage_data_read(uint8_t *byte,uint32_t now);
void ug_storage_tick(uint32_t now);
bool ug_storage_abort(uint32_t now);
void ug_storage_request_cancel(void);
void ug_storage_data_overflow(void);
void ug_storage_gs_reset(bool cold,uint32_t now);
void ug_storage_snapshot(uint8_t out[64]);
void ug_storage_snap_init(void);
void ug_storage_audio(uint32_t frames,uint32_t underruns);
void ug_storage_latch(void);
uint8_t ug_storage_snap_byte(unsigned index);
void ug_stat_add(unsigned index,uint32_t n);
void ug_stat_max(unsigned index,uint32_t n);
void ug_stats_copy(uint8_t out[64]);
void ug_stats_clear(void);
void ug_minimal_error(uint8_t error);
extern volatile uint32_t ug_seal_elapsed_us,ug_service_max_us,ug_spi_slice_max_us;
#ifdef __cplusplus
}
#endif
