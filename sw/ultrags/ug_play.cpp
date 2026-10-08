/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_config.h"
#include "ug_minimal.h"
#include "ug_audio.h"
#include "ug_psram.h"
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
void play_ultrags(void) {
    ug_hw_claim_audio(); ug_hw_claim_psram_sm();
    spi_divider=(float)clock_get_hz(clk_sys)/100000000.0f;
    uint8_t ready=0;
    if(ug_psram_init(&ps,pio1,UG_PSRAM_SM,spi_divider,8u<<20,true) ||
       ug_hw_psram_dma_check(ps.dma_tx,ps.dma_rx,ps.dma_async) || ug_psram_probe(&ps)) ready=1;
    if(ug_audio_init(pio1,UG_I2S_SM,UG_DMA_I2S0,UG_DMA_I2S1,16,17,UG_AUDIO_RATE)) ready=3;
    else { audio_up=true; ug_audio_start(); }
    ug_minimal_ready(ready,get_rand_64());
    for(;;) { ug_maintenance_poll(); ug_board_maintenance(); ug_minimal_dispatch(); tight_loop_contents(); }
}
