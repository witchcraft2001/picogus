/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_posted.h"
#include "pico/stdlib.h"
#include <string.h>
volatile ug_posted_diagnostics ug_posted_diag;
static unsigned capture_offset;
static uint32_t last_service;
void ug_posted_init(unsigned offset) {
    memset((void *)&ug_posted_diag,0,sizeof(ug_posted_diag));
    capture_offset=offset; last_service=time_us_32();
    pio0->fdebug=1u << PIO_FDEBUG_RXSTALL_LSB;
}
static void maximum(volatile uint32_t *p,uint32_t n) { if(n>*p) *p=n; }
void ug_posted_check(void (*fault)(void)) {
    if(pio0->fdebug & (1u << PIO_FDEBUG_RXSTALL_LSB)) {
        /* W1C; the software transport latch survives CLEAR_ERROR/CANCEL. */
        pio0->fdebug=1u << PIO_FDEBUG_RXSTALL_LSB;
        ug_posted_diag.overflow++; fault();
    }
    maximum(&ug_posted_diag.backlog_max,pio_sm_get_rx_fifo_level(pio0,0));
}
void ug_posted_write(uint32_t word,void (*apply)(uint32_t)) {
    uint32_t start=time_us_32();
    maximum(&ug_posted_diag.service_hiatus_max_us,start-last_service);
    ug_posted_diag.in_flight=1;
    apply(word);
    ug_posted_diag.in_flight=0; ug_posted_diag.drained++;
    last_service=time_us_32();
    maximum(&ug_posted_diag.service_max_us,last_service-start);
}
void ug_posted_read_guarded(uint16_t port,bool (*owns)(uint16_t,const uint32_t *,unsigned),
                    void (*apply)(uint32_t),uint8_t (*read)(uint16_t),void (*fault)(void),
                    bool (*guard)(bool value_phase)) {
    uint32_t start=time_us_32(), words[9]; unsigned n=0;
    /* A finite FIFO plus the preceding capture. ADS is back at address before
     * PUSH; wait only for this bounded PIO capture, never for core1 or PSRAM.
     * The ISA read is already captured; no following IOW can precede it. */
    for(;;) {
        ug_posted_check(fault);
        if(!pio_sm_is_rx_fifo_empty(pio0,0)) {
            if(n==9) { fault(); ug_posted_diag.overflow++; break; }
            words[n++]=pio_sm_get(pio0,0);
            continue;
        }
        unsigned pc=pio_sm_get_pc(pio0,0)-capture_offset;
        if(pc<2 || pc>=8) break;
    }
    /* Preview only the address map, including queued PORTS. Assert read
     * handshake immediately after minimal decode, before applying payload. */
    bool own=owns(port,words,n);
    if(own && guard && !guard(false)) { fault(); return; }
    pio_sm_put(pio0,1,own?0xffffffffu:0);
    for(unsigned i=0;i<n;i++) ug_posted_write(words[i],apply);
    ug_posted_check(fault);
    maximum(&ug_posted_diag.fence_max_us,time_us_32()-start);
    ug_posted_diag.fences++;
    if(own) {
        uint8_t value=read(port);
        /* Recheck the independent fuse after obtaining the value: it can
         * fire during SRAM snapshot work as well as an injected delay. */
        if(guard && !guard(true)) { fault(); return; }
        pio_sm_put(pio0,1,0xff00u|value);
    }
}
void ug_posted_read(uint16_t port,bool (*owns)(uint16_t,const uint32_t *,unsigned),
                    void (*apply)(uint32_t),uint8_t (*read)(uint16_t),void (*fault)(void)) {
    ug_posted_read_guarded(port,owns,apply,read,fault,NULL);
}
