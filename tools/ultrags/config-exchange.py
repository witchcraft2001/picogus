#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute production configuration handler excerpts, not a rewritten port model.

Config register branches and complete IOW/IOR bus handlers are extracted from
picogus.cpp; ug_config.c/ug_catalog.c/ug_minimal.c are linked unchanged. Storage
hooks are mocked; actual INFO framing, response CRC and consuming reads run.
Generated C and bus trace remain
in build/. The catalogue is installed in mock Flash and passed through the
production bundled runtime initializer and watchdog handoff. This is HOST
evidence, not a PIO or hardware timing measurement.
"""
import argparse, json, subprocess, hashlib, shlex
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--catalog',type=Path,required=True);p.add_argument('--trace',action='store_true');p.add_argument('--compat',action='store_true');p.add_argument('--probe',action='store_true');p.add_argument('--fast',action='store_true');p.add_argument('--gs-fast',action='store_true');a=p.parse_args()
assert not (a.trace and a.compat), 'COMPAT has no CONFIG trace registers'
assert not a.probe or a.compat, 'probe requires COMPAT'
assert not a.fast or (a.compat and not a.probe), 'fast requires COMPAT without probe'
assert not a.gs_fast or (a.compat and a.fast and not a.probe), 'GS fast requires COMPAT catalogue fast'
r=Path(__file__).resolve().parents[2];a.build=a.build.resolve();a.build.mkdir(parents=True,exist_ok=True)
subprocess.run(['node',str(r/'tools/ultrags/gen-wire.mjs'),str(r/'tools/ultrags/wire-schema.json'),str(a.build/'gen')],check=True,stdout=subprocess.DEVNULL)
s=(r/'sw/picogus.cpp').read_text()
def between(start,end):
    return s.split(start,1)[1].split(end,1)[0]
# Preserve the production body of each selected branch, including its calls.
select=between('__force_inline void select_picogus(uint8_t value) {','    case CMD_GUSPORT:')+'    default: break;\n    }\n}'
hardware=s.split('__force_inline uint8_t read_picogus_high(void) {',1)[1].split('    case CMD_HWTYPE:',1)[1].split('    case CMD_FLASH:',1)[0]
read=between('__force_inline uint8_t read_picogus_high(void) {','    case CMD_GUSPORT:')+'    case CMD_HWTYPE:'+hardware+'    default: return 255;\n    }\n}'
low=between('__force_inline uint8_t read_picogus_low(void) {','    switch (sel_reg)')+'    return 0;\n}'
iow=between('static void apply_iow(uint32_t iow_read) {','\n}\n\n__force_inline void handle_iow')
native=between('static __force_inline int ug_native_reg(uint16_t port) {','\n#endif\nstatic void apply_iow').replace('__force_inline','inline')
ior=between('__force_inline void handle_ior(void) {','\n}\n\n#ifdef USE_IRQ')
handle_iow=between('__force_inline void handle_iow(void) {','\n}\n#ifdef UG_ISA_POSTED')
prepare=between('__force_inline void prepare_ior(void) {','\n}\n#endif\n__force_inline void handle_ior')
poll=between('// UG_SHARED_POLL_BEGIN (also extracted by the production-C fixture)','// UG_SHARED_POLL_END')
code='''#include <stdio.h>
#include <assert.h>
#include <string.h>
#include "picogus.h"
#include "ultrags/ug_config.h"
#include "ultrags/ug_minimal.h"
#include "ultrags/ug_s4.h"
#include "ultrags/ug_handshake.h"
#include "ultrags/ug_led_diag.h"
#ifdef UG_CONFIG_PROBE
#include "ultrags/ug_config_probe.h"
static ug_config_probe config_probe={0,255,255,0xa0,0};
static unsigned probe_gpio_reads,probe_expire_index,probe_submitted;
#endif
#include "hardware/structs/watchdog.h"
#include "hardware/structs/xip_ctrl.h"
#include "hardware/structs/vreg_and_chip_reset.h"
uint8_t mock_flash[0x200000];
mock_watchdog_t mock_watchdog;
mock_xip_t mock_xip;
mock_chip_reset_t mock_chip_reset;
void saveSettings(const Settings *s){(void)s;assert(!"unexpected Flash write");}
unsigned mock_clock=370000000,mock_prepares,mock_restores,mock_clock_changes;
static Settings settings;
static const unsigned BOARD_TYPE=PICOGUS_2;
static unsigned cur_read, sel_reg, control_active, read_value;
static unsigned pending_port, waited, late, inject_decode_delay, native_decodes;
static unsigned fast_watch,fast_expected_index,fast_stores,fast_end_after_store,generic_high_calls;
static unsigned pending_write,queued_iow,queued_ior,early_wait_enabled=1,force_foreign;
static unsigned write_waited,write_done,inject_write_loss,native_byte=~0u,second_byte_only;
static unsigned inject_config_expired,inject_config_iow_delay,inject_config_expire_on_write;
static unsigned gs_fast_watch,gs_fast_stores,gs_fast_accounts;
#if defined(UG_CONFIG_TRACE) || defined(UG_ISA_COMPAT_READ)
static unsigned gpio_get_all(void){
 unsigned pins=(pending_port<<6)|16|(inject_config_expired?32:0);
#ifdef UG_CONFIG_PROBE
 if(++probe_gpio_reads==2 && probe_expire_index && probe_expire_index==ug_cfg.index && !probe_submitted)
  pins|=32|(1u<<26);
#endif
 return pins;
}
#endif
#ifdef UG_CONFIG_TRACE
static uint8_t ug_trace_write=255,ug_trace_reads,ug_trace_flags;
bool ug_handshake_failed(void){return false;}
#endif
static const char *firmware_string="PicoGUS model";
#define IO_WAIT 1
static const unsigned ug_compat_read_entry=2;
static const unsigned ug_compat_read_restart=0;
#define IO_END 0
#define IOR_SET_VALUE 0x100
#define pio0 0
#define IOR_PIO_SM 1
#define IOW_PIO_SM 0
static unsigned modeled_early_wait(unsigned port){return early_wait_enabled&&!force_foreign&&ug_minimal_port(port);}
static unsigned pio_sm_get(int p,int sm){(void)p;unsigned port;if(sm==IOW_PIO_SM){queued_iow=0;port=pending_write>>8;}else{queued_ior=0;port=pending_port;}unsigned raw=((port&31)<<27)|(port>>5);return modeled_early_wait(port)?~raw:raw;}
static unsigned pio_sm_get_blocking(int p,int sm){(void)p;unsigned port=sm==IOW_PIO_SM?pending_write>>8:pending_port;unsigned data=sm==IOW_PIO_SM?pending_write&255:255;return ((data&31)<<27)|(data>>5)|(modeled_early_wait(port)?1u<<15:0);}
bool ug_handshake_capture(unsigned sm,uint16_t port,bool owned){if(sm==IOW_PIO_SM){write_waited=owned;return owned;}if(port>=0x1d0&&port<=0x1d2&&inject_config_expired){late=1;return false;}waited=owned||(port>=0x1d0&&port<=0x1d2);return waited;}
bool ug_handshake_read_active(void){return !inject_config_expired;}
void ug_handshake_poll(void){}
#define ISA_PIO_PUT pio_sm_put

static void pio_sm_put(int p,int sm,unsigned v){(void)p;(void)sm;if(v==IO_WAIT||v==ug_compat_read_entry)waited=1;else if(v&IOR_SET_VALUE){
 if(gs_fast_watch && pending_port==0xbb)gs_fast_stores++;
#ifdef UG_CONFIG_PROBE
 if(probe_expire_index && pending_port==DATA_PORT_HIGH && ug_cfg.index==probe_expire_index){
  assert(!config_probe.late);probe_submitted=1;
 }
#endif
 if(fast_watch && pending_port==DATA_PORT_HIGH && sel_reg==CMD_FW_CATALOG){
  assert(ug_cfg.index==fast_expected_index);fast_stores++;
  if(fast_end_after_store)inject_config_expired=1;
 }
 read_value=late?255:v&255;}}
static void ug_iow_verdict(unsigned v){if(inject_config_expire_on_write&&v==IO_END)inject_config_expired=1;if(inject_config_iow_delay&&!waited)late=1;if(v==IO_WAIT)write_waited=1;else write_done=1;}
/* Finite failure injection: the host samples before a delayed native
 * decoder returns. No value is replayed; the card still consumes its byte.
 * This tests ordering, not a guessed physical nanosecond threshold. */
static void checked_native_write_decoded(int reg,uint8_t v,uint32_t now){if(inject_write_loss&&!write_waited)return;ug_minimal_write_decoded(reg,v,now);}
static void checked_gs_stat(unsigned i,unsigned n) {
 if(gs_fast_watch) { assert(i==0 && n==1);assert(gs_fast_stores==gs_fast_accounts+1);gs_fast_accounts++; }
 ug_stat_add(i,n);
}
'''
code+='static inline int ug_native_reg(uint16_t port){'+native
code+='static int timed_native_decode(unsigned p){native_decodes++;if(inject_decode_delay&&!waited&&(!second_byte_only||native_byte==1))late=1;return ug_native_reg(p);}\n'
code+='static void select_picogus(uint8_t value){'+select+'\n'
code+='static uint8_t read_picogus_high(void){generic_high_calls++;'+read+'\n'
code+='static uint8_t read_picogus_low(void){'+low+'\n'
code+='''static void write_picogus_low(uint8_t v){ug_config_write(&ug_cfg,false,v,true);}
static void write_picogus_high(uint8_t v){ug_config_write(&ug_cfg,true,v,true);}
'''
code+='static void apply_iow(uint32_t iow_read){'+iow.replace('ug_minimal_write_decoded(', 'checked_native_write_decoded(')+'\n}\n'
code+='static void bus_write(unsigned port,unsigned value){write_waited=write_done=0;apply_iow((port<<8)|value);assert(write_done);}\n'
code+='static uint16_t ug_ior_port;static bool ug_ior_pending,ug_ior_owned,ug_ior_service;\n'
code+='static void prepare_ior(void){'+prepare+'}\n'
code+='static void handle_ior(void){'+ior.replace('ug_native_reg(port)','timed_native_decode(port)').replace('ug_stat_add(0, 1)','checked_gs_stat(0, 1)')+'\n}\n'
code+='static void handle_iow(void){'+handle_iow+'\n}\n'
code+='static int iow_has_data(void){return queued_iow;}\nstatic int ior_has_data(void){return queued_ior;}\n'
code+='static void poll_once(void){'+poll+'}\n'
code+='static unsigned bus_read(unsigned port){pending_port=port;read_value=255;late=0;waited=modeled_early_wait(port);handle_ior();return read_value;}\n'
code+='''static int comma;
static void wr(unsigned p,unsigned v){bus_write(p,v);printf("%s[1,%u,%u]",comma++?",":"",p,v);}
static void rd(unsigned p){printf("%s[0,%u,%u]",comma++?",":"",p,bus_read(p));}
int main(int argc,char **argv){
 assert(argc==2);unsigned char cat[148];FILE *f=fopen(argv[1],"rb");assert(f);assert(fread(cat,1,148,f)==148);fclose(f);
 settings.startupMode=8;settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=65535;
 memcpy(mock_flash+UG_CATALOG_OFFSET,cat,148);
 mock_watchdog.scratch[0]=UG_HANDOFF_MAGIC;
 mock_watchdog.scratch[1]=0x01000808;
 mock_watchdog.scratch[2]=256;
 ug_runtime_init(&settings,8);
 assert(ug_cfg.catalog_ok && !ug_cfg.boot_result && ug_cfg.active==8);
 /* Actual read dispatch, with a lost sample after late IOCHRDY. The
  * snapshot remains intact: a failed stream cannot justify retrying bytes. */
 for(unsigned delay=0;delay<2;delay++) {
  inject_decode_delay=delay;native_decodes=0;
  bus_write(CONTROL_PORT,0xcc);bus_write(CONTROL_PORT,CMD_FW_CATALOG);
  unsigned char observed[148];
  for(unsigned i=0;i<148;i++)observed[i]=bus_read(DATA_PORT_HIGH);
  if(ug_catalog_validate(observed,true))return 86;
  assert((!delay || !native_decodes) && ug_cfg.index==148);
  assert(bus_read(DATA_PORT_HIGH)==255);
  bus_write(CONTROL_PORT,CMD_FW_ACTIVE);assert(bus_read(DATA_PORT_HIGH)==8);
  bus_write(CONTROL_PORT,CMD_FW_BOOT_RESULT);assert(bus_read(DATA_PORT_HIGH)==0);
 }
 inject_decode_delay=0;
#ifdef UG_CONFIG_TRACE
 /* The real capture/write/read branches expose accepted state without
  * invoking CONFIG or consuming native DATA/RESPONSE when sampled. */
 bus_write(CONTROL_PORT,CMD_PROTOCOL);
 if(bus_read(0x2bc)!=CMD_PROTOCOL||bus_read(0x2bd)!=CMD_PROTOCOL)return 94;
 ug_trace_reads=0;
 if(bus_read(CONTROL_PORT)!=CMD_PROTOCOL)return 95;
 if(bus_read(0x2be)!=1||bus_read(0x2bf)!=30)return 96;
 inject_config_expired=1;
 if(bus_read(CONTROL_PORT)!=255)return 97;
 if(bus_read(0x2be)!=2||bus_read(0x2bf)!=20)return 98;
 inject_config_expired=0;
 ug_trace_reads=254;bus_read(CONTROL_PORT);bus_read(CONTROL_PORT);
 if(bus_read(0x2be)!=255)return 99;
#endif
 /* Expired CONFIG catalogue reads do not silently consume their byte. */
 bus_write(CONTROL_PORT,CMD_FW_CATALOG);
 unsigned saved_index=ug_cfg.index;inject_config_expired=1;
 if(bus_read(DATA_PORT_HIGH)!=255||ug_cfg.index!=saved_index)return 92;
 inject_config_expired=0;
 if(bus_read(DATA_PORT_HIGH)!=ug_cfg.catalog[saved_index]||ug_cfg.index!=saved_index+1)return 93;
 /* Inline ownership must match the actual native decoder for all valid
  * committed maps, including low GS aliases and the fixed CONFIG ports. */
 for(unsigned base=0x200;base<=0x3e0;base+=32)for(unsigned alias=0x200;alias<=0x400;alias+=32)for(unsigned gs=0;gs<2;gs++) {
  if(base==alias)continue;
  settings.UltraGS.basePort=base;settings.UltraGS.bulkAlias=alias==0x400?65535:alias;ug_cfg.aliases=gs;
  for(unsigned port=0;port<1024;port++){
   assert(ug_native_port(port)==ug_minimal_port(port));
   assert(ug_native_reg(port)==ug_minimal_decode_port(port));
  }
 }
 /* Execute real request/reply framing through both production bus handlers.
  * A late sample loses length=24h as FF without undoing its consuming read. */
 for(unsigned base=0x200;base<=0x3e0;base+=32)for(unsigned delay=0;delay<2;delay++) {
  settings.UltraGS.basePort=base;settings.UltraGS.bulkAlias=65535;ug_cfg.aliases=false;
  ug_minimal_init();ug_minimal_ready(0,123);
  inject_write_loss=1;inject_decode_delay=delay;second_byte_only=1;native_byte=~0u;
  unsigned char command[6]={0x80,0};ug_put32(command+2,ug_crc32(command,2));
  for(unsigned i=0;i<6;i++)bus_write(base+3,command[i]);
  ug_minimal_dispatch();
  if(!(bus_read(base+1)&4))return 88;
  /* A foreign read captured before a later map change must not consume a
   * response merely because its port is now inside BASE. PIO tags capture. */
  if(base==0x200&&!delay&&early_wait_enabled){
   force_foreign=1;unsigned foreign=bus_read(base+3);force_foreign=0;
   if(foreign!=255||waited)return 90;
  }
  unsigned char reply[46];
  for(unsigned i=0;i<46;i++){native_byte=i;reply[i]=bus_read(base+3);}
  assert(bus_read(base+1)&1); /* The response was consumed, even if sampled late. */
  if(reply[0] || reply[1]!=40 || memcmp(reply+2,"UGS1",4) || ug_get32(reply+42)!=ug_crc32(reply,42))return 87;
 }
 inject_decode_delay=inject_write_loss=second_byte_only=0;native_byte=~0u;
 settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=65535;
 /* Both FIFOs can contain an earlier write and the following STATUS read.
  * Run the actual polling branch: RX must become EXEC before STATUS. */
 ug_minimal_init();ug_minimal_ready(0,123);
 unsigned char last_command[6]={0x80,0};ug_put32(last_command+2,ug_crc32(last_command,2));
 for(unsigned i=0;i<5;i++)bus_write(0x2a3,last_command[i]);
 pending_write=(0x2a3<<8)|last_command[5];pending_port=0x2a1;
 queued_iow=queued_ior=1;waited=1;read_value=255;late=0;poll_once();
 if(!(read_value&2)||queued_iow||queued_ior)return 89;
 /* Hold CONFIG before earlier IOW work; its selector change still takes
  * effect before the read value. An old IOW-first acquisition loses it. */
 bus_write(CONTROL_PORT,CMD_MAGIC);
 pending_write=(CONTROL_PORT<<8)|CMD_PROTOCOL;pending_port=DATA_PORT_HIGH;
 queued_iow=queued_ior=1;waited=0;read_value=255;late=0;inject_config_iow_delay=1;
 poll_once();inject_config_iow_delay=0;
 if(read_value!=PICOGUS_PROTOCOL_VER||queued_iow||queued_ior)return 91;
 /* A CONFIG cycle can end after prefetch while the previous IOW is
  * applied. Recheck before consuming the newly selected catalogue byte. */
 pending_write=(CONTROL_PORT<<8)|CMD_FW_CATALOG;pending_port=DATA_PORT_HIGH;
 queued_iow=queued_ior=1;read_value=255;waited=late=0;inject_config_expire_on_write=1;
 poll_once();inject_config_expire_on_write=inject_config_expired=0;
 if(read_value!=255||ug_cfg.index!=0||queued_iow||queued_ior)return 100;
 ug_minimal_init();ug_minimal_ready(0,123);
 assert(bus_read(settings.UltraGS.basePort+1)==1 && waited);
 assert(bus_read(0x100)==255 && !waited);
 puts("[");const unsigned selectors[]={0,1,2,3,0xf0,0x76,0x77,0x78,0x79,0xe3,0xe4,0xe5};
 for(unsigned i=0;i<sizeof(selectors)/sizeof(*selectors);i++){
  wr(0x1d0,0xcc);wr(0x1d0,selectors[i]);rd(0x1d0);
  if(selectors[i]==0x76||selectors[i]==0x77)rd(0x1d1);
  unsigned n=selectors[i]==0xe3?150:selectors[i]==2?15:1;
  while(n--)rd(0x1d2);
 }
 puts("]");return 0;
}
'''
if a.compat:
    # Same extracted production handlers; use the IOW10 packed word and the
    # IOR22 ownership contract. Keep the full native/map/configue trace cases,
    # but do not pretend the shared frontend's stale-read gates exist here.
    start=code.index('int main(int argc,char **argv){')
    init_end=code.index(' /* Actual read dispatch',start)
    maps=code[code.index(' /* Inline ownership'):code.index(' /* Hold CONFIG before earlier IOW work')]
    final=code[code.index(' ug_minimal_init();ug_minimal_ready(0,123);\n assert(bus_read(settings.UltraGS.basePort+1)'):]
    fence="""
 bus_write(CONTROL_PORT,0xcc);bus_write(CONTROL_PORT,CMD_FW_CATALOG);
 unsigned config_index=ug_cfg.index;inject_config_expired=1;
 if(bus_read(DATA_PORT_HIGH)!=255||ug_cfg.index!=config_index)return 101;
 inject_config_expired=0;
 assert(bus_read(DATA_PORT_HIGH)==ug_cfg.catalog[config_index]);
 bus_write(CONTROL_PORT,0xcc);bus_write(CONTROL_PORT,CMD_MAGIC);
 pending_write=(CONTROL_PORT<<8)|CMD_PROTOCOL;pending_port=DATA_PORT_HIGH;
 queued_iow=queued_ior=1;waited=0;read_value=255;late=0;
 poll_once();assert(read_value==PICOGUS_PROTOCOL_VER&&!queued_iow&&!queued_ior);
 /* GS remains an exact software decode in the compatibility profile. */
 ug_cfg.aliases=true;
 assert((bus_read(0xbb)&0x7e)==0x7e);
 assert(bus_read(0xba)==255 && !waited);
 ug_cfg.aliases=false;
 assert(bus_read(0xbb)==255 && !waited);
