/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "mock.h"
void ug_save_prepare(void){assert(mock_clock==370000000);mock_prepares++;}
void ug_save_restore(void){assert(mock_clock==370000000);mock_restores++;}
