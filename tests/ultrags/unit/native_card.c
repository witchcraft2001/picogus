/* SPDX-License-Identifier: GPL-2.0-or-later
 * N-API adapter for executing real Z80 EXEs against production C storage/GS.
 * SDK peripherals are functional mocks; this is NOT electrical timing proof.
 */
#include <node_api.h>
#include "ug_minimal.h"
#include "ug_storage.h"
#include "ug_s4.h"
#include "ug_psram.h"
#include "ug_hwmap.h"
#include "ug_config.h"
#include "ug_wire.h"
#include "system/flash_settings.h"
#include "sdk_mock.h"
#include <string.h>
static ug_psram_t ram;
static Settings settings;
static double fraction;
static uint32_t frames,quantum;
static uint64_t elapsed,session=123;
static int16_t audio[256];
extern void ug_hw_test_reset(void);
static napi_value integer(napi_env e,uint32_t v) { napi_value r;assert(napi_create_uint32(e,v,&r)==napi_ok);return r; }
static uint32_t number(napi_env e,napi_value v) { uint32_t r;assert(napi_get_value_uint32(e,v,&r)==napi_ok);return r; }
static napi_value init(napi_env e,napi_callback_info info) {
    (void)info;mock_reset();ug_hw_test_reset();
    ug_hw_claim_audio();ug_hw_claim_psram_sm();assert(!ug_psram_init(&ram,pio1,1,1.85f,8u<<20,false));
    memset(&settings,0,sizeof(settings));settings.Volume.mainVol=100;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=65535;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);ug_minimal_init();ug_storage_bind(&ram,++session);ug_storage_publish(8u<<20,0,0);ug_storage_main_volume(100);
    fraction=0;frames=quantum=0;elapsed=0;return integer(e,0);
}
static napi_value mapping(napi_env e,napi_callback_info info) {
    napi_value a[3];size_t n=3;assert(napi_get_cb_info(e,info,&n,a,NULL,NULL)==napi_ok && n==3);
    settings.UltraGS.basePort=(uint16_t)number(e,a[0]);settings.UltraGS.bulkAlias=(uint16_t)number(e,a[1]);ug_cfg.aliases=number(e,a[2])!=0;
    return integer(e,0);
}
static napi_value read_port(napi_env e,napi_callback_info info) {
    napi_value a;size_t n=1;assert(napi_get_cb_info(e,info,&n,&a,NULL,NULL)==napi_ok && n==1);
    return integer(e,ug_minimal_read((uint16_t)number(e,a)));
}
static napi_value write_port(napi_env e,napi_callback_info info) {
    napi_value a[2];size_t n=2;assert(napi_get_cb_info(e,info,&n,a,NULL,NULL)==napi_ok && n==2);
    ug_minimal_write((uint16_t)number(e,a[0]),(uint8_t)number(e,a[1]),time_us_32());return integer(e,0);
}
static napi_value tick(napi_env e,napi_callback_info info) {
    napi_value a;size_t n=1;double us;assert(napi_get_cb_info(e,info,&n,&a,NULL,NULL)==napi_ok && n==1);
    assert(napi_get_value_double(e,a,&us)==napi_ok && us>=0);fraction+=us;
    unsigned whole=(unsigned)fraction;fraction-=whole;elapsed+=whole;mock_now=(uint32_t)elapsed;
    unsigned target=(unsigned)(elapsed*48000/1000000),count=target-frames;
    while(count) {
        if(!quantum) ug_storage_render(audio,128);
        unsigned step=count<128-quantum?count:128-quantum;frames+=step;quantum=(quantum+step)%128;count-=step;
    }
    ug_storage_audio(frames,0);ug_minimal_dispatch();return integer(e,0);
}
static napi_value command(napi_env e,napi_callback_info info) {
    napi_value a[2];size_t n=2;void *data;size_t length;
    assert(napi_get_cb_info(e,info,&n,a,NULL,NULL)==napi_ok && n==2);
    assert(napi_get_buffer_info(e,a[1],&data,&length)==napi_ok && length<=128);
    uint8_t r[128],size,status;unsigned limit=1000000;
    ug_storage_tick(time_us_32());
    if(number(e,a[0])==0 && !length) {
        ug_minimal_write_decoded(3,0,time_us_32());ug_minimal_write_decoded(3,0,time_us_32());
        while(!(ug_minimal_read_status()&4)) { assert(limit--);ug_minimal_dispatch(); }
        status=ug_minimal_read_response();size=ug_minimal_read_response();assert(size<=128);
        for(unsigned i=0;i<size;i++)r[i]=ug_minimal_read_response();
    } else while(!ug_storage_command((uint8_t)number(e,a[0]),data,(uint8_t)length,r,&size,&status,time_us_32())) assert(limit--);
    napi_value result,payload;assert(napi_create_array_with_length(e,2,&result)==napi_ok);
    assert(napi_create_buffer_copy(e,size,r,NULL,&payload)==napi_ok);
    assert(napi_set_element(e,result,0,integer(e,status))==napi_ok && napi_set_element(e,result,1,payload)==napi_ok);return result;
}
static napi_value active_transfer(napi_env e,napi_callback_info info) { (void)info;return integer(e,ug_storage_transfer()); }
static napi_value idle(napi_env e,napi_callback_info info) { (void)info;return integer(e,ug_minimal_idle()); }
static napi_value module(napi_env e,napi_value exports) {
    const struct { const char *name;napi_callback callback; } functions[]={
        {"init",init},{"transfer",active_transfer},{"idle",idle},{"map",mapping},{"read",read_port},{"write",write_port},{"tick",tick},{"command",command}};
    for(unsigned i=0;i<sizeof(functions)/sizeof(functions[0]);i++) {
        napi_value f;assert(napi_create_function(e,functions[i].name,NAPI_AUTO_LENGTH,functions[i].callback,NULL,&f)==napi_ok);
        assert(napi_set_named_property(e,exports,functions[i].name,f)==napi_ok);
    }
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,module)