"""
    code=code[:init_end]+maps+fence+final
    code=code.replace('port=pending_write>>8;', 'port=pending_write>>8;return pending_write;')
    code=code.replace('early_wait_enabled&&!force_foreign&&ug_minimal_port(port)',
                      'early_wait_enabled&&!force_foreign&&port>=0x200&&ug_minimal_port(port)')
if a.probe:
    code=code.replace('pending_port=port;read_value=255;', 'probe_gpio_reads=0;pending_port=port;read_value=255;')
    marker=' ug_minimal_init();ug_minimal_ready(0,123);\n assert(bus_read(settings.UltraGS.basePort+1)'
    probe_cases="""
 bus_write(CONTROL_PORT,0xcc);bus_write(CONTROL_PORT,CMD_FW_CATALOG);
 assert(config_probe.flags==0xa0 && config_probe.index==255);
 for(unsigned n=0;n<101;n++)assert(bus_read(DATA_PORT_HIGH)==ug_cfg.catalog[n]);
 assert(config_probe.flags==0xa4 && !config_probe.late && config_probe.seen==101);
 probe_expire_index=102;probe_submitted=0;
 assert(bus_read(DATA_PORT_HIGH)==ug_cfg.catalog[101]);
 assert(probe_submitted && config_probe.late==1 && config_probe.index==101);
 assert(config_probe.value==ug_cfg.catalog[101] && config_probe.flags==0xa7);
 probe_expire_index=0;
 assert(bus_read(settings.UltraGS.basePort+0x1c)==1);
 assert(bus_read(settings.UltraGS.basePort+0x1d)==101);
 assert(bus_read(settings.UltraGS.basePort+0x1e)==ug_cfg.catalog[101]);
 assert(bus_read(settings.UltraGS.basePort+0x1f)==0xa7);
 for(unsigned n=102;n<148;n++)assert(bus_read(DATA_PORT_HIGH)==ug_cfg.catalog[n]);
 ug_config_probe saved=config_probe;
 for(unsigned n=0;n<8;n++)assert(bus_read(DATA_PORT_HIGH)==255);
 assert(!memcmp(&saved,&config_probe,sizeof saved));
 bus_write(CONTROL_PORT,0xcc);bus_write(CONTROL_PORT,CMD_FW_CATALOG);
 assert(!config_probe.late && config_probe.flags==0xa0 && !config_probe.seen);
