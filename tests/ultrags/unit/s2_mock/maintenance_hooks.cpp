/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "mock.h"
void ug_save_prepare(void){assert(mock_clock==370000000);mock_prepares++;}
void ug_save_restore(void){assert(mock_clock==370000000);mock_restores++;}

extern "C" bool ug_storage_busy(void) { return false; }
extern "C" void ug_storage_cancel(uint32_t) {}
extern "C" bool ug_storage_command(uint8_t,const uint8_t *,uint8_t,uint8_t *,uint8_t *n,uint8_t *s,uint32_t) { *n=0; *s=1; return true; }

extern "C" void ug_stat_add(unsigned,uint32_t) {}
extern "C" void ug_stat_max(unsigned,uint32_t) {}
extern "C" bool ug_storage_transfer(void) { return false; }
extern "C" uint8_t ug_storage_grant(void) { return 0; }
extern "C" bool ug_storage_read_available(void) { return false; }
extern "C" void ug_storage_grant_ack(uint32_t) {}
extern "C" void ug_storage_request_cancel(void) {}
extern "C" void ug_storage_tick(uint32_t) {}
extern "C" bool ug_storage_abort(uint32_t) { return true; }
extern "C" void ug_storage_gs_reset(bool,uint32_t) {}
extern "C" void ug_storage_latch(void) {}
extern "C" uint8_t ug_storage_snap_byte(unsigned) { return 255; }
extern "C" uint8_t ug_storage_data_write(uint8_t,uint32_t) { return 6; }
extern "C" uint8_t ug_storage_data_read(uint8_t *,uint32_t) { return 6; }

extern "C" void ug_storage_snap_init(void) {}

extern "C" void ug_storage_touch(uint32_t) {}
extern "C" void ug_storage_data_overflow(void) {}

extern "C" bool ug_storage_bulk(void) { return false; }
