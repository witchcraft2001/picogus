/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "sdk_mock.h"
#include "ultrags/ug_memory.h"
#include "ultrags/ug_storage.h"
#include "ultrags/ug_minimal.h"
#include "ultrags/ug_config.h"
#include "ultrags/ug_s4.h"
#include "ultrags/ug_hwmap.h"
#include "ultrags_protocol.h"
#include <stdio.h>
#include <string.h>
void ug_storage_test_tokens(uint32_t next);
uint32_t ug_storage_test_crc_step(uint32_t crc,const uint8_t *p,unsigned n);
static Settings settings;
static ug_psram_t ps;
static unsigned checks,lastop,block_length;
static FILE *shared; static bool first=true;
static void comma(void) { if(!first)fputc(',',shared); first=false; }
static void hex(const uint8_t *p,unsigned n) { for(unsigned i=0;i<n;i++)fprintf(shared,"%02x",p[i]); }
static uint8_t r[128],q[128],bytes[1024];
#define CHECK(c) do { assert(c); checks++; } while(0)
static void send(unsigned op,unsigned n,bool crc) {
    lastop=op; uint8_t f[134]={op|(crc?128:0),n};memcpy(f+2,q,n);
    if(crc) ug_put32(f+2+n,ug_crc32(f,n+2));
    for(unsigned i=0;i<n+2+(crc?4:0);i++)ug_minimal_write(0x2a3,f[i],time_us_32());
}
static void response(unsigned e,unsigned len,bool crc) {
    unsigned limit=100000;while(!(ug_minimal_read(0x2a1)&4)&&--limit)ug_minimal_dispatch();CHECK(limit);
    uint8_t f[134];f[0]=ug_minimal_read(0x2a3);f[1]=ug_minimal_read(0x2a3);if(f[0]!=e)fprintf(stderr,"op=%u got=%u expected=%u checks=%u\n",lastop,f[0],e,checks);CHECK(f[0]==e);CHECK(f[1]==len);
    for(unsigned i=0;i<len+(crc?4:0);i++)f[i+2]=ug_minimal_read(0x2a3);
    if(crc)CHECK(ug_crc32(f,len+2)==ug_get32(f+len+2));memcpy(r,f+2,len);
}
static void rpc(unsigned op,unsigned n,unsigned e,unsigned len) {
    send(op,n,true);response(e,len,true);
    if(shared) { comma();fprintf(shared,"{\"op\":%u,\"q\":\"",op);hex(q,n);fprintf(shared,"\",\"status\":%u,\"r\":\"",e);hex(r,len);fprintf(shared,"\"}\n"); }
}
static void reset(void) { ug_minimal_write(0x2a2,0xa0,time_us_32());while(!(ug_minimal_read(0x2a1)&1))ug_minimal_dispatch();ug_minimal_dispatch(); }
static unsigned alloc(unsigned n) { q[0]=0;ug_put32(q+1,n);rpc(16,5,0,6);return r[0]|r[1]<<8; }
static void interrupt_reset(void) {
    ug_minimal_write(0x2a2,0xa0,time_us_32());
    CHECK(!(ug_minimal_read(0x2a1)&7));
    ug_minimal_write(0x2a3,16,time_us_32()); /* Must remain rejected until safe exit. */
}
static void interrupt_cancel(void) { ug_minimal_write(0x2a2,0xa1,time_us_32()); }
static void arm_cancel(void) { mock_time_hook=interrupt_cancel; }
static void obj(unsigned h) {q[0]=h;q[1]=h>>8;rpc(18,2,0,38);}
static void begin(unsigned h,unsigned off,unsigned n,bool rd,bool verify,unsigned err) {
    block_length=n;
    q[0]=h;q[1]=h>>8;ug_put32(q+2,off);q[6]=n;q[7]=n>>8;q[8]=1|(verify?128:0);
    ug_put32(q+9,ug_crc32(bytes,n<=1024?n:0));
    rpc(rd?34:32,rd?9:verify?13:9,err,err?0:rd&&verify?8:4);
}
static uint8_t pattern(unsigned off) {return off^(off>>8)^(off>>16)^0xa5;}
static void data(unsigned n,bool rd) {
    if(shared) { comma();fprintf(shared,"{\"data\":\"%s\",\"bytes\":\"",rd?"read":"write");hex(bytes,n);fprintf(shared,"\"}\n"); }
    for(unsigned i=0;i<n;i++) {
        ug_minimal_dispatch();
        if(rd) { CHECK(ug_minimal_read(0x2bb)&128);CHECK(ug_minimal_read(0x2b3)==bytes[i%1024]); }
        else { ug_minimal_write(0x2b3,bytes[i%1024],time_us_32());ug_minimal_dispatch();CHECK(!(ug_minimal_read(0x2bb)&128)); }
    }
}
static void end(unsigned token,bool rd,bool verify,unsigned err) {ug_put32(q,token);if(verify&&rd)ug_put32(q+4,ug_crc32(bytes,block_length));rpc(rd?35:33,rd&&verify?8:4,err,0);}
static unsigned timeout_interleavings;
static void timeout_race(unsigned h) {
    /* Deterministic two-core ordering: core1 captures now, core0 subsequently
     * acknowledges a grant or transfers a byte, then core1 checks that old
     * time. Exercise real framing/latches/storage, not a copied timer helper. */
    const unsigned lags[]={1,1000,10000};
    for(unsigned wrap=0;wrap<2;wrap++)for(unsigned bulk=0;bulk<2;bulk++)
    for(unsigned rd=0;rd<2;rd++)for(unsigned i=0;i<3;i++) {
        mock_now=wrap?UINT32_MAX-512:100000;
        q[0]=h;q[1]=h>>8;ug_put32(q+2,0);q[6]=16;q[7]=0;q[8]=bulk?0:1;
        rpc(rd?34:32,9,0,4);
        uint32_t ack=mock_now-1;
        ug_storage_tick(ack-lags[i]);
        CHECK(ug_storage_grant()==(rd?16:8)); /* newer BEGIN ACK */
        ug_minimal_dispatch(); /* publish read DB before consuming */
        uint32_t captured=time_us_32();mock_now+=lags[i];
        if(rd) CHECK(ug_minimal_read(bulk?0x2a0:0x2b3)==bytes[0]);
        else ug_minimal_write(bulk?0x2a0:0x2b3,bytes[0],time_us_32());
        uint32_t touched=mock_now-1;
        ug_storage_tick(captured);
        CHECK(ug_storage_grant()==(rd?16:8)); /* newer data / input latch */
        ug_storage_tick(touched+4999999);
        CHECK(ug_storage_transfer());
        ug_storage_tick(touched+5000000);
        CHECK(!ug_storage_transfer()); /* real 5s inactivity still expires */
        ug_minimal_dispatch();obj(h);CHECK(!r[4]);
        timeout_interleavings++;
    }
}
int main(int argc,char **argv) {
    mock_reset();ug_hw_claim_audio();ug_hw_claim_psram_sm();CHECK(!ug_psram_init(&ps,pio1,1,1.85,8u<<20,false));
    settings.UltraGS.basePort=0x2a0;settings.UltraGS.bulkAlias=65535;ug_config_init(&ug_cfg,&settings,8,NULL,0,0,0);
    ug_minimal_init();ug_storage_bind(&ps,123);ug_storage_publish(8u<<20,0,0);
    CHECK(ug_crc32("123456789",9)==0xcbf43926);
    const unsigned vectors[]={0,1,3,16,255,256,257,1023};
    for(unsigned i=0;i<sizeof(bytes);i++)bytes[i]=pattern(i);
    for(unsigned i=0;i<sizeof(vectors)/sizeof(*vectors);i++) {
        unsigned n=vectors[i];uint32_t crc=UINT32_MAX;
        for(unsigned j=0;j<n;) {unsigned k=n-j;if(k>17)k=17;crc=ug_storage_test_crc_step(crc,bytes+1+j,k);j+=k;}
        CHECK((crc^UINT32_MAX)==ug_crc32(bytes+1,n));
        CHECK((ug_storage_test_crc_step(UINT32_MAX,bytes+1,n)^UINT32_MAX)==ug_crc32(bytes+1,n));
    }
    /* Oversized frames and RX deadline never execute suffix ALLOC. */
    for(unsigned length=129;length<=255;length++) {
        ug_minimal_write(0x2a3,16,0);ug_minimal_write(0x2a3,length,0);
        for(unsigned i=0;i<256;i++)ug_minimal_write(0x2a3,0,0);
        CHECK(!(ug_minimal_read(0x2a1)&7));CHECK(ug_minimal_read(0x2a6)==3);reset();
    }
    ug_minimal_write(0x2a3,16,0);ug_minimal_poll(1000000);CHECK(ug_minimal_read(0x2a6)==13);reset();
    /* Every compact payload length, with and without a frame CRC, executes
     * as one complete unknown command (including a maximal 134-byte frame). */
    memset(q,0,sizeof(q));
    for(unsigned crc=0;crc<2;crc++)for(unsigned n=0;n<=128;n++) {
        send(127,n,crc);response(UG_ERR_BAD_OPCODE,0,crc);
    }
    const unsigned ro[]={1,5,6,7,8,9};
    for(unsigned i=0;i<sizeof(ro)/sizeof(*ro);i++) {
        ug_minimal_write(0x2a0+ro[i],0,time_us_32());CHECK(ug_minimal_read(0x2a6)==UG_ERR_BAD_REGISTER);
    }
    unsigned other=alloc(32),h=alloc(2048);
    for(unsigned i=0;i<1024;i++)bytes[i]=pattern(i);
    /* Keep a confirmed foreign object across all transport/fault recovery. */
    begin(other,0,32,false,false,0);
    unsigned foreign_token=ug_get32(r);data(32,false);end(foreign_token,false,false,0);
    timeout_race(other);
    /* Unsupported BULK variants refuse before issuing or pinning a grant. */
    q[0]=h;q[1]=0;ug_put32(q+2,0);q[6]=1;q[7]=0;q[8]=2;
    rpc(32,9,UG_ERR_BAD_ARGUMENT,0);CHECK(!ug_storage_transfer());
    q[8]=130;ug_put32(q+9,0);rpc(32,13,UG_ERR_BAD_ARGUMENT,0);
    CHECK(!ug_storage_transfer());obj(h);CHECK(!r[4]&&!ug_get32(r+10));
    /* Grant waits for complete BEGIN response; EXEC/REPLY reject writes. */
    q[0]=h;q[1]=0;ug_put32(q+2,0);q[6]=0;q[7]=4;q[8]=1;send(32,9,false);
    ug_minimal_write(0x2a3,0,0);CHECK(ug_minimal_read(0x2a6)==5);ug_minimal_dispatch();
    CHECK(!(ug_minimal_read(0x2a1)&24));ug_minimal_write(0x2b3,8,0);CHECK(ug_minimal_read(0x2a6)==6);
    ug_minimal_write(0x2a3,0,0);response(0,4,false);unsigned token=ug_get32(r);CHECK(token);
    CHECK(ug_minimal_read(0x2a1)&8);obj(h);CHECK(r[4]==1 && !ug_get32(r+10));
    q[0]=other;q[1]=0;rpc(18,2,UG_ERR_BUSY,0);CHECK(ug_storage_transfer());
    /* Malformed and foreign END do not close the actual grant. */
    ug_put32(q,token+1);rpc(33,4,7,0);CHECK(ug_storage_transfer());
    ug_put32(q,token);rpc(33,8,3,0);CHECK(ug_storage_transfer());
    data(1024,false);end(token,false,false,0);obj(h);CHECK(ug_get32(r+10)==1024 && !r[4]);
    /* A reset arriving inside the final PREPARING slice cannot publish READY
     * before cancellation has released the object pin. */
    q[0]=h;q[1]=0;ug_put32(q+2,0);q[6]=16;q[7]=0;q[8]=1;send(34,9,false);
    ug_minimal_dispatch();mock_psram_hook=interrupt_reset;ug_minimal_dispatch();
    CHECK(!(ug_minimal_read(0x2a1)&7));
    ug_minimal_dispatch();CHECK(ug_minimal_read(0x2a1)&1);CHECK(!ug_storage_transfer());obj(h);CHECK(!r[4]);
    /* A1 during PREPARING closes the pending READ_BEGIN instead of restarting it. */
    q[0]=h;q[1]=0;ug_put32(q+2,0);q[6]=0;q[7]=4;q[8]=1;send(34,9,false);
    ug_minimal_dispatch();ug_minimal_dispatch();ug_minimal_write(0x2a2,0xa1,time_us_32());
    response(UG_ERR_CANCELLED,0,false);CHECK(!ug_storage_transfer());obj(h);CHECK(!r[4]);
    /* A second SD before WD invalidates staging even if the count later matches. */
    begin(h,0,1,false,false,0);token=ug_get32(r);
    ug_minimal_write(0x2b3,bytes[0],time_us_32());ug_minimal_write(0x2b3,bytes[0]^1,time_us_32());
    ug_minimal_dispatch();end(token,false,false,UG_ERR_OVERFLOW);CHECK(mock_memory[32]==bytes[0]);
    begin(h,0,1,true,false,0);ug_minimal_write(0x2a2,0xa1,time_us_32());
    CHECK(!(ug_minimal_read(0x2a1)&24));CHECK(!ug_storage_read_available());
    ug_minimal_dispatch();CHECK(!ug_storage_transfer());
    /* Cancel a VERIFIED END between CRC slices, before the point of no return. */
    begin(h,0,1024,false,true,0);token=ug_get32(r);data(1024,false);
    unsigned writes=mock_write_calls;ug_put32(q,token);send(33,4,false);
    ug_minimal_dispatch();ug_minimal_dispatch();ug_minimal_write(0x2a2,0xa1,time_us_32());
    response(UG_ERR_CANCELLED,0,false);CHECK(mock_write_calls==writes);obj(h);CHECK(!r[4]);
    /* Cancellation inside the final CRC slice must win before COMMITTING. */
    begin(h,0,1,false,true,0);token=ug_get32(r);data(1,false);
    writes=mock_write_calls;ug_put32(q,token);send(33,4,false);ug_minimal_dispatch();
    mock_time_hook=arm_cancel;ug_minimal_dispatch();response(UG_ERR_CANCELLED,0,false);
    CHECK(mock_write_calls==writes);CHECK(!ug_storage_transfer());obj(h);CHECK(!r[4]);
    /* Range checks, unsupported BULK, short/extra/CRC leave PSRAM intact. */
    begin(h,1025,1,false,false,8);begin(h,UINT32_MAX,2,false,false,8);begin(h,1024,0,false,false,3);begin(h,0,1024,true,false,0);
    token=ug_get32(r);ug_put32(q,token);rpc(35,8,3,0);CHECK(ug_storage_transfer());end(token,true,false,16);
    for(unsigned test=0;test<3;test++) {
        begin(h,0,1024,false,test==2,0);token=ug_get32(r);
        if(test==2)bytes[0]^=1;
        data(test==0?1023:1024,false);
        if(test==1) {ug_minimal_write(0x2b3,8,time_us_32());ug_minimal_dispatch();}
        end(token,false,test==2,test==0?16:test==1?14:4);
        if(test==2)bytes[0]^=1;
        CHECK(!memcmp(mock_memory+32,bytes,1024));
    }
    begin(h,1024,1024,false,false,0);token=ug_get32(r);data(1024,false);
    /* Commit cancellation after one slice completes, ACK discarded. */
    ug_put32(q,token);send(33,4,false);ug_minimal_dispatch();ug_minimal_dispatch();reset();obj(h);CHECK(ug_get32(r+10)==2048 && !r[4]);
    /* SEAL cancellation leaves UPLOADING; bad expected CRC -> INVALID. */
    q[0]=h;q[1]=0;q[2]=0;ug_put32(q+3,0);send(19,7,false);ug_minimal_dispatch();ug_minimal_dispatch();reset();obj(h);CHECK(!r[3]&&!r[4]);
    q[0]=h;q[1]=0;q[2]=1;ug_put32(q+3,0);rpc(19,7,4,0);obj(h);CHECK(r[3]==2);begin(h,0,1,true,false,6);
    q[0]=h;q[1]=0;rpc(17,2,0,0);
    /* Fault during commit marks INVALID and releases pin. */
    h=alloc(16);begin(h,0,16,false,false,0);token=ug_get32(r);data(16,false);
    mock_dma_stuck=true;end(token,false,false,17);mock_dma_stuck=false;
    obj(h);CHECK(r[3]==2 && !r[4]);CHECK(!ug_psram_recover(&ps));
    q[0]=h;q[1]=0;rpc(17,2,0,0);
    /* Table CRC vector via an unaligned, partitioned upload. */
    h=alloc(9);memcpy(bytes,"123456789",9);begin(h,0,1,false,true,0);token=ug_get32(r);data(1,false);end(token,false,true,0);
    memmove(bytes,bytes+1,8);begin(h,1,8,false,true,0);token=ug_get32(r);data(8,false);end(token,false,true,0);
    q[0]=h;q[1]=0;q[2]=1;ug_put32(q+3,0xcbf43926);rpc(19,7,0,4);CHECK(ug_get32(r)==0xcbf43926);
    q[0]=h;q[1]=0;rpc(17,2,0,0);for(unsigned i=0;i<1024;i++)bytes[i]=pattern(i);
    /* Every normative length and unaligned PSRAM address; cancel timeout. */
    h=alloc(2048);begin(h,0,1024,false,false,0);token=ug_get32(r);data(1024,false);end(token,false,false,0);
    for(unsigned verify=0;verify<2;verify++)for(unsigned n=1;n<=1024;n++) {
        begin(h,0,n,false,verify,0);token=ug_get32(r);data(n,false);end(token,false,verify,0);
        begin(h,0,n,true,verify,0);token=ug_get32(r);data(n,true);end(token,true,verify,0);
        CHECK(ug_minimal_read(0x2b3)==bytes[n-1]); /* OUT latch survives END. */
    }
    /* A1 must not abort or restart a SEAL frame. */
    begin(h,1024,1024,false,false,0);token=ug_get32(r);data(1024,false);end(token,false,false,0);
    q[0]=h;q[1]=0;q[2]=0;ug_put32(q+3,0);send(19,7,false);
    ug_minimal_dispatch();ug_minimal_dispatch();ug_minimal_dispatch();
    ug_minimal_write(0x2a2,0xa1,time_us_32());
    for(unsigned i=0;i<6;i++)ug_minimal_dispatch();
    CHECK(ug_minimal_read(0x2a1)&4);response(0,4,false);obj(h);CHECK(r[3]==1&&!r[4]);
    begin(h,0,1,true,false,0);token=ug_get32(r);ug_storage_tick(time_us_32()+5000000);CHECK(!ug_storage_transfer());obj(h);CHECK(!r[4]);
    q[0]=h;q[1]=0;rpc(17,2,0,0);
    obj(other);CHECK(r[3]==0 && !r[4] && ug_get32(r+10)==32);
    for(unsigned i=0;i<32;i++)CHECK(mock_memory[i]==pattern(i));
    q[0]=other;q[1]=0;rpc(17,2,0,0);
    /* Shared commands/data fixtures from this actual C path. */
    if(argc>2) { shared=fopen(argv[2],"w");CHECK(shared);fprintf(shared,"[\n"); }
    ug_put32(q,0x55475253);q[4]=0;rpc(6,5,0,8);
    h=alloc(9);memcpy(bytes,"123456789",9);
    begin(h,0,9,false,true,0);token=ug_get32(r);ug_put32(q,token+1);rpc(33,4,7,0);
    ug_put32(q,token);rpc(33,8,3,0);data(9,false);end(token,false,true,0);
    begin(h,0,9,false,true,0);token=ug_get32(r);bytes[0]^=1;data(9,false);end(token,false,true,4);bytes[0]^=1;
    q[0]=h;q[1]=0;q[2]=1;ug_put32(q+3,0xcbf43926);rpc(19,7,0,4);
    begin(h,0,9,true,true,0);token=ug_get32(r);data(9,true);ug_put32(q,token);ug_put32(q+4,0xcbf43926);rpc(35,8,0,0);
    obj(h);q[0]=h;q[1]=0;rpc(17,2,0,0);rpc(2,0,0,20);
    if(shared) { fprintf(shared,"]\n");fclose(shared);shared=NULL; }
    /* Eight MiB actual C upload/readback/CRC continuation at upper boundary. */
    h=alloc(8u<<20);
    for(unsigned off=0;off<8u<<20;off+=1024) {
        for(unsigned i=0;i<1024;i++)bytes[i]=pattern(off+i);
        begin(h,off,1024,false,true,0);token=ug_get32(r);data(1024,false);end(token,false,true,0);
    }
    q[0]=h;q[1]=0;q[2]=1;ug_put32(q+3,ug_crc32(mock_memory,8u<<20));rpc(19,7,0,4);CHECK(ug_get32(r)==ug_crc32(mock_memory,8u<<20));
    begin(h,0,1,false,false,6);
    for(unsigned off=0;off<8u<<20;off+=1024) {
        for(unsigned i=0;i<1024;i++)bytes[i]=pattern(off+i);
        begin(h,off,1024,true,true,0);token=ug_get32(r);CHECK(ug_get32(r+4)==ug_crc32(bytes,1024));data(1024,true);end(token,true,true,0);
    }
    begin(h,0,1,true,false,0);token=ug_get32(r);bytes[0]=pattern(0);data(1,true);
    CHECK(ug_minimal_read(0x2b3)==255);end(token,true,false,14);
    ug_storage_test_tokens(UINT32_MAX);begin(h,0,1,true,false,0);token=ug_get32(r);CHECK(token==UINT32_MAX);end(token,true,false,16);
    begin(h,0,1,true,false,14);
    rpc(80,0,0,128);CHECK(r[27]==255&&!r[24]&&!ug_get32(r+120));
    ug_minimal_write(0x2a2,0xa3,0);uint8_t snapshot[128];for(unsigned i=0;i<128;i++)snapshot[i]=ug_minimal_read(0x2a5);
    CHECK(snapshot[27]==255 && snapshot[56]==127);CHECK(ug_minimal_read(0x2a4)==128);CHECK(ug_minimal_read(0x2a5)==255);
    /* A held SRAM snapshot remains byte-identical through repeated core1
     * publications. Latch/read never touches PSRAM. */
    unsigned reads=mock_read_calls;
    for(unsigned i=0;i<100;i++)ug_minimal_dispatch();
    ug_minimal_write(0x2a4,0,0);
    for(unsigned i=0;i<128;i++)CHECK(ug_minimal_read(0x2a5)==snapshot[i]);
    CHECK(mock_read_calls==reads);
    ug_stat_add(2,UINT32_MAX);rpc(3,0,0,64);CHECK(ug_get32(r+8)==UINT32_MAX);rpc(4,0,0,0);rpc(3,0,0,64);CHECK(!ug_get32(r+8));
    q[0]=h;q[1]=0;rpc(17,2,0,0);rpc(2,0,0,20);CHECK(ug_get32(r+8)==8u<<20);
    /* GS 00 cancels staging without deleting the object; F3 explicitly
     * resets the store/session, then new session tokens start at one. */
    ug_minimal_write(0x2bb,0xf3,time_us_32());ug_minimal_dispatch();ug_minimal_dispatch();
    h=alloc(16);begin(h,0,16,false,false,0);data(15,false);
    ug_minimal_write(0x2bb,0x31,time_us_32());ug_minimal_dispatch();
    CHECK(ug_minimal_read(0x2a7)==UG_ERR_BUSY);CHECK(ug_storage_transfer());
    ug_minimal_write(0x2bb,0,time_us_32());ug_minimal_dispatch();ug_minimal_dispatch();
    CHECK(!ug_storage_transfer());obj(h);CHECK(!r[4]&&!ug_get32(r+10));
    ug_minimal_write(0x2bb,0xf3,time_us_32());ug_minimal_dispatch();ug_minimal_dispatch();
    rpc(2,0,0,20);CHECK(!r[16]&&!r[17]);
    h=alloc(1);begin(h,0,1,false,false,0);CHECK(ug_get32(r)==1);
    ug_put32(q,1);rpc(36,4,0,0);q[0]=h;q[1]=0;rpc(17,2,0,0);
    h=alloc(1);begin(h,0,1,false,false,0);
    ug_minimal_write(0x2bb,0xf4,time_us_32());ug_minimal_dispatch();ug_minimal_dispatch();
    rpc(0,0,0,36);CHECK(r[7]==2);
    rpc(2,0,UG_ERR_BUSY,0); /* Must not reuse the cold-reset job as this RPC. */
    unsigned limit=100000;while(ug_storage_busy()&&--limit)ug_minimal_dispatch();CHECK(limit);
    rpc(2,0,0,20);CHECK(!r[16]&&!r[17]&&ug_get32(r+8)==8u<<20);
    if(argc>1) {FILE *f=fopen(argv[1],"w");assert(f);fprintf(f,"{\"checks\":%u,\"full_bytes\":8388608,\"timeout_interleavings\":%u,\"seal_mock_us\":%u,\"spi_slice_mock_us\":%u}\n",checks,timeout_interleavings,ug_seal_elapsed_us,ug_spi_slice_max_us);fclose(f);}
    printf("S4 actual C HOST_PASS: %u checks\n",checks);
}