"""
    assert marker in code;code=code.replace(marker,probe_cases+marker)
if a.fast:
    marker=' ug_minimal_init();ug_minimal_ready(0,123);\n assert(bus_read(settings.UltraGS.basePort+1)'
    fast_cases="""
 bus_write(CONTROL_PORT,0xcc);bus_write(CONTROL_PORT,CMD_FW_CATALOG);
 unsigned prior_calls=generic_high_calls;
 fast_watch=1;fast_stores=0;
 for(unsigned n=0;n<148;n++) {
  fast_expected_index=n;fast_end_after_store=(n&1);
  assert(bus_read(DATA_PORT_HIGH)==ug_cfg.snapshot[n]);
  assert(ug_cfg.index==n+1);inject_config_expired=0;
 }
 assert(fast_stores==148 && generic_high_calls==prior_calls);
 fast_expected_index=148;fast_end_after_store=0;
 for(unsigned n=0;n<8;n++)assert(bus_read(DATA_PORT_HIGH)==255 && ug_cfg.index==148);
 ug_cfg.index=65535;fast_expected_index=65535;
 assert(bus_read(DATA_PORT_HIGH)==255 && ug_cfg.index==65535);
 fast_watch=0;
 bus_write(CONTROL_PORT,CMD_FW_CATALOG);
 assert(ug_cfg.index==0 && bus_read(DATA_PORT_HIGH)==ug_cfg.snapshot[0] && ug_cfg.index==1);
 /* Low-port read, selector change, and live RESULT still use the old semantics. */
 assert(bus_read(DATA_PORT_LOW)==255 && ug_cfg.index==1);
 bus_write(CONTROL_PORT,CMD_UG_CFG_RESULT);ug_cfg.result=0x16;
 assert(bus_read(DATA_PORT_HIGH)==0x16);
 __atomic_store_n(&ug_cfg.maintenance,1,__ATOMIC_RELEASE);
 assert(bus_read(DATA_PORT_HIGH)==5);
 __atomic_store_n(&ug_cfg.maintenance,0,__ATOMIC_RELEASE);
 assert(bus_read(DATA_PORT_HIGH)==0x16);
 ug_cfg.result=0; /* Restore the initial state for the common JSON trace. */
 """
    assert marker in code;code=code.replace(marker,fast_cases+marker)
if a.gs_fast:
    marker=' ug_minimal_init();ug_minimal_ready(0,123);\n assert(bus_read(settings.UltraGS.basePort+1)'
    gs_cases="""
 for(unsigned bits=0;bits<4;bits++) {
  ug_minimal_init();ug_minimal_ready(0,123);ug_cfg.aliases=true;
  if(bits&2)ug_minimal_write_decoded(0x13,42,0);
  if(bits&1)ug_minimal_write_decoded(0x1b,0,0);
  unsigned expected=0x7e|((bits&2)?128:0)|(bits&1);
  gs_fast_watch=1;
  for(unsigned n=0;n<32;n++)assert(bus_read(0xbb)==expected && waited);
  assert(gs_fast_stores==gs_fast_accounts);
  assert(bus_read(settings.UltraGS.basePort+0x1b)==expected);
  inject_config_expired=1;unsigned before=gs_fast_stores;
  assert(bus_read(0xbb)==255 && !waited);
  assert(gs_fast_stores==before && gs_fast_accounts==before);
  inject_config_expired=0;ug_cfg.aliases=false;
  assert(bus_read(0xbb)==255 && !waited);
  assert(gs_fast_stores==before);
  gs_fast_watch=0;
 }
 ug_minimal_init();ug_minimal_ready(0,123);ug_cfg.aliases=true;
 for(unsigned port=0xb0;port<0xc0;port++) {
  unsigned v=bus_read(port);
  if(port==0xbb)assert(v==0x7e && waited);
  else if(port!=0xb3)assert(v==255 && !waited);
 }
 ug_cfg.aliases=false;
 """
    assert marker in code;code=code.replace(marker,gs_cases+marker)
c=a.build/'config-exchange.c';c.write_text(code);exe=a.build/'config-exchange'
objects=[];dependencies=[]
for index,source in enumerate([c,r/'sw/ultrags/ug_config.c',r/'sw/multifw/ug_catalog.c',r/'sw/ultrags/ug_maintenance.cpp',r/'sw/ultrags/ug_minimal.c',r/'tests/ultrags/unit/s2_mock/maintenance_hooks.cpp']):
    obj=a.build/f'config-exchange-{index}.o';dep=a.build/f'config-exchange-{index}.d'
    objects.append(str(obj));dependencies.append(dep)
    compiler=['c++','-std=c++17'] if source.suffix=='.cpp' else ['cc','-std=c11']
    flags=['-DUG_BUNDLE=1','-Wall','-Wextra','-Werror','-Wno-unused-variable','-Wno-unused-function','-fsanitize=undefined','-fno-sanitize-recover=all','-I'+str(r/'common'),'-I'+str(r/'sw'),'-I'+str(r/'tests/ultrags/unit/s2_mock'),'-I'+str(a.build/'gen')]
    if a.probe:flags+=['-DUG_CONFIG_PROBE=1']
    if a.fast:flags+=['-DUG_CONFIG_CATALOG_FAST=1']
    if a.gs_fast:flags+=['-DUG_GS_STATUS_FAST=1']
    if index==0: flags+=['-DSOUND_ULTRAGS=1','-DUG_ISA_COMPAT_READ=1' if a.compat else '-DUG_ISA_EARLY_READ=1']+(['-DUG_CONFIG_TRACE=1'] if a.trace else [])
    subprocess.run(compiler+flags+['-MMD','-MF',str(dep),'-c',str(source),'-o',str(obj)],check=True)
subprocess.run(['c++','-fsanitize=undefined',*objects,'-o',str(exe)],check=True)
trace=subprocess.check_output([str(exe),str(a.catalog.resolve())]);json.loads(trace)
if not a.compat:
    # The previous ordering must lose the sampled bytes under the same finite
    # decode-delay fixture, although the firmware has consumed all 148 reads.
    old='if (port >= CONTROL_PORT && port <= DATA_PORT_HIGH) goto config_ior;'
    assert code.count(old)==1
    legacy_capture='waited=owned||(port>=0x1d0&&port<=0x1d2);return waited;'
    assert legacy_capture in code
    mutant=a.build/'config-exchange-late.c';mutant.write_text(code.replace(old,'/* old native-first dispatch */').replace(legacy_capture,'waited=owned;return true;'))
    mutant_obj=a.build/'config-exchange-late.o';mutant_exe=a.build/'config-exchange-late'
    subprocess.run(['cc','-std=c11',*flags,'-DSOUND_ULTRAGS=1','-DUG_ISA_EARLY_READ=1','-Wno-unused-label','-c',str(mutant),'-o',str(mutant_obj)],check=True)
    subprocess.run(['c++','-fsanitize=undefined',str(mutant_obj),*objects[1:],'-o',str(mutant_exe)],check=True)
    assert subprocess.run([str(mutant_exe),str(a.catalog.resolve())],capture_output=True).returncode==86, 'old late-assertion mutation survived'
    print('ULTRAGS fixed config IOR: early assertion PASS; old ordering loses catalogue under decode-delay injection')
    foreign_guard='if (!native_capture) { ISA_PIO_PUT(pio0,IOR_PIO_SM,IO_END); return; }'
    assert code.count(foreign_guard)==1
    for name,body,expected in [
     ('native-late',code.replace('early_wait_enabled=1','early_wait_enabled=0').replace(foreign_guard,'/* legacy PIO had no ownership tag */'),87),
     ('native-write',code.replace('ug_iow_verdict(IO_WAIT);\n        checked_native_write_decoded(', '/* old IO_END-only native write */\n        checked_native_write_decoded('),88),
     ('read-before-write',code.replace(poll,'if(ior_has_data())handle_ior();else if(iow_has_data())handle_iow();'),89),
     ('retroactive-native',code.replace(foreign_guard,'/* ignored captured ownership */'),90),
     ('config-prefetch-late',code.replace(poll,poll.replace('if(!ug_ior_pending && ior_has_data()) prepare_ior();','/* old acquisition after IOW */').replace('if (ug_ior_pending) handle_ior();','if (ior_has_data()) handle_ior();')),91),
     ('config-stale-consume',code.replace('(!ug_ior_service || (!native_capture && !ug_handshake_read_active())) && (native_capture || (port>=CONTROL_PORT && port<=DATA_PORT_HIGH))','false'),92),
     ('config-expire-after-write',code.replace('!ug_ior_service || (!native_capture && !ug_handshake_read_active())','!ug_ior_service'),100),
    ]:
        assert body!=code
        mutant=a.build/(name+'.c');mutant.write_text(body)
        obj=a.build/(name+'.o');binary=a.build/name
        subprocess.run(['cc','-std=c11',*flags,'-DSOUND_ULTRAGS=1','-DUG_ISA_EARLY_READ=1','-c',str(mutant),'-o',str(obj)],check=True)
        subprocess.run(['c++','-fsanitize=undefined',str(obj),*objects[1:],'-o',str(binary)],check=True)
        assert subprocess.run([str(binary),str(a.catalog.resolve())],capture_output=True).returncode==expected, name+' mutation survived'
    print('ULTRAGS native INFO: same decode delay on both paths, early PIO wait PASS; old late length, missing write handshake and IOR-before-IOW mutations rejected')
else:
    for name,body,expected in [
        ('compat-stale',code.replace('if((pins&((1023u<<6)|(1u<<5)))!=((uint32_t)port<<6))','if(false)'),101),
        ('compat-retroactive',code.replace('if(port>=0x200 && !native_capture)','if(false)'),90),
        ('compat-reordered',code.replace(poll,'if(ior_has_data())handle_ior();else if(iow_has_data())handle_iow();'),89),
    ]:
        assert body!=code
        src=a.build/(name+'.c');src.write_text(body);obj=a.build/(name+'.o');binary=a.build/name
        subprocess.run(['cc','-std=c11',*flags,'-DSOUND_ULTRAGS=1','-DUG_ISA_COMPAT_READ=1',
                        '-c',str(src),'-o',str(obj)],check=True)
        subprocess.run(['c++','-fsanitize=undefined',str(obj),*objects[1:],'-o',str(binary)],check=True)
        assert subprocess.run([str(binary),str(a.catalog.resolve())],capture_output=True).returncode==expected,name
    print('COMPAT: stale consuming-read, retroactive ownership and read-before-write mutations rejected')
if a.fast:
    commit='if (index < sizeof(ug_cfg.snapshot)) ug_cfg.index = index + 1;'
    submit='ISA_PIO_PUT(pio0, IOR_PIO_SM, IOR_SET_VALUE | value);'
    start=code.index('#ifdef UG_CONFIG_CATALOG_FAST\n')
    # Locate the actual branch (the define may also occur in a later build).
    start=code.index('if (port == DATA_PORT_HIGH && sel_reg == CMD_FW_CATALOG)',start)
    end=code.index('    if (port == CONTROL_PORT)',start)
    branch=code[start:end]
    assert branch.count(commit)==1 and branch.count(submit)==1
    variants=[
      ('fast-preconsume',branch.replace(commit,'').replace(submit,commit+'\n'+submit),
       'ug_cfg.index==fast_expected_index'),
      ('fast-postcheck',branch.replace(commit,
       'if (index < sizeof(ug_cfg.snapshot) && !(gpio_get_all()&(1u<<5))) ug_cfg.index = index + 1;'),
       'ug_cfg.index==n+1'),
    ]
    for name,replacement,error in variants:
        body=code[:start]+replacement+code[end:]
        src=a.build/(name+'.c');src.write_text(body);obj=a.build/(name+'.o');binary=a.build/name
        subprocess.run(['cc','-std=c11',*flags,'-DSOUND_ULTRAGS=1','-DUG_ISA_COMPAT_READ=1',
                        '-c',str(src),'-o',str(obj)],check=True)
        subprocess.run(['c++','-fsanitize=undefined',str(obj),*objects[1:],'-o',str(binary)],check=True)
        failed=subprocess.run([str(binary),str(a.catalog.resolve())],capture_output=True)
        assert failed.returncode!=0 and error.encode() in failed.stderr,name
    print('FAST catalogue: 148 ordered bytes, exhausted/bad index, live RESULT; pre-consume/post-send GPIO mutations rejected')
if a.gs_fast:
    before='const uint8_t value = ug_minimal_peek_gs_status();'
    account='checked_gs_stat(0, 1);'
    assert code.count(before)==code.count(account)==1
    body=code.replace(account,'').replace(before,account+'\n'+before)
    src=a.build/'gs-stat-before.c';src.write_text(body);obj=src.with_suffix('.o');binary=a.build/'gs-stat-before'
    subprocess.run(['cc','-std=c11',*flags,'-DSOUND_ULTRAGS=1','-DUG_ISA_COMPAT_READ=1','-c',str(src),'-o',str(obj)],check=True)
    subprocess.run(['c++','-fsanitize=undefined',str(obj),*objects[1:],'-o',str(binary)],check=True)
    failed=subprocess.run([str(binary),str(a.catalog.resolve())],capture_output=True)
    assert failed.returncode!=0 and b'gs_fast_stores==gs_fast_accounts+1' in failed.stderr
    print('GS fast: 128 live status reads, aliases OFF/neighbours/stale passivity; pre-submit statistics mutation rejected')
(a.build/'config-exchange.json').write_bytes(trace)
inputs={r/'sw/picogus.cpp',r/'sw/ultrags/ug_config.c',r/'sw/multifw/ug_catalog.c',r/'tools/ultrags/gen-wire.mjs',r/'tools/ultrags/wire-schema.json',a.catalog.resolve(),Path(__file__).resolve()}
for dependency in dependencies:
    for name in shlex.split(dependency.read_text().replace('\\\n',' ').split(':',1)[1]):
        path=Path(name);inputs.add(path.resolve())
(a.build/'config-exchange-inputs.json').write_text(json.dumps({str(p.relative_to(r)) if p.is_relative_to(r) else str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(inputs)},indent=2)+'\n')
(a.build/'config-exchange-profile.json').write_text(json.dumps({
    'status':'HOST_PASS / REAL_PENDING','compat':a.compat,'probe':a.probe,'fast':a.fast,'gsFast':a.gs_fast,
    'fastOrderedBytes':148 if a.fast else 0,'fastMutationsRejected':2 if a.fast else 0,
    'traceSha256':hashlib.sha256(trace).hexdigest(),
    'inputsSha256':hashlib.sha256((a.build/'config-exchange-inputs.json').read_bytes()).hexdigest(),
    'executableSha256':hashlib.sha256(exe.read_bytes()).hexdigest()
},indent=2)+'\n')
print('Production config exchange HOST_PASS:',len(json.loads(trace)),'bus operations')
