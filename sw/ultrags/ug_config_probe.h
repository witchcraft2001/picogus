/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * Temporary diagnostic, core0 only. Not part of the Ultra GS API.
 */
#pragma once
#include <stdint.h>
typedef struct {
    uint8_t late, index, value, flags;
    uint16_t seen;
} ug_config_probe;
static inline void ug_config_probe_begin(ug_config_probe *p) {
    p->late=0;p->index=255;p->value=255;p->flags=0xa0;p->seen=0;
}
/* Called AFTER the TX data store, using GPIO sampled BEFORE that store.
 * A high /IOR cannot be a completion caused by this not-yet-submitted byte.
 * Low /IOR does not prove that the host accepted WAIT or sampled this byte. */
static inline void ug_config_probe_record(ug_config_probe *p,uint16_t next_index,
                                         uint8_t value,uint32_t pins) {
    if(next_index<=p->seen || next_index>148) return;
    p->seen=next_index;p->flags|=4;
    if(!(pins&(1u<<5))) return;
    if(p->late!=255) ++p->late;
    p->index=(uint8_t)(next_index-1);p->value=value;
    p->flags=0xa5|((pins&(1u<<26))?2:0);
}
static inline uint8_t ug_config_probe_read(const ug_config_probe *p,unsigned reg) {
    switch(reg) {
    case 0x1c:return p->late;
    case 0x1d:return p->index;
    case 0x1e:return p->value;
    default:return p->flags;
    }
}
