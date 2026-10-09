/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_config.h"
#include "../../common/picogus.h"
#include <string.h>
ug_config ug_cfg;
bool ug_config_busy(const ug_config *c) { return __atomic_load_n(&c->maintenance,__ATOMIC_ACQUIRE)!=0; }
bool ug_config_aliases(const ug_config *c) { return __atomic_load_n(&c->aliases,__ATOMIC_ACQUIRE); }
void ug_config_init(ug_config *c, Settings *s, uint8_t active, const uint8_t *catalog,
                    uint32_t magic,uint32_t packed,uint32_t checked) {
    memset(c,0,sizeof(*c)); c->settings=s; c->active=active;
    if(catalog) {
        memcpy(c->catalog,catalog,148);
        c->catalog_ok=!ug_catalog_validate(catalog,false);
        if(ug_handoff(magic,packed,checked,active,&c->boot_result,&c->verified))
            s->startupMode=(uint8_t)packed;
        /* A bootloader catalog failure must remain read-only even if a
         * subsequently readable manifest passes its own checks. */
        if(c->boot_result==5) c->catalog_ok=false;
        if(!c->catalog_ok) { c->boot_result=5; c->verified=0; }
        if(c->catalog_ok && c->boot_result!=7) {
            for(unsigned i=0;i<8;++i) if((c->verified&(1u<<(i+1))) && (c->catalog[17+i*16]&1)) c->catalog[17+i*16]|=2;
            ug_put32(c->catalog+144,ug_crc32(c->catalog,144));
        }
    } else memset(c->catalog,255,148);
    if(ug_ports_validate(s->UltraGS.basePort,s->UltraGS.bulkAlias)) {
        s->UltraGS.basePort=0x2a0; s->UltraGS.bulkAlias=0xffff;
        if(!c->boot_result) c->boot_result=4;
    }
}
bool ug_config_selector(uint8_t s) { return (s>=0x76 && s<=0x79) || (s>=0xe3 && s<=0xe5); }
void ug_config_select(ug_config *c,uint8_t s) {
    c->selector=s; c->low=0;
    if(s==CMD_FW_CATALOG) { memcpy(c->snapshot,c->catalog,148); c->index=0; }
}
uint8_t ug_config_read(ug_config *c,bool high) {
    uint16_t v;
    switch(c->selector) {
    case CMD_UG_BASE: v=c->settings->UltraGS.basePort; return high?v>>8:v;
    case CMD_UG_ALIAS: v=c->settings->UltraGS.bulkAlias; return high?v>>8:v;
    case CMD_UG_CFG_RESULT: return high?(ug_config_busy(c)?5:c->result):0;
    case CMD_UG_GS_ALIASES: return high?ug_config_aliases(c):0;
    case CMD_FW_ACTIVE: return high?c->active:0;
    case CMD_FW_BOOT_RESULT: return high?c->boot_result:0;
    case CMD_FW_CATALOG: return high && c->index<148?c->snapshot[c->index++]:255;
    default:return 255;
    }
}
uint8_t ug_ports_validate(uint16_t base,uint16_t alias) {
    if(base<0x200 || base>0x3e0 || (base&31)) return 2;
    if(alias!=0xffff && (alias<0x200 || alias>0x3e0 || (alias&31) || alias==base)) return 2;
    return 0;
}
void ug_config_write(ug_config *c,bool high,uint8_t value,bool idle) {
    if(ug_config_busy(c)) return; /* Keep BUSY and immutable snapshot. */
    if(!high) { c->low=value; return; }
    c->result=0;
    uint16_t v=c->low|((uint16_t)value<<8);
    switch(c->selector) {
    case CMD_BOOTMODE: {
        ug_image image;
        if(!c->catalog_ok) { c->result=6; break; }
        uint8_t r=ug_catalog_resolve(c->catalog,value,&image);
        c->result=r==1?2:r==6?6:0;
        if(!c->result) c->settings->startupMode=value;
        break;
    }
    case CMD_UG_BASE: case CMD_UG_ALIAS: {
        if(c->active==8 && !idle) { c->result=5; break; }
        uint16_t b=c->selector==CMD_UG_BASE?v:c->settings->UltraGS.basePort;
        uint16_t a=c->selector==CMD_UG_ALIAS?v:c->settings->UltraGS.bulkAlias;
        c->result=ug_ports_validate(b,a);
        if(!c->result) { c->settings->UltraGS.basePort=b; c->settings->UltraGS.bulkAlias=a; }
        break;
    }
    case CMD_UG_GS_ALIASES:
        if(value>1) c->result=2;
        else if(c->active!=8) c->result=6;
        else if(!idle) c->result=5;
        else __atomic_store_n(&c->aliases,value!=0,__ATOMIC_RELEASE);
        break;
    case CMD_SAVE:
        if(!idle) { c->result=5; break; }
        c->save_snapshot=*c->settings;
        c->result=5;
        __atomic_store_n(&c->maintenance,1,__ATOMIC_RELEASE);
        break;
    default: c->result=0x14;
    }
}
void ug_config_save_done(ug_config *c,bool verified) {
    c->result=verified?0:0x16;
    __atomic_store_n(&c->maintenance,0,__ATOMIC_RELEASE);
}
