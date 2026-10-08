/* SPDX-License-Identifier: GPL-2.0-or-later
 * Host control-flow model only; does not claim peripheral electrical timing.
 */
#ifndef SDK_MOCK_H
#define SDK_MOCK_H
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <assert.h>
#include <pthread.h>
typedef unsigned uint;
#define __isr
#define __time_critical_func(x) x
#define hard_assert(x) assert(x)
#define NUM_DMA_CHANNELS 12
#define DMA_IRQ_0 0
#define DMA_SIZE_32 32
#define GPIO_FUNC_PIO0 0
#define GPIO_FUNC_PIO1 1
#define __dmb() __sync_synchronize()
typedef struct { uint32_t txf[4], irq; unsigned used; bool claimed[4], enabled[4]; } mock_pio;
typedef mock_pio *PIO;
extern mock_pio mock_pios[2];
#define pio0 (&mock_pios[0])
#define pio1 (&mock_pios[1])
struct pio_program { unsigned length; };
typedef struct { uint32_t ints0; } mock_dma_hw;
extern mock_dma_hw mock_dma;
#define dma_hw (&mock_dma)
typedef struct { uint chain; } dma_channel_config;
extern const uint32_t *mock_dma_src[12];
extern unsigned mock_starts[12], mock_counts[12], mock_tail_steps, mock_waits;
extern unsigned mock_read_calls, mock_write_calls, mock_async_calls, mock_max_read, mock_max_write;
extern bool mock_irq_enabled, mock_irq_disabled;
extern uint8_t mock_memory[8u<<20];
extern pthread_mutex_t *mock_last_mutex;
void mock_reset(void);
void mock_complete(unsigned channel);
void mock_hold_snapshot(void);
void mock_release_snapshot(void);
uint32_t save_and_disable_interrupts(void);
void restore_interrupts(uint32_t state);
void tight_loop_contents(void);
bool pio_can_add_program(PIO p, const struct pio_program *program);
uint pio_add_program(PIO p, const struct pio_program *program);
uint32_t pio_sm_get(PIO p, uint sm);
void pio_sm_put(PIO p, uint sm, uint32_t word);
void pio_sm_claim(PIO p, uint sm);
bool pio_sm_is_claimed(PIO p, uint sm);
void pio_sm_set_enabled(PIO p, uint sm, bool enabled);
void pio_sm_set_clkdiv_int_frac(PIO p, uint sm, uint i, uint8_t frac);
bool pio_sm_is_tx_fifo_empty(PIO p, uint sm);
uint pio_sm_get_pc(PIO p, uint sm);
uint pio_get_dreq(PIO p, uint sm, bool tx);
void dma_channel_claim(uint ch);
bool dma_channel_is_claimed(uint ch);
bool dma_channel_is_busy(uint ch);
void dma_channel_abort(uint ch);
dma_channel_config dma_channel_get_default_config(uint ch);
void channel_config_set_dreq(dma_channel_config *c, uint d);
void channel_config_set_transfer_data_size(dma_channel_config *c, uint size);
void channel_config_set_read_increment(dma_channel_config *c, bool inc);
void channel_config_set_write_increment(dma_channel_config *c, bool inc);
void channel_config_set_chain_to(dma_channel_config *c, uint ch);
void dma_channel_configure(uint ch, dma_channel_config *c, uint32_t *dst,
                           const uint32_t *src, uint n, bool start);
void dma_channel_set_read_addr(uint ch, const void *src, bool start);
void dma_channel_set_trans_count(uint ch, uint n, bool start);
void dma_channel_start(uint ch);
void dma_irqn_set_channel_enabled(uint irq, uint ch, bool enabled);
void irq_set_exclusive_handler(uint irq, void (*handler)(void));
void irq_set_priority(uint irq, uint priority);
void irq_set_enabled(uint irq, bool enabled);
void gpio_set_function(uint pin, uint fn);
bool gpio_get(uint pin);
enum { clk_sys };
uint32_t clock_get_hz(uint clk);
typedef struct { pthread_mutex_t mutex; } mutex_t;
void mutex_init(mutex_t *m);
bool mutex_try_enter(mutex_t *m, uint32_t *owner);
void mutex_enter_blocking(mutex_t *m);
void mutex_exit(mutex_t *m);
#endif
