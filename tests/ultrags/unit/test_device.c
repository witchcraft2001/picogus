/* SPDX-License-Identifier: GPL-2.0-or-later
 * Real audio/PSRAM/mailbox code against peripheral control-flow mocks.
 * Electrical timing, FIFO pacing and real DMA latency require S1 REAL.
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <pthread.h>
#include "ug_audio.h"
#include "ug_psram.h"
#include "ug_hwmap.h"
#include "ug_diag_link.h"
#include "sdk_mock.h"

static void test_audio(void) {
    ug_hw_claim_isa();
    ug_hw_claim_audio();
    assert(ug_audio_init(pio1, 3, 0, 1, 16, 17, 48000) == 0);
    int ids[3];
    for (unsigned i = 0; i < 3; i++) {
        ids[i] = ug_audio_buf_get();
        assert(ids[i] >= 0);
        ug_audio_buf_ptr(ids[i])[0] = 0x12340000u + i;
        ug_audio_buf_push(ids[i]);
    }
    assert(ug_audio_buf_get() == -1);
    ug_audio_start();
    assert(pio1->enabled[3] && mock_starts[0] == 1);
    assert(mock_dma_src[0] == ug_audio_buf_ptr(ids[0]));
    ug_audio_start();
    assert(mock_starts[0] == 1);
    mock_complete(0);
    assert(mock_dma_src[0] == ug_audio_buf_ptr(ids[1]));
    assert(ug_audio_buf_get() == ids[0]);
    assert(ug_audio_buf_get() == -1); /* get reserves immediately. */
    ug_audio_buf_push(ids[0]);
    mock_complete(1);
    assert(mock_dma_src[1] == ug_audio_buf_ptr(ids[2]));
    ug_audio_set_active(false);
    assert(ug_audio_bufs_pending() == 2); /* Retain DMA-owned buffers on STOP. */
    mock_complete(0); mock_complete(1);
    assert(ug_audio_bufs_pending() == 0);
    assert(ug_audio_get_stats()->underruns == 0);
    ug_audio_set_active(true); mock_complete(0);
    assert(ug_audio_get_stats()->underruns == 1);
    ug_audio_finish(); mock_complete(1);
    assert(ug_audio_get_stats()->underruns == 1); /* Expected EOF silence. */
    assert(ug_audio_pack_frame(-1234, 5678) == 0xfb2e162eu);
    assert(!mock_irq_disabled);
    puts("audio: full queue, ownership, continuous SM, STOP/EOF, LR packing PASS");
}
static void test_psram(void) {
    ug_psram_t ps;
    ug_hw_claim_psram_sm();
    assert(ug_psram_init(&ps, pio1, 1, 1.85f, 8u << 20, false) == 0);
    assert(ug_hw_psram_dma_check(ps.dma_tx, ps.dma_rx, ps.dma_async) == 0);
    assert(ug_hw_audit(false) == 0);
    uint8_t data[256], rb[256];
    for (unsigned i = 0; i < sizeof(data); i++) data[i] = (uint8_t)i;
    assert(ug_psram_write(&ps, (8u << 20) - 256, data, 256) == 0);
    assert(mock_write_calls == 10 && mock_max_write == 27 && mock_tail_steps == 0);
    assert(ug_psram_read(&ps, (8u << 20) - 256, rb, 256) == 0);
    assert(mock_read_calls == 9 && mock_max_read == 31 && !memcmp(data, rb, 256));
    assert(ug_psram_read(&ps, UINT32_MAX, rb, 1) != 0);
    assert(ug_psram_read(&ps, 0, rb, 257) != 0);
    assert(ug_psram_write(&ps, (8u << 20) - 1, data, 2) != 0);
    assert(ug_psram_write_async(&ps, 0x400001u, data, 256) == 0);
    assert(mock_async_calls == 10 && mock_tail_steps == 0 && mock_waits > 0);
    assert(ug_psram_read(&ps, 0x400001u, rb, 256) == 0 && !memcmp(data, rb, 256));
    ug_psram_uninit(&ps);
    assert(!pio1->enabled[1] && !pio_sm_is_claimed(pio1, 1));
    ug_hw_claim_psram_sm();
    assert(ug_psram_init(&ps, pio1, 1, 1.85f, 8u << 20, true) == 0);
    assert(ug_hw_psram_dma_check(ps.dma_tx, ps.dma_rx, ps.dma_async) == 0);
    assert(ug_hw_audit(false) == 0);
    assert(ug_hw_pio_used(pio1) == ((1u << 18) - 1u)); /* I2S8 + fudge10. */
    dma_channel_claim(6);
    assert(ug_hw_audit(false) != 0);
    puts("PSRAM: bounds, chunks, final SPI tail, normal/fudge lifecycle PASS");
}
static void *publish_thread(void *unused) {
    (void)unused;
    ug_diag_status status = {0};
    for (unsigned i = 1; i <= 10000; i++) {
        status.quanta = i; status.frames = i * 128;
        ug_diag_link_publish(&status);
    }
    return NULL;
}
static void test_mailbox(void) {
    ug_diag_link_init();
    assert(ug_diag_link_send(1, 1234));
    assert(!ug_diag_link_send(2, 5678));
    uint8_t cmd = 0; uint16_t arg = 0;
    assert(ug_diag_link_take(&cmd, &arg) && cmd == 1 && arg == 1234);
    assert(!ug_diag_link_take(&cmd, &arg));
    ug_diag_status status = {.quanta = 7, .frames = 896}, read;
    ug_diag_link_publish(&status);
    assert(ug_diag_link_snapshot(&read) && read.frames == 896);
    mock_hold_snapshot();
    assert(!ug_diag_link_send(3, 0));
    assert(!ug_diag_link_snapshot(&read) && read.frames == 896);
    mock_release_snapshot();
    pthread_t writer;
    assert(pthread_create(&writer, NULL, publish_thread, NULL) == 0);
    for (unsigned i = 0; i < 20000; i++)
        if (ug_diag_link_snapshot(&read)) assert(read.frames == read.quanta * 128);
    assert(pthread_join(writer, NULL) == 0);
    puts("mailbox: no overwrite, bounded contention, coherent concurrent snapshots PASS");
}
int main(void) {
    mock_reset(); test_audio(); test_psram(); test_mailbox();
    puts("DEVICE CONTROL-FLOW TESTS PASSED (HOST)");
    return 0;
}
