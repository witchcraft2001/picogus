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
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--catalog',type=Path,required=True);a=p.parse_args()
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
poll=between('#elif defined(SOUND_ULTRAGS)\n','\n#else\n')
code='''#include <stdio.h>
#include <assert.h>
#include <string.h>
#include "picogus.h"
#include "ultrags/ug_config.h"
#include "ultrags/ug_minimal.h"
#include "ultrags/ug_handshake.h"
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
static unsigned pending_write,queued_iow,queued_ior,early_wait_enabled=1,force_foreign;
static unsigned write_waited,write_done,inject_write_loss,native_byte=~0u,second_byte_only;
static const char *firmware_string="PicoGUS model";
#define IO_WAIT 1
#define IO_END 0
#define IOR_SET_VALUE 0x100
#define pio0 0
#define IOR_PIO_SM 1
#define IOW_PIO_SM 0
static unsigned modeled_early_wait(unsigned port){return early_wait_enabled&&!force_foreign&&port>=0x200&&ug_minimal_port(port);}
static unsigned pio_sm_get(int p,int sm){(void)p;if(sm==IOW_PIO_SM){queued_iow=0;return pending_write;}queued_ior=0;unsigned raw=((pending_port&31)<<27)|(pending_port>>5);return modeled_early_wait(pending_port)?~raw:raw;}
static void pio_sm_put(int p,int sm,unsigned v){(void)p;(void)sm;if(v==IO_WAIT)waited=1;else if(v&IOR_SET_VALUE)read_value=late?255:v&255;}
static void ug_iow_verdict(unsigned v){if(v==IO_WAIT)write_waited=1;else write_done=1;}
/* Finite failure injection: the host samples before a delayed native
 * decoder returns. No value is replayed; the card still consumes its byte.
 * This tests ordering, not a guessed physical nanosecond threshold. */
static void checked_native_write_decoded(int reg,uint8_t v,uint32_t now){if(inject_write_loss&&!write_waited)return;ug_minimal_write_decoded(reg,v,now);}
'''
code+='static inline int ug_native_reg(uint16_t port){'+native
code+='static int timed_native_decode(unsigned p){native_decodes++;if(inject_decode_delay&&!waited&&(!second_byte_only||native_byte==1))late=1;return ug_native_reg(p);}\n'
code+='static void select_picogus(uint8_t value){'+select+'\n'
code+='static uint8_t read_picogus_high(void){'+read+'\n'
code+='static uint8_t read_picogus_low(void){'+low+'\n'
code+='''static void write_picogus_low(uint8_t v){ug_config_write(&ug_cfg,false,v,true);}
static void write_picogus_high(uint8_t v){ug_config_write(&ug_cfg,true,v,true);}
'''
code+='static void apply_iow(uint32_t iow_read){'+iow.replace('ug_minimal_write_decoded(', 'checked_native_write_decoded(')+'\n}\n'
code+='static void bus_write(unsigned port,unsigned value){write_waited=write_done=0;apply_iow((port<<8)|value);assert(write_done);}\n'
code+='static void handle_ior(void){'+ior.replace('ug_native_reg(port)','timed_native_decode(port)')+'}\n'
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
  unsigned char reply[42];
  for(unsigned i=0;i<42;i++){native_byte=i;reply[i]=bus_read(base+3);}
  assert(bus_read(base+1)&1); /* The response was consumed, even if sampled late. */
  if(reply[0] || reply[1]!=36 || memcmp(reply+2,"UGS1",4) || ug_get32(reply+38)!=ug_crc32(reply,38))return 87;
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
c=a.build/'config-exchange.c';c.write_text(code);exe=a.build/'config-exchange'
objects=[];dependencies=[]
for index,source in enumerate([c,r/'sw/ultrags/ug_config.c',r/'sw/multifw/ug_catalog.c',r/'sw/ultrags/ug_maintenance.cpp',r/'sw/ultrags/ug_minimal.c',r/'tests/ultrags/unit/s2_mock/maintenance_hooks.cpp']):
    obj=a.build/f'config-exchange-{index}.o';dep=a.build/f'config-exchange-{index}.d'
    objects.append(str(obj));dependencies.append(dep)
    compiler=['c++','-std=c++17'] if source.suffix=='.cpp' else ['cc','-std=c11']
    flags=['-DUG_BUNDLE=1','-Wall','-Wextra','-Werror','-Wno-unused-variable','-Wno-unused-function','-fsanitize=undefined','-fno-sanitize-recover=all','-I'+str(r/'common'),'-I'+str(r/'sw'),'-I'+str(r/'tests/ultrags/unit/s2_mock'),'-I'+str(a.build/'gen')]
    if index==0: flags+=['-DSOUND_ULTRAGS=1','-DUG_ISA_EARLY_READ=1']
    subprocess.run(compiler+flags+['-MMD','-MF',str(dep),'-c',str(source),'-o',str(obj)],check=True)
