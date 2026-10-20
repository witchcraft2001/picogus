/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "sdk_mock.h"
#include "ultrags/ug_store.h"
#include "ultrags/ug_memory.h"
#include "ultrags/ug_storage.h"
#include "ultrags/ug_minimal.h"
#include "ultrags/ug_config.h"
#include "ultrags/ug_hwmap.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
void ug_psram_dma_wait(unsigned channel);
static Settings settings;
static ug_psram_t ps;
static unsigned checks;
static FILE *fixtures;
static bool fixture_first=true;
#define CHECK(c) do { assert(c); checks++; } while(0)
static void *aliases_thread(void *unused) {
    (void)unused;
    for(unsigned i=0;i<10000;i++) ug_config_write(&ug_cfg,true,i&1,true);
    return NULL;
}
static void init(unsigned mb) {
    mock_capacity=mb<<20; mock_alias_mask=UINT32_MAX; mock_stuck_bit=-1;
    mock_dma_stuck=mock_cs_stuck=false;
    mock_id[2]=mb==1?255:mb==2?0:mb==4?0x20:0x40;
    ug_hw_claim_psram_sm(); CHECK(!ug_psram_init(&ps,pio1,1,1.85f,8u<<20,false));
    CHECK(!ug_hw_psram_dma_check(ps.dma_tx,ps.dma_rx,ps.dma_async));
}
static void job(ug_memory_job_t *j) { unsigned limit=1100000; while(j->active && --limit) ug_memory_step(j,time_us_32()); CHECK(limit); }
static void rpc(uint8_t op,const uint8_t *p,unsigned n,uint8_t status,unsigned size,uint8_t *out) {
    uint8_t q[134]={op|128,n}; memcpy(q+2,p,n); ug_put32(q+2+n,ug_crc32(q,n+2));
    for(unsigned i=0;i<n+6;i++) ug_minimal_write(0x2a3,q[i],time_us_32());
    unsigned limit=1100000; while(!(ug_minimal_read(0x2a1)&4) && --limit) ug_minimal_dispatch(); CHECK(limit);
    uint8_t r[134]; r[0]=ug_minimal_read(0x2a3); r[1]=ug_minimal_read(0x2a3);
    CHECK(r[0]==status); CHECK(r[1]==size);
    for(unsigned i=0;i<size+4;i++)r[i+2]=ug_minimal_read(0x2a3);
    CHECK(ug_get32(r+size+2)==ug_crc32(r,size+2)); if(out)memcpy(out,r+2,size);
    if(fixtures) {
        fprintf(fixtures,"%s{\"op\":%u,\"q\":\"",fixture_first?"":",",op);fixture_first=false;
        for(unsigned i=0;i<n;i++)fprintf(fixtures,"%02x",p[i]);
        fprintf(fixtures,"\",\"memoryFault\":%s,\"status\":%u,\"r\":\"",mock_stuck_bit==7?"true":"false",status);
        for(unsigned i=0;i<size;i++)fprintf(fixtures,"%02x",r[i+2]);
        fprintf(fixtures,"\"}\n");
    }
}
int main(int argc,char **argv) {
    mock_reset(); ug_hw_claim_audio();
    ug_memory_job_t j;
    for(unsigned mb=1;mb<=8;mb*=2) {
        init(mb); ug_memory_start(&j,&ps,true,0,time_us_32()); job(&j);
        CHECK(!j.status && j.physical==mb<<20 && j.first_bad==UINT32_MAX);
        ug_memory_start(&j,&ps,false,1,time_us_32()); job(&j);
        CHECK(!j.status && j.tested==15*(mb<<20));
        uint8_t b[256],r[256]; for(unsigned i=0;i<256;i++)b[i]=i;
        const unsigned tails[]={1,7,27,28,31,32,255,256};
        for(unsigned k=0;k<sizeof(tails)/sizeof(tails[0]);k++) {
            unsigned n=tails[k]; CHECK(!ug_psram_write_async(&ps,ps.pool_bytes-n,b,n));
            CHECK(!ug_psram_read(&ps,ps.pool_bytes-n,r,n)); CHECK(!memcmp(b,r,n));
        }
        CHECK(ug_psram_read(&ps,ps.pool_bytes,r,1)); CHECK(ug_psram_write(&ps,UINT32_MAX,b,2));
        ug_psram_uninit(&ps); CHECK(!pio_sm_is_claimed(pio1,1)); CHECK(!dma_channel_is_claimed(2));
    }
    init(8); mock_alias_mask=~(1u<<20); ug_memory_start(&j,&ps,true,0,0);job(&j);CHECK(j.status==17);
    mock_alias_mask=UINT32_MAX; mock_stuck_bit=3; ug_memory_start(&j,&ps,true,0,0);job(&j);CHECK(j.status==17);
    mock_stuck_bit=-1; mock_id[0]=255; ug_memory_start(&j,&ps,true,0,0);job(&j);CHECK(j.status==19); mock_id[0]=13;
    /* Legacy EID has no density hint: corrupt marker data is PSRAM, not
     * an invented unsupported capacity. The last-written marker is known
     * even before aliasing has established the physical size. */
    mock_capacity=1u<<20;mock_id[2]=255;mock_stuck_bit=7;
    ug_memory_start(&j,&ps,true,0,0);job(&j);
    CHECK(j.status==17 && j.first_bad==7u<<20 && j.expected==0xa7 && j.actual==0x27 && j.tested==1);
    mock_stuck_bit=-1;
    for(unsigned mb=1;mb<=8;mb*=2) {
        mock_capacity=mb<<20;ps.pool_bytes=8u<<20;
        ug_memory_start(&j,&ps,true,0,0);job(&j);CHECK(!j.status && j.physical==mb<<20 && j.tested==8+2*j.count);
    }
    const unsigned unsupported[]={3,5,6,7};
    for(unsigned i=0;i<4;i++) {
        mock_capacity=unsupported[i]<<20;ps.pool_bytes=8u<<20;
        ug_memory_start(&j,&ps,true,0,0);job(&j);
        CHECK(j.status==19 && j.first_bad==UINT32_MAX && j.tested==8);
    }
    mock_capacity=8u<<20;mock_id[2]=64;ps.pool_bytes=8u<<20;
    ug_memory_start(&j,&ps,true,0,0);job(&j);CHECK(!j.status);
    ug_memory_start(&j,&ps,false,1,0); ug_memory_step(&j,0);ug_memory_cancel(&j,9000);CHECK(!j.active && j.status==21);
    mock_dma_stuck=true; uint8_t b=0; CHECK(ug_psram_write(&ps,0,&b,1)); mock_dma_stuck=false;
    ug_psram_uninit(&ps); init(8); mock_cs_stuck=true;
    CHECK(ug_psram_write(&ps,0,&b,1));mock_cs_stuck=false;ug_psram_uninit(&ps);init(8);
    mock_dma_stuck=true;uint32_t before=time_us_32();ug_psram_dma_wait(2);
    CHECK(ug_psram_dma_fault && (uint32_t)(time_us_32()-before)<3000);mock_dma_stuck=false;
    CHECK(!ug_psram_recover(&ps));
    ug_store_t s;ug_object_t *o;ug_store_init(&s,8u<<20,123);
    CHECK(!ug_store_reserve(&s,0,s.pool,&o) && o->offset==0 && o->reserved==s.pool);
    CHECK(!ug_store_free(&s,o->handle));
    uint32_t free_bytes,largest;ug_store_space(&s,&free_bytes,&largest);CHECK(free_bytes==s.pool && largest==s.pool);
    CHECK(ug_store_reserve(&s,4,16,&o)==2);CHECK(ug_store_reserve(&s,0,0,&o)==3);CHECK(ug_store_reserve(&s,0,UINT32_MAX,&o)==8);
    ug_store_reset(&s);CHECK(s.session==124);
    for(unsigned i=1;i<=128;i++) { CHECK(!ug_store_reserve(&s,0,1,&o));CHECK(o->handle==i && o->offset==(i-1)*16); }
    CHECK(ug_store_reserve(&s,0,1,&o)==10);
    CHECK(!ug_store_pin(&s,1,true));CHECK(ug_store_free(&s,1)==18);CHECK(!ug_store_pin(&s,1,false));CHECK(!ug_store_free(&s,1));
    CHECK(!ug_store_free(&s,2));CHECK(!ug_store_reserve(&s,0,32,&o) && o->offset==0 && o->handle==129);
    o->pins=65535;CHECK(ug_store_pin(&s,o->handle,true)==14);o->pins=0;
    /* Total free space cannot substitute for a contiguous extent. */
    ug_store_init(&s,64,124);
    uint16_t handles[4];for(unsigned i=0;i<4;i++){CHECK(!ug_store_reserve(&s,0,16,&o));handles[i]=o->handle;}
    CHECK(!ug_store_free(&s,handles[0]));CHECK(!ug_store_free(&s,handles[2]));
    ug_store_space(&s,&free_bytes,&largest);CHECK(free_bytes==32 && largest==16);
    CHECK(ug_store_reserve(&s,0,32,&o)==9);CHECK(!ug_store_free(&s,handles[1]));
    CHECK(!ug_store_reserve(&s,0,48,&o) && o->offset==0);
    ug_store_reset(&s);for(unsigned i=1;i<=65535;i++){CHECK(!ug_store_reserve(&s,0,16,&o) && o->handle==i);CHECK(!ug_store_free(&s,i));}
    CHECK(ug_store_reserve(&s,0,16,&o)==10);ug_store_reset(&s);CHECK(!ug_store_reserve(&s,0,16,&o)&&o->handle==1);
    /* Actual dispatcher + storage + jobs + adapter; config uses actual C. */
    settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=65535;
    ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);
    ug_minimal_init();ug_storage_bind(&ps,123);uint8_t r[128],q[5]={0};
    rpc(0,q,0,0,40,r);CHECK(r[7]==2);rpc(2,q,0,5,0,r);CHECK(!ug_minimal_idle());
    ug_config_select(&ug_cfg,0xe1);ug_config_write(&ug_cfg,true,255,ug_minimal_idle());CHECK(ug_cfg.result==5 && !ug_config_busy(&ug_cfg));
    ug_storage_publish(8u<<20,0,0);rpc(1,q,0,0,44,r);CHECK(ug_get32(r)==1511 && ug_get32(r+4)==15 && (r[24]|r[25]<<8)==32);
    /* GS aliases may change during an EXT frame; CAPS crosses the cores. */
    ug_config_select(&ug_cfg,0x79);
    pthread_t aliases; CHECK(!pthread_create(&aliases,NULL,aliases_thread,NULL));
    for(unsigned i=0;i<10000;i++) {
        uint8_t len,status;
        CHECK(ug_storage_command(1,q,0,r,&len,&status,0));
        CHECK(!status && len==44 && !(ug_get32(r)&~2031u));
    }
    CHECK(!pthread_join(aliases,NULL));ug_config_write(&ug_cfg,true,0,true);
    rpc(2,q,0,0,20,r);CHECK(ug_get32(r+4)==8u<<20);
    ug_put32(q+1,8u<<20);rpc(16,q,5,0,6,r);CHECK(r[0]==1 && ug_get32(r+2)==8u<<20);
    mock_memory[0]=0x12;mock_memory[(8u<<20)-1]=0x34;
    q[0]=0;rpc(5,q,1,5,0,r);q[0]=1;rpc(5,q,1,5,0,r);
    CHECK(mock_memory[0]==0x12 && mock_memory[(8u<<20)-1]==0x34);
    q[0]=1;q[1]=0;rpc(18,q,2,0,38,r);CHECK(r[2]==0 && ug_get32(r+6)==8u<<20);
    q[0]=0;rpc(21,q,2,0,2,r);CHECK(r[0]==1);q[0]=1;rpc(17,q,2,0,0,r);
    q[0]=0;rpc(5,q,1,0,14,r);CHECK(ug_get32(r+4)==UINT32_MAX);
    mock_stuck_bit=0;rpc(5,q,1,17,14,r);CHECK(ug_get32(r+4)!=UINT32_MAX);
    ug_put32(q+1,16);rpc(16,q,5,17,0,r);
    /* Cancel FULL preserves preexisting failure and drops stale reply. */
    ug_minimal_write(0x2a3,5,0);ug_minimal_write(0x2a3,1,0);ug_minimal_write(0x2a3,1,0);ug_minimal_dispatch();
    CHECK(ug_storage_busy());ug_minimal_write(0x2a2,0xa0,0);ug_minimal_dispatch();CHECK(ug_minimal_read(0x2a1)&1);
    rpc(16,q,5,17,0,r);mock_stuck_bit=-1;q[0]=0;rpc(5,q,1,0,14,r);
    ug_put32(q+1,16);rpc(16,q,5,0,6,r);
    ug_cfg.aliases=true;
    ug_put32(q,0x55475253);q[4]=0;rpc(6,q,5,0,8,r);CHECK(ug_get32(r)==124);CHECK(ug_cfg.aliases && settings.UltraGS.basePort==0x2a0);
    q[4]=1;mock_stuck_bit=0;rpc(6,q,5,17,0,r);rpc(0,q,0,0,40,r);CHECK(ug_get32(r+12)==125 && r[7]==1);mock_stuck_bit=-1;
    q[0]=0;rpc(5,q,1,0,14,r);rpc(127,q,0,1,0,r);rpc(16,q,4,3,0,r);
    /* Retry after a DMA fault and after a failed startup without reboot. */
    mock_dma_stuck=true;q[0]=0;rpc(5,q,1,17,14,r);mock_dma_stuck=false;
    rpc(5,q,1,0,14,r);rpc(0,q,0,0,40,r);CHECK(!r[7]);
    ug_storage_publish(0,17,0);q[0]=0;rpc(5,q,1,0,14,r);
    rpc(2,q,0,0,20,r);CHECK(ug_get32(r+4)==8u<<20);
    q[0]=0;rpc(5,q,1,0,14,r);uint32_t quick_tested=ug_get32(r);
    /* A failed initializer has no adapter: retain PSRAM diagnostics shape. */
    ug_storage_bind(NULL,123);ug_storage_publish(0,17,0);
    q[0]=0;rpc(5,q,1,17,14,r);CHECK(!ug_get32(r) && ug_get32(r+4)==UINT32_MAX);
    q[0]=1;rpc(5,q,1,17,14,r);
    ug_storage_bind(&ps,123);ug_storage_publish(8u<<20,0,0);
    /* Refuse SAVE and port changes throughout a runtime FULL. */
    ug_minimal_write(0x2a3,5,0);ug_minimal_write(0x2a3,1,0);ug_minimal_write(0x2a3,1,0);ug_minimal_dispatch();
    ug_config_select(&ug_cfg,0xe1);ug_config_write(&ug_cfg,true,255,ug_minimal_idle());
    CHECK(ug_cfg.result==5 && !ug_config_busy(&ug_cfg));
    ug_config_select(&ug_cfg,0x76);ug_config_write(&ug_cfg,false,0x80,false);ug_config_write(&ug_cfg,true,2,ug_minimal_idle());
    CHECK(ug_cfg.result==5 && settings.UltraGS.basePort==0x2a0);
    ug_minimal_write(0x2a2,0xa0,0);ug_minimal_dispatch();CHECK(!ug_storage_busy());
    /* Bad frame CRC must not reserve an object. */
    const uint8_t invalid[]={0x90,5,0,16,0,0,0,0,0,0,0};
    for(unsigned i=0;i<sizeof(invalid);i++)ug_minimal_write(0x2a3,invalid[i],0);
    ug_minimal_dispatch();CHECK(ug_minimal_read(0x2a3)==4);CHECK(ug_minimal_read(0x2a3)==0);
    for(unsigned i=0;i<4;i++)(void)ug_minimal_read(0x2a3);
    rpc(2,q,0,0,20,r);CHECK(!r[16] && !r[17]);
    /* Both successful and refused command fixtures from this exact C path. */
    if(argc>2) { fixtures=fopen(argv[2],"w");assert(fixtures);fprintf(fixtures,"[\n"); }
    ug_cfg.aliases=false;
    ug_storage_bind(&ps,123);ug_storage_publish(8u<<20,0,0);
    rpc(1,q,0,0,44,r);rpc(2,q,0,0,20,r);
    q[0]=0;ug_put32(q+1,17);rpc(16,q,5,0,6,r);
    q[0]=1;ug_put32(q+1,31);rpc(16,q,5,0,6,r);
    q[0]=0;q[1]=0;rpc(21,q,2,0,2,r);
    q[0]=1;rpc(18,q,2,0,38,r);rpc(2,q,0,0,20,r);
    q[0]=0;rpc(5,q,1,5,0,r);q[0]=1;rpc(17,q,2,0,0,r);rpc(17,q,2,7,0,r);
    rpc(2,q,0,0,20,r);ug_put32(q,0x55475253);q[4]=0;rpc(6,q,5,0,8,r);
    rpc(2,q,0,0,20,r);q[0]=0;rpc(21,q,2,0,2,r);rpc(127,q,0,1,0,r);
    q[0]=1;rpc(5,q,1,0,14,r);CHECK(ug_get32(r)==15*(8u<<20));
    /* Shared recovery fixtures: WARM/cancellation cannot erase a fault. */
    mock_stuck_bit=7;q[0]=1;rpc(5,q,1,17,14,r);
    CHECK(ug_get32(r)==(8u<<20)+1 && !ug_get32(r+4) && r[8]==255 && r[9]==127);
    q[0]=0;rpc(5,q,1,17,14,r);
    ug_put32(q+1,16);rpc(16,q,5,17,0,r);
    ug_put32(q,0x55475253);q[4]=0;rpc(6,q,5,0,8,r);
    q[0]=0;ug_put32(q+1,16);rpc(16,q,5,17,0,r);
    mock_stuck_bit=-1;q[0]=0;rpc(5,q,1,0,14,r);
    ug_put32(q+1,16);rpc(16,q,5,0,6,r);
    if(fixtures) { fprintf(fixtures,"]\n");fclose(fixtures);fixtures=NULL; }
    if(argc>1) { FILE *f=fopen(argv[1],"w");assert(f);fprintf(f,"{\"checks\":%u,\"pool\":8388608,\"full_tested\":125829120,\"quick_tested\":%u,\"first_bad\":4294967295}\n",checks,quick_tested);fclose(f); }
    printf("S3 actual C HOST_PASS: %u checks; 1/2/4/8 MiB, FULL, faults, handles, dispatcher, cancellation\n",checks);
}
