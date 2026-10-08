/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_catalog.h"
#include <string.h>
uint32_t ug_get32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
void ug_put32(uint8_t *p, uint32_t v) {
    for (unsigned i=0; i<4; ++i) p[i]=(uint8_t)(v>>(8*i));
}
uint32_t ug_crc32(const void *data, size_t n) {
    const uint8_t *p=data;
    uint32_t c=~0u;
    while(n--) { c^=*p++; for(unsigned j=0;j<8;++j) c=(c>>1)^((0u-(c&1))&0xedb88320u); }
    return ~c;
}
static bool bounds(const ug_image *a) {
    return a->offset>=UG_IMAGE_START && !(a->offset&1023) && a->length>=264 &&
        a->offset<UG_SETTINGS_OFFSET && a->length<=UG_SETTINGS_OFFSET-a->offset;
}
static ug_image record(const uint8_t *p) {
    ug_image a={ug_get32(p+4),ug_get32(p+8),ug_get32(p+12)}; return a;
}
uint8_t ug_catalog_validate(const uint8_t *c, bool runtime) {
    if(memcmp(c,"UGCF\1\0\10\20",8) || ug_get32(c+8)!=148 || ug_get32(c+12) ||
       ug_crc32(c,144)!=ug_get32(c+144)) return 5;
    for(unsigned i=0;i<8;++i) {
        const uint8_t *p=c+16+16*i;
        ug_image a=record(p);
        if(p[0]!=i+1 || p[2] || p[3] || (p[1]&~(runtime?3:1)) ||
           ((p[1]&2) && !(p[1]&1))) return 5;
        if(!(p[1]&1)) { if(a.offset || a.length || a.crc) return 5; continue; }
        if(!bounds(&a)) return 5;
        for(unsigned j=0;j<i;++j) {
            const uint8_t *q=c+16+16*j;
            ug_image b=record(q);
            if((q[1]&1) && a.offset<b.offset+b.length && b.offset<a.offset+a.length) return 5;
        }
    }
    return 0;
}
uint8_t ug_catalog_resolve(const uint8_t *c, uint32_t id, ug_image *out) {
    if(id<1 || id>8) return 1;
    const uint8_t *p=c+16+(id-1)*16;
    if(!(p[1]&1)) return 6;
    *out=record(p); return 0;
}
uint8_t ug_image_validate(const uint8_t *flash, size_t size, const ug_image *a) {
    if(!bounds(a) || a->offset>size || a->length>size-a->offset) return 3;
    const uint8_t *p=flash+a->offset;
    if(ug_crc32(p,a->length)!=a->crc) return 2;
    uint32_t sp=ug_get32(p+256), pc=ug_get32(p+260);
    if((sp&7) || sp<=0x20000000u || sp>0x20042000u || !(pc&1) ||
       (pc&~1u)<0x10000000u+a->offset || (pc&~1u)>=0x10000000u+a->offset+a->length) return 3;
    return 0;
}
ug_boot ug_boot_select(const uint8_t *flash, size_t size, const ug_image *recovery,
                      bool watchdog, uint32_t *request, uint8_t persisted, bool valid) {
    ug_boot b={0};
    bool override=watchdog && *request;
    b.requested=override ? *request : persisted;
    *request=0;
    b.result=size<UG_CATALOG_OFFSET+UG_CATALOG_SIZE ? 5 : ug_catalog_validate(flash+UG_CATALOG_OFFSET,false);
    if(!b.result && !valid && !override) b.result=4;
    if(!b.result) b.result=ug_catalog_resolve(flash+UG_CATALOG_OFFSET,b.requested,&b.image);
    if(!b.result) b.result=ug_image_validate(flash,size,&b.image);
    if(!b.result) { b.active=(uint8_t)b.requested; b.verified=1u<<b.active; return b; }
    b.image=*recovery;
    if(ug_image_validate(flash,size,recovery)) { b.safe=true; return b; }
    b.active=1; b.verified=1u<<1; return b;
}
bool ug_handoff(uint32_t magic, uint32_t packed, uint32_t verified, uint8_t active,
                uint8_t *result, uint32_t *checked) {
    *result=7; *checked=0;
    if(active<1 || active>8 || magic!=UG_HANDOFF_MAGIC || (packed>>24)!=1 || ((packed>>8)&255)!=active ||
       ((packed>>16)&255)>7 || (verified&~0x17eu) || !(verified&(1u<<active))) return false;
    *result=(uint8_t)(packed>>16); *checked=verified; return true;
}
