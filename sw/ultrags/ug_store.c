/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_store.h"
#include <string.h>
#include "ultrags_protocol.h"
void ug_store_init(ug_store_t *s, uint32_t pool, uint64_t session) {
    memset(s,0,sizeof(*s)); s->pool=pool; s->session=session; s->next_handle=1;
}
void ug_store_reset(ug_store_t *s) { ug_store_init(s,s->pool,s->session+1); }
ug_object_t *ug_store_find(ug_store_t *s,uint16_t h) {
    for(unsigned i=0;i<s->count;i++) if(s->objects[i].handle==h) return &s->objects[i];
    return NULL;
}
/* Find gaps across both source and private extents. No hidden object handle,
 * no heap, and freeing the source releases both extents atomically. */
static uint32_t next_extent(const ug_store_t *s,uint32_t end,uint32_t *after) {
    uint32_t next=s->pool;*after=s->pool;
    for(unsigned i=0;i<s->count;i++) {
        const ug_object_t *o=&s->objects[i];
        for(unsigned a=0;a<2;a++) {
            uint32_t off=a?o->aux_offset:o->offset,n=a?o->aux_reserved:o->reserved;
            if(n && off>=end && off<next) { next=off;*after=off+n; }
        }
    }
    return next;
}
void ug_store_space(const ug_store_t *s,uint32_t *free_bytes,uint32_t *largest) {
    uint32_t end=0; *free_bytes=*largest=0;
    while(end<s->pool) {
        uint32_t after,next=next_extent(s,end,&after),gap=next-end;
        *free_bytes+=gap; if(gap>*largest) *largest=gap;
        end=after;
    }
}
static bool find_gap(const ug_store_t *s,uint32_t n,uint32_t *off) {
    uint32_t end=0;
    while(end<s->pool) {
        uint32_t after,next=next_extent(s,end,&after);
        if(n<=next-end) { *off=end;return true; }end=after;
    }
    return false;
}
uint8_t ug_store_aux(ug_store_t *s,uint16_t handle,uint32_t size) {
    ug_object_t *o=ug_store_find(s,handle);if(!o)return UG_ERR_HANDLE;
    if(!size) { o->aux_offset=o->aux_reserved=0;return 0; }
    if(o->aux_reserved)return UG_ERR_STATE;
    if(size>UINT32_MAX-15)return UG_ERR_RANGE;
    uint32_t n=(size+15)&~15u,off;
    if(!find_gap(s,n,&off))return UG_ERR_NO_MEMORY;
    o->aux_offset=off;o->aux_reserved=n;return 0;
}
uint8_t ug_store_reserve(ug_store_t *s,uint8_t kind,uint32_t size,ug_object_t **out) {
    if(kind>UG_KIND_S3M) return UG_ERR_BAD_ARGUMENT;
    if(!size) return UG_ERR_LENGTH;
    if(size>UINT32_MAX-15) return UG_ERR_RANGE;
    if(s->count==UG_OBJECT_LIMIT || s->next_handle>65535) return UG_ERR_NO_HANDLES;
    uint32_t n=(size+15)&~15u, end=0;
    if(!find_gap(s,n,&end))return UG_ERR_NO_MEMORY;
    for(unsigned i=0;i<=s->count;i++) {
        uint32_t next=i==s->count?s->pool:s->objects[i].offset;
        if(end<=next) {
            memmove(s->objects+i+1,s->objects+i,(s->count-i)*sizeof(*s->objects));
            ug_object_t *o=&s->objects[i]; memset(o,0,sizeof(*o));
            o->offset=end; o->reserved=n; o->size=size; o->kind=kind;
            o->handle=(uint16_t)s->next_handle++; s->count++; *out=o; return UG_ERR_OK;
        }
    }
    return UG_ERR_NO_MEMORY;
}
uint8_t ug_store_free(ug_store_t *s,uint16_t h) {
    ug_object_t *o=ug_store_find(s,h); if(!o) return UG_ERR_HANDLE; if(o->pins) return UG_ERR_PINNED;
    unsigned i=(unsigned)(o-s->objects); --s->count;
    memmove(o,o+1,(s->count-i)*sizeof(*o)); memset(s->objects+s->count,0,sizeof(*o)); return UG_ERR_OK;
}
uint8_t ug_store_pin(ug_store_t *s,uint16_t h,bool pin) {
    ug_object_t *o=ug_store_find(s,h); if(!o) return UG_ERR_HANDLE;
    if(pin) { if(o->pins==65535) return UG_ERR_OVERFLOW; o->pins++; }
    else { if(!o->pins) return UG_ERR_STATE; o->pins--; } return UG_ERR_OK;
}
uint16_t ug_store_enum(const ug_store_t *s,uint16_t after) {
    uint16_t h=0; for(unsigned i=0;i<s->count;i++) {
        uint16_t n=s->objects[i].handle; if(n>after && (!h || n<h)) h=n;
    } return h;
}
