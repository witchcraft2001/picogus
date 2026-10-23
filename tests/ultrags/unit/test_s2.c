/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "mock.h"
#include "picogus.h"
#include "hardware/structs/watchdog.h"
#include "hardware/structs/xip_ctrl.h"
#include "hardware/structs/vreg_and_chip_reset.h"
#include "multifw/ug_catalog.h"
#include "ultrags/ug_config.h"
#include "ultrags/ug_minimal.h"
#include "ultrags_protocol.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
uint8_t mock_flash[0x200000];
unsigned mock_erases,mock_programs,mock_clock=370000000,mock_prepares,mock_restores,mock_clock_changes;
mock_watchdog_t mock_watchdog;
mock_xip_t mock_xip;
mock_chip_reset_t mock_chip_reset;
void flash_range_erase(uint32_t o,size_t n){assert(mock_clock==370000000&&!mock_clock_changes);assert(o==UG_SETTINGS_OFFSET&&n==4096);memset(mock_flash+o,255,n);mock_erases++;}
void flash_range_program(uint32_t o,const uint8_t *d,size_t n){assert(mock_clock==370000000&&!mock_clock_changes&&n==256);memcpy(mock_flash+o,d,n);mock_programs++;}
static void seal(uint8_t *c){ug_put32(c+144,ug_crc32(c,144));}
static void image(uint8_t *c,unsigned mode,unsigned offset){
 uint8_t *r=c+16+(mode-1)*16; r[0]=mode;r[1]=1;ug_put32(r+4,offset);ug_put32(r+8,1024);
 ug_put32(mock_flash+offset+256,0x20042000);ug_put32(mock_flash+offset+260,0x10000000+offset+265);
 ug_put32(r+12,ug_crc32(mock_flash+offset,1024));
}
static void cfgwrite(ug_config *c,uint8_t sel,uint16_t v,bool idle){ug_config_select(c,sel);ug_config_write(c,false,v,idle);ug_config_write(c,true,v>>8,idle);}
static unsigned stop_dispatch;
static void *dispatch_thread(void *unused) {
 (void)unused;
 while(!__atomic_load_n(&stop_dispatch,__ATOMIC_ACQUIRE))ug_minimal_dispatch();
 return NULL;
}
int main(int argc,char **argv){
 memset(mock_flash,255,sizeof(mock_flash));
 uint8_t *cat=mock_flash+UG_CATALOG_OFFSET;memset(cat,0,148);memcpy(cat,"UGCF\1\0\10\20",8);ug_put32(cat+8,148);
 for(unsigned i=1;i<=8;i++){cat[16+(i-1)*16]=i;if(i!=7)image(cat,i,0x8000+(i-1)*1024);}
 seal(cat); assert(ug_crc32("123456789",9)==0xcbf43926);
 assert(!ug_catalog_validate(cat,false));ug_image recovery;assert(!ug_catalog_resolve(cat,1,&recovery));
 for(unsigned wd=0;wd<2;wd++)for(unsigned requested=0;requested<10;requested++){
  uint32_t r=requested;ug_boot b=ug_boot_select(mock_flash,sizeof(mock_flash),&recovery,wd,&r,8,true);
  assert(!r&&!b.safe);unsigned want=wd&&requested?requested:8;
  assert(b.active==(want==7||want==9?1:want));assert(b.result==(want==7?6:want==9?1:0));
 }
 uint32_t r=8;ug_boot b=ug_boot_select(mock_flash,sizeof(mock_flash),&recovery,true,&r,8,false);assert(b.active==8&&!b.result);
 r=8;b=ug_boot_select(mock_flash,sizeof(mock_flash),&recovery,false,&r,1,false);assert(b.result==4&&b.active==1&&!r);
 uint8_t saved[148];memcpy(saved,cat,148);
 for(unsigned byte=0;byte<148;byte++){cat[byte]^=1;r=8;b=ug_boot_select(mock_flash,sizeof(mock_flash),&recovery,true,&r,1,true);assert(b.result==5&&b.active==1&&!r);cat[byte]^=1;}
 mock_flash[0x9c00]^=1;r=8;b=ug_boot_select(mock_flash,sizeof(mock_flash),&recovery,true,&r,1,true);assert(b.result==2&&b.active==1);
 mock_flash[0x8000]^=1;r=8;b=ug_boot_select(mock_flash,sizeof(mock_flash),&recovery,true,&r,1,true);assert(b.safe&&b.result==2);mock_flash[0x8000]^=1;mock_flash[0x9c00]^=1;
 const uint32_t badsp[]={0,0x20000000,0x20042008,0x20041001};
 for(unsigned i=0;i<4;i++){ug_put32(mock_flash+0x9d00,badsp[i]);ug_put32(cat+16+7*16+12,ug_crc32(mock_flash+0x9c00,1024));seal(cat);r=8;b=ug_boot_select(mock_flash,sizeof(mock_flash),&recovery,true,&r,1,true);assert(b.result==3&&b.active==1);}
 image(cat,8,0x9c00);seal(cat);
 const uint32_t badpc[]={0,0x10009d08,0x10007fff,0x1000a001};
 for(unsigned i=0;i<4;i++){ug_put32(mock_flash+0x9d04,badpc[i]);ug_put32(cat+16+7*16+12,ug_crc32(mock_flash+0x9c00,1024));seal(cat);r=8;b=ug_boot_select(mock_flash,sizeof(mock_flash),&recovery,true,&r,1,true);assert(b.result==3&&b.active==1&&!r);}
 image(cat,8,0x9c00);seal(cat);
 r=8;b=ug_boot_select(NULL,0,&recovery,true,&r,1,true);assert(b.safe&&b.result==5&&!r);
 /* Faults with freshly sealed catalog CRC must fail semantic validation. */
 memcpy(saved,cat,148);
 cat[32]=1;seal(cat);assert(ug_catalog_validate(cat,false)==5);memcpy(cat,saved,148);
 ug_put32(cat+36,0x8000);seal(cat);assert(ug_catalog_validate(cat,false)==5);memcpy(cat,saved,148);
 ug_put32(cat+20,0x7c00);seal(cat);assert(ug_catalog_validate(cat,false)==5);memcpy(cat,saved,148);
 ug_image bad_recovery=recovery;bad_recovery.offset=UG_SETTINGS_OFFSET;
 cat[0]^=1;r=8;b=ug_boot_select(mock_flash,sizeof(mock_flash),&bad_recovery,true,&r,1,true);assert(b.safe&&b.result==5&&!r);cat[0]^=1;
 uint8_t result;uint32_t checked;
 assert(ug_handoff(UG_HANDOFF_MAGIC,0x01000808,256,8,&result,&checked)&&!result&&checked==256);
 assert(!ug_handoff(UG_HANDOFF_MAGIC,0x01000108,256,8,&result,&checked)&&result==7&&!checked);
 assert(!ug_handoff(UG_HANDOFF_MAGIC,0x02000808,256,8,&result,&checked));
 assert(!ug_handoff(UG_HANDOFF_MAGIC,0x01000808,128,8,&result,&checked));
 assert(!ug_handoff(0,0x01000808,256,8,&result,&checked));
 Settings old,s;getDefaultSettings(&old);old.version=5;old.startupMode=8;old.SB.basePort=0x260;old.Volume.mainVol=42;old.UltraGS.basePort=0xaaaa;old.UltraGS.bulkAlias=0xbbbb;
 memcpy(mock_flash+UG_SETTINGS_OFFSET,&old,sizeof(old));loadSettings(&s,true);
 assert(sizeof(s)==156&&offsetof(Settings,UltraGS)==152&&s.version==6&&s.UltraGS.basePort==0x2a0&&s.UltraGS.bulkAlias==0xffff);
 old.version=6;assert(!memcmp(&s,&old,152));assert(!mock_erases);
 Settings corrupt=s;corrupt.UltraGS.basePort=1;
 ug_config_init(&ug_cfg,&corrupt,1,cat,UG_HANDOFF_MAGIC,0x01020108,2);
 assert(ug_cfg.boot_result==2&&ug_cfg.active==1&&corrupt.startupMode==8&&corrupt.UltraGS.basePort==0x2a0);
 ug_config_init(&ug_cfg,&s,1,cat,UG_HANDOFF_MAGIC,0x01050108,2);
 assert(!ug_cfg.catalog_ok&&ug_cfg.boot_result==5);
 ug_config_select(&ug_cfg,3);ug_config_write(&ug_cfg,true,1,true);assert(ug_cfg.result==6&&s.startupMode==8);
 ug_config_init(&ug_cfg,&s,8,cat,UG_HANDOFF_MAGIC,0x01000808,256);
 assert(ug_cfg.catalog_ok&&ug_cfg.active==8&&s.startupMode==8&&!ug_cfg.aliases);
 ug_config_select(&ug_cfg,0xe3);for(unsigned i=0;i<148;i++)saved[i]=ug_config_read(&ug_cfg,true);assert(!ug_catalog_validate(saved,true));assert(saved[17+7*16]==3&&saved[17]==1);assert(ug_config_read(&ug_cfg,true)==255);
 ug_config_select(&ug_cfg,0x76);ug_config_write(&ug_cfg,false,0xc0,true);assert(ug_config_read(&ug_cfg,false)==0xa0);
 ug_config_select(&ug_cfg,0x76);ug_config_write(&ug_cfg,true,3,true);assert(s.UltraGS.basePort==0x300);
 cfgwrite(&ug_cfg,0x76,0x2a0,false);assert(ug_cfg.result==5&&s.UltraGS.basePort==0x300);
 for(unsigned base=0;base<0x500;base++)assert((ug_ports_validate(base,0xffff)==0)==(base>=0x200&&base<=0x3e0&&base!=0x380&&!(base&31)));
 uint16_t old_opl=s.SB.oplBasePort;
 cfgwrite(&ug_cfg,CMD_OPLPORT,0x388,true);assert(!ug_cfg.result&&s.SB.oplBasePort==old_opl);
 assert(ug_config_read(&ug_cfg,false)==0x88&&ug_config_read(&ug_cfg,true)==3);
 cfgwrite(&ug_cfg,CMD_OPLPORT,0x220,true);assert(ug_cfg.result==2&&s.SB.oplBasePort==old_opl);
 cfgwrite(&ug_cfg,0x76,0x380,true);assert(ug_cfg.result==2&&s.UltraGS.basePort==0x300);
 cfgwrite(&ug_cfg,0x77,0x380,true);assert(ug_cfg.result==2&&s.UltraGS.bulkAlias==0xffff);
 Settings invalid=s;invalid.UltraGS.basePort=0x380;ug_config recovered;
 ug_config_init(&recovered,&invalid,8,NULL,0,0,0);assert(invalid.UltraGS.basePort==0x2a0&&invalid.UltraGS.bulkAlias==0xffff&&recovered.boot_result==4);
 invalid=s;invalid.UltraGS.bulkAlias=0x380;
 ug_config_init(&recovered,&invalid,8,NULL,0,0,0);assert(invalid.UltraGS.basePort==0x2a0&&invalid.UltraGS.bulkAlias==0xffff&&recovered.boot_result==4);
 cfgwrite(&ug_cfg,0x77,0x300,true);assert(ug_cfg.result==2&&s.UltraGS.bulkAlias==0xffff);
 ug_config_select(&ug_cfg,3);ug_config_write(&ug_cfg,true,7,true);assert(ug_cfg.result==6&&s.startupMode==8);ug_config_write(&ug_cfg,true,9,true);assert(ug_cfg.result==2&&s.startupMode==8);
 ug_config_write(&ug_cfg,true,1,true);assert(!ug_cfg.result&&s.startupMode==1&&ug_cfg.active==8);
 ug_config_select(&ug_cfg,0xe1);ug_config_write(&ug_cfg,true,255,false);assert(ug_cfg.result==5&&!ug_config_busy(&ug_cfg)&&!mock_erases);
 ug_config_write(&ug_cfg,true,255,true);assert(ug_config_busy(&ug_cfg));Settings snapshot=ug_cfg.save_snapshot;
 cfgwrite(&ug_cfg,0x76,0x2c0,true);assert(!memcmp(&snapshot,&ug_cfg.save_snapshot,sizeof(snapshot))&&s.UltraGS.basePort==0x300);
 ug_minimal_init();ug_minimal_ready(0,1);
 ug_maintenance_poll();assert(mock_erases==1&&mock_programs==1&&mock_clock==370000000&&!mock_clock_changes&&mock_prepares==1&&mock_restores==1);assert(!ug_cfg.result&&!ug_config_busy(&ug_cfg));
 ug_config_select(&ug_cfg,0x79);ug_config_write(&ug_cfg,true,1,true);assert(ug_cfg.aliases);
 loadSettings(&s,true);ug_config_init(&ug_cfg,&s,8,cat,UG_HANDOFF_MAGIC,0x01000801,256);assert(!ug_cfg.aliases&&s.startupMode==1);
 ug_minimal_init();ug_minimal_ready(0,123);assert(ug_minimal_idle());
 const unsigned base=s.UltraGS.basePort;
 /* Compatibility port wrappers keep their old out-of-map result/error
  * precedence. Bus dispatch itself never responds on these foreign ports. */
 assert(!ug_minimal_port(0x100)&&ug_minimal_read(0x100)==0);
 ug_minimal_write(0x100,0,0);assert(ug_minimal_read(base+6)==0x14);
 ug_minimal_transport_fault();ug_minimal_write(0x100,0,0);
 assert(ug_minimal_read(base+6)==UG_ERR_OVERFLOW);
 ug_minimal_init();ug_minimal_ready(0,123);
 ug_minimal_write(base+3,0,0);assert(!ug_minimal_idle());ug_minimal_write(base+3,0,0);assert(ug_minimal_read(base+1)&2);ug_minimal_dispatch();assert(ug_minimal_read(base+1)&4);
 uint8_t reply[46];for(unsigned i=0;i<42;i++)reply[i]=ug_minimal_read(base+3);assert(!memcmp(reply,"\0\50UGS1\1\0\10\0",10));assert(ug_minimal_idle());
 ug_minimal_write(base+3,0x80,0);ug_minimal_write(base+3,0,0);uint8_t req[]={0x80,0};uint32_t crc=ug_crc32(req,2);for(unsigned i=0;i<4;i++)ug_minimal_write(base+3,crc>>(i*8),0);ug_minimal_dispatch();for(unsigned i=0;i<46;i++)reply[i]=ug_minimal_read(base+3);assert(ug_get32(reply+42)==ug_crc32(reply,42));
 ug_minimal_write(base+3,0,0);ug_minimal_write(base+3,129,0);assert(!(ug_minimal_read(base+1)&7)&&ug_minimal_read(base+6)==3);ug_minimal_write(base+3,0,0);assert(!(ug_minimal_read(base+1)&7));
 ug_minimal_write(base+2,0xa0,0);assert(ug_minimal_idle());ug_minimal_write(base+3,0,0);ug_minimal_poll(1000000);assert(ug_minimal_read(base+6)==13);ug_minimal_write(base+2,0xa0,0);
 ug_minimal_write(base+3,1,0);ug_minimal_write(base+3,0,0);ug_minimal_dispatch();assert(ug_minimal_read(base+3)==1&&ug_minimal_read(base+3)==0);
 ug_cfg.aliases=true;assert(ug_minimal_port(0xb3)&&ug_minimal_port(0xbb)&&!ug_minimal_port(0x1b3));ug_minimal_write(0xb3,42,0);assert(ug_minimal_read(base+0x1b)==0xfe);ug_minimal_write(base+0x1b,0xaa,0);ug_minimal_dispatch();assert(ug_minimal_read(0xbb)==0x7e&&ug_minimal_read(base+7)==1);
 /* Every implemented non-idle owner rejects SAVE before erase, as well
  * as BASE writes; GS aliases use their narrower legacy-only gate. */
 for(unsigned owner=0;owner<6;owner++) {
  ug_minimal_init();ug_minimal_ready(owner==5?2:0,123);
  if(owner<3)ug_minimal_write(base+3,0,0);
  if(owner==1||owner==2)ug_minimal_write(base+3,0,0);
  if(owner==2)ug_minimal_dispatch();
  if(owner==3)ug_minimal_write(base+0x13,42,0);
  if(owner==4)ug_minimal_write(base+0x1b,42,0);
  assert(!ug_runtime_idle());unsigned before=mock_erases;
  ug_config_select(&ug_cfg,0xe1);ug_config_write(&ug_cfg,true,255,ug_runtime_idle());ug_maintenance_poll();
  assert(!ug_config_busy(&ug_cfg)&&ug_cfg.result==5&&mock_erases==before);
  cfgwrite(&ug_cfg,0x76,0x2a0,ug_runtime_idle());assert(ug_cfg.result==5&&s.UltraGS.basePort==base);
  if(owner<3) {
   assert(ug_runtime_gs_idle());ug_config_select(&ug_cfg,0x79);ug_config_write(&ug_cfg,true,1,ug_runtime_gs_idle());assert(!ug_cfg.result&&ug_cfg.aliases);
  }
 }
 ug_minimal_init();ug_minimal_ready(0,123);
 ug_minimal_write(base+3,0,0);ug_minimal_write(base+3,0,0);ug_minimal_write(base+2,0xa0,0);
 assert(!ug_minimal_idle()&&!(ug_minimal_read(base+1)&7));ug_minimal_dispatch();assert(ug_minimal_idle());
 /* Run the production producer/consumer on separate host threads. Check
  * each frame's CRC and session so publication errors cannot pass on flags
  * alone. CB/DB must return to idle before the next GS command is posted. */
 pthread_t worker;assert(!pthread_create(&worker,NULL,dispatch_thread,NULL));
 for(unsigned n=0;n<10000;n++) {
  ug_minimal_write(base+0x13,n,0);ug_minimal_write(base+0x1b,1,0);
  while(ug_minimal_read(base+0x1b)&1) {}
  assert(ug_minimal_read(base+0x1b)==0x7e);
  ug_minimal_write(base+3,0x80,0);ug_minimal_write(base+3,0,0);
  for(unsigned i=0;i<4;i++)ug_minimal_write(base+3,crc>>(i*8),0);
  while(!(ug_minimal_read(base+1)&4)) {}
  for(unsigned i=0;i<46;i++)reply[i]=ug_minimal_read(base+3);
  assert(!reply[0]&&reply[1]==40&&ug_get32(reply+14)==123&&ug_get32(reply+42)==ug_crc32(reply,42));
 }
 __atomic_store_n(&stop_dispatch,1,__ATOMIC_RELEASE);assert(!pthread_join(worker,NULL));
 ug_config_init(&ug_cfg,&s,8,NULL,0,0,0);ug_config_select(&ug_cfg,0xe3);assert(!ug_cfg.catalog_ok&&ug_config_read(&ug_cfg,true)==255);
 mock_watchdog.reason=2;mock_chip_reset.chip_reset=0x10100;
 for(unsigned i=0;i<8;i++)mock_watchdog.scratch[i]=100+i;
 ug_runtime_init(&s,8);
 assert(ug_raw_watchdog_reason==2&&ug_raw_chip_reset==0x10100);
 for(unsigned i=0;i<3;i++)assert(!mock_watchdog.scratch[i]);
 for(unsigned i=3;i<8;i++)assert(mock_watchdog.scratch[i]==100+i);
 /* Exercise runtime entry, rather than passing a catalogue directly to
  * ug_config_init. The physical GUS -> ULTRAGS report showed that the
  * descriptor path must also be tested after bootloader handoff. */
 for(unsigned mode=1;mode<=8;mode++) {
  if(mode==7)continue;
  getDefaultSettings(&s);
  mock_watchdog.scratch[0]=UG_HANDOFF_MAGIC;
  mock_watchdog.scratch[1]=0x01000000u|(mode<<8)|mode;
  mock_watchdog.scratch[2]=1u<<mode;
  ug_runtime_init(&s,mode);
  assert(ug_cfg.active==mode);
  ug_config_select(&ug_cfg,CMD_FW_CATALOG);
#ifdef UG_BUNDLE
  assert(ug_cfg.catalog_ok&&!ug_cfg.boot_result&&s.startupMode==mode);
  for(unsigned i=0;i<148;i++)saved[i]=ug_config_read(&ug_cfg,true);
  assert(!ug_catalog_validate(saved,true));
  assert(saved[17+(mode-1)*16]==3);
  assert(ug_config_read(&ug_cfg,true)==255);
  /* A fresh E3 starts a new snapshot even after an exhausted stream. */
  ug_config_select(&ug_cfg,CMD_MAGIC);
  ug_config_select(&ug_cfg,CMD_FW_CATALOG);
  assert(ug_config_read(&ug_cfg,true)=='U');
#else
  assert(!ug_cfg.catalog_ok&&ug_config_read(&ug_cfg,true)==255);
#endif
  for(unsigned i=0;i<3;i++)assert(!mock_watchdog.scratch[i]);
 }
 if(argc>1){FILE *f=fopen(argv[1],"wb");assert(f);assert(fwrite(cat,1,148,f)==148);fclose(f);}
 if(argc>2) {
  getDefaultSettings(&s);s.startupMode=8;
  ug_config_init(&ug_cfg,&s,8,cat,UG_HANDOFF_MAGIC,0x01000808,256);
  const unsigned cases[][4]={{0x76,0x80,2,1},{0x77,0x80,2,1},{0x77,0xa0,2,1},{0x76,0xc0,2,0},{0x76,0xc0,2,1},{3,0,7,1},{3,0,9,1},{3,0,1,1},{0x79,0,1,0},{0x79,0,1,1},{0x79,0,2,1},{0x79,0,0,1},{0x77,255,255,1},{0x76,0xe0,1,1}};
  FILE *f=fopen(argv[2],"w");assert(f);fputs("[",f);
  for(unsigned i=0;i<sizeof(cases)/sizeof(cases[0]);i++) {
   const unsigned *v=cases[i];ug_config_select(&ug_cfg,v[0]);ug_config_write(&ug_cfg,false,v[1],v[3]);ug_config_write(&ug_cfg,true,v[2],v[3]);
   fprintf(f,"%s{\"selector\":%u,\"low\":%u,\"high\":%u,\"idle\":%u,\"result\":%u,\"base\":%u,\"alias\":%u,\"desired\":%u,\"gs\":%u}",i?",":"",v[0],v[1],v[2],v[3],ug_cfg.result,s.UltraGS.basePort,s.UltraGS.bulkAlias,s.startupMode,ug_cfg.aliases);
  }
  fputs("]\n",f);fclose(f);
 }
 puts("S2 HOST PASS: resolver/fallback/vector/reset/handoff; actual Settings v5->6/save; config staging/idle/immutable snapshot; minimal transport CRC/fault/GS aliases; 10000 concurrent INFO/GS exchanges");
}
