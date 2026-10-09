/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <stdint.h>
#include <stdbool.h>
typedef struct { uint32_t fdebug; } pio_hw;
typedef pio_hw *PIO;
extern pio_hw mock_pio;
#define pio0 (&mock_pio)
#define PIO_FDEBUG_RXSTALL_LSB 0
unsigned pio_sm_get_rx_fifo_level(PIO,unsigned);
bool pio_sm_is_rx_fifo_empty(PIO,unsigned);
unsigned pio_sm_get_pc(PIO,unsigned);
uint32_t pio_sm_get(PIO,unsigned);
void pio_sm_put(PIO,unsigned,uint32_t);
