/* SPDX-License-Identifier: GPL-2.0-or-later
 * Executes actual front-end and actual guard with mocked SDK peripherals.
 * Register/IRQ control flow only, no claim of electrical PIO timing.
 */
#include "sdk_mock.h"
#include "hardware/structs/timer.h"
#include "ug_diag.h"
#include "ug_diag_guard.h"
#include "ug_spike.h"
#include <string.h>
#include <stdio.h>
mock_pio mock_pios[2]; s1_timer mock_timer;
uint8_t BOARD_TYPE=1;
const char *firmware_string="standalone";
static uint32_t input, verdicts[4], now;
static unsigned nv, watchdog_calls, selected_pin, function[32];
static bool pins[32], output[32], inject_alarm;
static void (*alarm_irq)(void);
void handle_iow(void); void handle_ior(void); void ug_diag_isa_reset(void);
void ug_diag_maybe_reboot(void);
void ug_diag_isa_boot(uint32_t nonce);
uint32_t pio_sm_get(PIO p, unsigned sm) {(void)p;(void)sm;return input;}
void pio_sm_put(PIO p, unsigned sm, uint32_t v) {(void)p;(void)sm;assert(nv<4);verdicts[nv++]=v;}
void pio_sm_set_enabled(PIO p,unsigned sm,bool enabled){p->enabled[sm]=enabled;}
bool gpio_get(unsigned pin){return pins[pin];}
void gpio_put(unsigned pin,bool level){pins[pin]=level;}
void gpio_set_dir(unsigned pin,bool out){output[pin]=out;}
void gpio_set_function(unsigned pin,unsigned fn){function[pin]=fn;}
void hardware_alarm_claim(unsigned n){assert(n==2);}
void irq_set_exclusive_handler(unsigned n,void (*fn)(void)){assert(n==2);alarm_irq=fn;}
void irq_set_priority(unsigned n,unsigned priority){assert(n==2&&priority==0);}
void irq_set_enabled(unsigned n,bool enabled){assert(n==2&&enabled);}
uint32_t time_us_32(void){return now++;}
void tight_loop_contents(void){
 if(inject_alarm){inject_alarm=false;mock_pios[0].irq=0;now=mock_timer.alarm[2];alarm_irq();}
}
void watchdog_reboot(unsigned a,unsigned b,unsigned c){assert(!a&&!b&&c==1);watchdog_calls++;}
uint8_t ug_spike_cmd(uint8_t cmd,uint16_t n){(void)n;return cmd>=1&&cmd<=3?0:2;}
bool ug_spike_status(ug_diag_status *s){memset(s,0,sizeof(*s));s->magic0='U';s->magic1='G';s->version=UG_DIAG_VERSION;return true;}
static bool capture_write(unsigned port, uint8_t v) {
#ifndef UG_DIAG_NO_DACK
    if (pins[19]) return false; /* mocked PIO capture gate, not an electrical claim */
#endif
    input=((port&1023)<<8)|v;nv=0;handle_iow();return true;
}
static void wr(unsigned port,uint8_t v){input=((port&1023)<<8)|v;nv=0;handle_iow();assert(nv==1||nv==2);if(nv==2)assert(verdicts[0]==0xffffffff);assert(verdicts[nv-1]==0);}
static uint8_t rd(unsigned port){input=port;nv=0;handle_ior();assert(nv==1||nv==2);if(nv==1){assert(verdicts[0]==0);return 255;}assert(verdicts[0]==0xffffffff);assert((verdicts[1]&~255u)==0xff00);return verdicts[1]&255;}
static void select_reg(uint8_t v){wr(0x1d0,v);}
static void command(uint8_t cmd){wr(UGD_BASE+1,cmd);}
static void length(unsigned len){wr(UGD_BASE+2,len);wr(UGD_BASE+3,len>>8);}
static uint32_t snap(unsigned offset){select_reg(UGD_SEL_BUS);for(unsigned i=0;i<offset;i++)rd(0x1d2);uint32_t n=0;for(unsigned i=0;i<4;i++)n|=(uint32_t)rd(0x1d2)<<(8*i);return n;}
static void delay(unsigned selector,unsigned us){select_reg(selector);wr(0x1d1,us);wr(0x1d2,us>>8);}
int main(int argc, char **argv){
 memset(pins,1,sizeof(pins));ug_diag_guard_init_core1();assert(ug_diag_guard_ready());
 ug_diag_isa_reset();
 pins[19]=true;
#ifdef UG_DIAG_NO_DACK
 assert(capture_write(0x100,7)&&nv==1);
#else
 assert(!capture_write(0x100,7));
#endif
 pins[19]=false;assert(capture_write(0x100,7)&&nv==1);
 assert(rd(0x1d2)==255);wr(0x1d0,0xcc);select_reg(0);assert(rd(0x1d2)==0xdd);
 select_reg(1);assert(rd(0x1d2)==4);select_reg(UGD_SEL_VERSION);assert(rd(0x1d2)==3);
 for(unsigned p=0;p<1024;p++)if(p!=0x1d0&&p!=0x1d1&&p!=0x1d2&&(p<UGD_BASE||p>UGD_BASE+4)){wr(p,0x55);assert(rd(p)==255);}
 ug_diag_isa_boot(0x12345678);wr(0x1d0,0xcc);assert(snap(0)==0x12345678);
 ug_diag_isa_boot(0x87654321);wr(0x1d0,0xcc);assert(snap(0)==0x87654321);
 command(UGD_RESET);
 for(unsigned block=0;block<1024;block++){
   length(1024);command(UGD_WRITE);
   for(unsigned i=0;i<1024;i++)wr(UGD_BASE,(uint8_t)(i*13+7));
   command(UGD_END);command(UGD_ECHO);
   for(unsigned i=0;i<1024;i++)assert(rd(UGD_BASE)==(uint8_t)(i*13+7));
   command(UGD_END);
 }
 assert(snap(4)==1048576&&snap(8)==1048576&&snap(12)==0&&snap(16)==2048);
 puts("PASS million pattern/echo bytes, independent counters, verdicts");
 select_reg(UGD_SEL_BUS);uint8_t frozen[28];for(unsigned i=0;i<28;i++)frozen[i]=rd(0x1d2);assert(rd(0x1d2)==255);
 select_reg(UGD_SEL_BUS);assert(rd(0x1d2)==frozen[0]);command(UGD_RESET);for(unsigned i=1;i<28;i++)assert(rd(0x1d2)==frozen[i]);
 length(1025);command(UGD_WRITE);assert(snap(12)==1);command(UGD_RESET);
 length(1);command(UGD_WRITE);wr(UGD_BASE,7);wr(UGD_BASE,20);command(UGD_END);assert(snap(12)>=2);
 command(UGD_RESET);length(2);command(UGD_WRITE);wr(UGD_BASE,20);command(UGD_END);assert(snap(12)==2); /* named lost-byte + order */
 /* Starting a new WRITE invalidates the old completed ECHO immediately. */
 command(UGD_RESET);length(2);command(UGD_WRITE);wr(UGD_BASE,7);wr(UGD_BASE,20);command(UGD_END);
 command(UGD_WRITE);wr(UGD_BASE,33);command(UGD_CANCEL);command(UGD_ECHO);assert(snap(12)==1);
 command(UGD_RESET);length(2);command(UGD_WRITE);wr(UGD_BASE,7);wr(UGD_BASE,20);command(UGD_END);
 command(UGD_WRITE);wr(UGD_BASE,33);command(UGD_END);command(UGD_ECHO);assert(snap(12)==2);
 command(UGD_RESET);length(1);command(UGD_PATTERN);assert(rd(UGD_BASE)==7);assert(rd(UGD_BASE)==255);assert(snap(12)==1);
 command(UGD_RESET);delay(UGD_SEL_ASSERT_US,100);delay(UGD_SEL_RESPONSE_US,200);
 unsigned before=now;select_reg(0);assert(rd(0x1d2)==0xdd);assert(now-before>=600);
 delay(UGD_SEL_ASSERT_US,1001);select_reg(UGD_SEL_CMD);assert(rd(0x1d1)==UGD_CMD_BAD_ARGUMENT);
 /* Independent IRQ releases bus while core0/main is not running. */
 mock_pios[0].enabled[0]=mock_pios[0].enabled[1]=true;
 for(unsigned p=6;p<16;p++)output[p]=true;
 selected_pin=argc>1&&!strcmp(argv[1],"slow-write-guard")?4:5;
 pins[selected_pin]=false;
 if(argc>2){
   inject_alarm=true;nv=0;
   if(selected_pin==4){input=(UGD_BASE+1)<<8|UGD_RESET;handle_iow();}
   else {input=0x1d2;handle_ior();}
   assert(nv==0); /* assertion failure sends no WAIT or final verdict */
 }else{
   ug_diag_guard_arm(selected_pin);
   mock_pios[0].irq=0;alarm_irq();assert(!ug_diag_guard_failed()); /* stale IRQ */
   now=mock_timer.alarm[2];
   /* Completion protects a later foreign cycle even if core0 hangs. */
   mock_pios[0].irq=1u<<(selected_pin==4?1:0);alarm_irq();assert(!ug_diag_guard_failed());
   mock_pios[0].irq=0;now=mock_timer.alarm[2];alarm_irq();
 }
 assert(ug_diag_guard_failed()&&!mock_pios[0].enabled[0]&&!mock_pios[0].enabled[1]);
 assert(!pins[26]&&!pins[27]&&function[26]==5&&function[27]==5);
 for(unsigned p=6;p<16;p++)assert(!output[p]&&function[p]==5);
 nv=0;input=(UGD_BASE+1)<<8|UGD_RESET;handle_iow();assert(nv==0);
 ug_diag_isa_reset();assert(ug_diag_guard_failed());
 nv=0;input=UGD_BASE;handle_ior();assert(nv==0);
 assert(!ug_diag_guard_delay(1));assert(!watchdog_calls);
 puts("PASS bounds/snapshot/reset/delays/foreign ports/fatal independent release");
 return 0;
}
