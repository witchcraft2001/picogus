/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_config.h"
#include "ug_minimal.h"
#include "ug_audio.h"
#include "ug_psram.h"
#include "ug_storage.h"
#include "ug_memory.h"
#include "../common/picogus.h"
#include "include/pg_debug.h"
#include "ug_hwmap.h"
#include "pico/rand.h"
#include "hardware/clocks.h"
#include "hardware/irq.h"
extern void ug_board_maintenance(void);
static ug_psram_t ps;
static float spi_divider;
static bool audio_up;
void ug_save_prepare(void) {
    if(!audio_up) return;
    ug_audio_set_active(false); /* Digital zero; no queued playback exists in S2. */
    irq_set_enabled(DMA_IRQ_0,false);
    dma_channel_abort(UG_DMA_I2S0); dma_channel_abort(UG_DMA_I2S1);
    pio_sm_set_enabled(pio1,UG_I2S_SM,false);
    pio_sm_clear_fifos(pio1,UG_I2S_SM);
    pio_sm_set_pins_with_mask(pio1,UG_I2S_SM,0,1u<<16);
}
void ug_save_restore(void) {
    if(!audio_up) return;
    uint32_t div=clock_get_hz(clk_sys)*4u/UG_AUDIO_RATE;
    pio_sm_set_clkdiv_int_frac(pio1,UG_I2S_SM,div>>8,div&255);
    pio_sm_set_clkdiv(pio1,UG_PSRAM_SM,spi_divider);
    dma_hw->ints0=(1u<<UG_DMA_I2S0)|(1u<<UG_DMA_I2S1);
    irq_set_enabled(DMA_IRQ_0,true);
    pio_sm_set_enabled(pio1,UG_I2S_SM,true);
    ug_audio_resume_idle();
}
/* Kept in SRAM for debugger/diagnostic evidence even in printf-free builds. */
struct ug_psram_attempt { uint32_t divider256, sck_hz, tested, first_bad; uint8_t fudge, status; };
volatile ug_psram_attempt ug_psram_attempts[2];
volatile unsigned ug_psram_attempt_count;
extern board_type_t BOARD_TYPE;
void play_ultrags(void) {
    ug_hw_claim_audio(); ug_hw_claim_psram_sm();
    spi_divider=(float)clock_get_hz(clk_sys)/(UG_PSRAM_SCK_MHZ*2000000.0f);
    uint8_t audio_error=0;
    if(ug_audio_init(pio1,UG_I2S_SM,UG_DMA_I2S0,UG_DMA_I2S1,16,17,UG_AUDIO_RATE)) audio_error=3;
    else { audio_up=true; ug_audio_start(); }
    ug_storage_bind(&ps,get_rand_64());
    ug_memory_job_t startup={};
    bool fudge=BOARD_TYPE!=PICOGUS_2, initialized=false, published=false;
    unsigned attempt=0;
    for(;;) {
        ug_maintenance_poll(); ug_board_maintenance(); ug_minimal_dispatch();
        if(!published) {
            if(!initialized) {
                initialized=true;
                int failed=ug_psram_init(&ps,pio1,UG_PSRAM_SM,spi_divider,8u<<20,fudge);
                if(!failed) failed=ug_hw_psram_dma_check(ps.dma_tx,ps.dma_rx,ps.dma_async);
                if(failed) { startup={}; startup.status=17; startup.first_bad=UINT32_MAX; }
                else ug_memory_start(&startup,&ps,true,0,time_us_32());
            } else if(startup.active) ug_memory_step(&startup,time_us_32());
            else {
                ug_psram_attempt value={ps.divider256,
                    (ps.divider256?(uint32_t)((uint64_t)clock_get_hz(clk_sys)*128/ps.divider256):0),
                    startup.tested,startup.first_bad,(uint8_t)fudge,startup.status};
                /* Field copies avoid volatile aggregate assignment. */
                ug_psram_attempts[attempt].divider256=value.divider256;
                ug_psram_attempts[attempt].sck_hz=value.sck_hz;
                ug_psram_attempts[attempt].tested=value.tested;
                ug_psram_attempts[attempt].first_bad=value.first_bad;
                ug_psram_attempts[attempt].fudge=value.fudge;
                ug_psram_attempts[attempt].status=value.status;
                ug_psram_attempt_count=attempt+1;
                DBG_PRINTF("PSRAM attempt=%u fudge=%u div256=%lu sck=%lu status=%u tested=%lu first_bad=%08lx\n",
                    attempt,(unsigned)fudge,(unsigned long)ps.divider256,
                    (unsigned long)ug_psram_attempts[attempt].sck_hz,startup.status,
                    (unsigned long)startup.tested,(unsigned long)startup.first_bad);
                if(startup.status && !attempt) {
                    ug_psram_uninit(&ps);
                    if(!pio_sm_is_claimed(pio1,UG_PSRAM_SM)) ug_hw_claim_psram_sm();
                    attempt++; fudge=!fudge; initialized=false;
                } else {
                    ug_storage_publish(startup.status?0:startup.physical,startup.status,audio_error);
                    published=true;
                    if(!startup.status) hard_assert(!ug_hw_audit(BOARD_TYPE==PICOGUS_2));
                }
            }
        }
        tight_loop_contents();
    }
}