subprocess.run(['c++','-fsanitize=undefined',*objects,'-o',str(exe)],check=True)
trace=subprocess.check_output([str(exe),str(a.catalog.resolve())]);json.loads(trace)
# The previous ordering must lose the sampled bytes under the same finite
# decode-delay fixture, although the firmware has consumed all 148 reads.
old='if (port >= CONTROL_PORT && port <= DATA_PORT_HIGH) goto config_ior;'
assert code.count(old)==1
mutant=a.build/'config-exchange-late.c';mutant.write_text(code.replace(old,'/* old native-first dispatch */'))
mutant_obj=a.build/'config-exchange-late.o';mutant_exe=a.build/'config-exchange-late'
subprocess.run(['cc','-std=c11',*flags,'-DSOUND_ULTRAGS=1','-DUG_ISA_EARLY_READ=1','-Wno-unused-label','-c',str(mutant),'-o',str(mutant_obj)],check=True)
subprocess.run(['c++','-fsanitize=undefined',str(mutant_obj),*objects[1:],'-o',str(mutant_exe)],check=True)
assert subprocess.run([str(mutant_exe),str(a.catalog.resolve())],capture_output=True).returncode==86, 'old late-assertion mutation survived'
print('ULTRAGS fixed config IOR: early assertion PASS; old ordering loses catalogue under decode-delay injection')
foreign_guard='if (port>=0x200 && !native_capture) { pio_sm_put(pio0,IOR_PIO_SM,IO_END); return; }'
assert code.count(foreign_guard)==1
for name,body,expected in [
 ('native-late',code.replace('early_wait_enabled=1','early_wait_enabled=0').replace(foreign_guard,'/* legacy PIO had no ownership tag */'),87),
 ('native-write',code.replace('ug_iow_verdict(IO_WAIT);\n        checked_native_write_decoded(', '/* old IO_END-only native write */\n        checked_native_write_decoded('),88),
 ('read-before-write',code.replace(poll,'if(ior_has_data())handle_ior();else if(iow_has_data())handle_iow();'),89),
 ('retroactive-native',code.replace(foreign_guard,'/* ignored captured ownership */'),90),
]:
    assert body!=code
    mutant=a.build/(name+'.c');mutant.write_text(body)
    obj=a.build/(name+'.o');binary=a.build/name
    subprocess.run(['cc','-std=c11',*flags,'-DSOUND_ULTRAGS=1','-DUG_ISA_EARLY_READ=1','-c',str(mutant),'-o',str(obj)],check=True)
    subprocess.run(['c++','-fsanitize=undefined',str(obj),*objects[1:],'-o',str(binary)],check=True)
    assert subprocess.run([str(binary),str(a.catalog.resolve())],capture_output=True).returncode==expected, name+' mutation survived'
print('ULTRAGS native INFO: same decode delay on both paths, early PIO wait PASS; old late length, missing write handshake and IOR-before-IOW mutations rejected')
(a.build/'config-exchange.json').write_bytes(trace)
inputs={r/'sw/picogus.cpp',r/'sw/ultrags/ug_config.c',r/'sw/multifw/ug_catalog.c',r/'tools/ultrags/gen-wire.mjs',r/'tools/ultrags/wire-schema.json',a.catalog.resolve(),Path(__file__).resolve()}
for dependency in dependencies:
    for name in shlex.split(dependency.read_text().replace('\\\n',' ').split(':',1)[1]):
        path=Path(name);inputs.add(path.resolve())
(a.build/'config-exchange-inputs.json').write_text(json.dumps({str(p.relative_to(r)) if p.is_relative_to(r) else str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(inputs)},indent=2)+'\n')
print('Production config exchange HOST_PASS:',len(json.loads(trace)),'bus operations')
