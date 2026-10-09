/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "mock.h"
void ug_save_prepare(void){assert(mock_clock==370000000);mock_prepares++;}
void ug_save_restore(void){assert(mock_clock==370000000);mock_restores++;}

extern "C" bool ug_storage_busy(void) { return false; }
extern "C" void ug_storage_cancel(uint32_t) {}
extern "C" bool ug_storage_command(uint8_t,const uint8_t *,uint8_t,uint8_t *,uint8_t *n,uint8_t *s,uint32_t) { *n=0; *s=1; return true; }
