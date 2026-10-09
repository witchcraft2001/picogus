/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <assert.h>
#ifdef __cplusplus
extern "C" {
#endif
extern unsigned mock_prepares,mock_restores;
extern uint8_t mock_flash[0x200000];
extern unsigned mock_erases,mock_programs,mock_clock;
#define XIP_BASE ((uintptr_t)mock_flash)
#define PICO_FLASH_SIZE_BYTES 0x200000
#define FLASH_SECTOR_SIZE 4096
#define FLASH_PAGE_SIZE 256
#define VREG_VOLTAGE_1_25 1
#define clk_sys 0
#define clk_ref 1
#define clk_peri 2
#define pll_sys 0
#define CLOCKS_CLK_SYS_CTRL_SRC_VALUE_CLKSRC_CLK_SYS_AUX 0
#define CLOCKS_CLK_SYS_CTRL_AUXSRC_VALUE_CLKSRC_PLL_USB 0
#define CLOCKS_CLK_REF_CTRL_SRC_VALUE_XOSC_CLKSRC 0
#define CLOCKS_CLK_SYS_CTRL_AUXSRC_VALUE_CLKSRC_PLL_SYS 0
#define CLOCKS_CLK_PERI_CTRL_AUXSRC_VALUE_CLKSRC_PLL_USB 0
#define USB_CLK_HZ 48000000
#define XOSC_HZ 12000000
static inline int vreg_get_voltage(void){return 1;}
static inline void vreg_set_voltage(int v){(void)v;}
static inline void busy_wait_us_32(unsigned v){(void)v;}
static inline void clock_configure_undivided(int c,int a,int b,unsigned hz){(void)a;(void)b;if(c==clk_sys)mock_clock=hz;}
static inline void pll_init(int a,int b,unsigned c,int d,int e){(void)a;(void)b;(void)c;(void)d;(void)e;}
static inline void set_sys_clock_khz(unsigned c,bool b){(void)b;mock_clock=c*1000;}
static inline unsigned save_and_disable_interrupts(void){return 0;}
static inline void restore_interrupts(unsigned v){(void)v;}
static inline void stdio_flush(void){}
void flash_range_erase(uint32_t offset,size_t n);
void flash_range_program(uint32_t offset,const uint8_t *data,size_t n);
typedef int uart_inst_t;
#define uart0 ((uart_inst_t *)0)
#define PICO_DEFAULT_UART_BAUD_RATE 230400
#define PICO_DEFAULT_UART_TX_PIN 28
#define GPIO_FUNC_UART 0
static inline bool uart_is_enabled(uart_inst_t *u){(void)u;return true;}
static inline void uart_init(uart_inst_t *u,unsigned v){(void)u;(void)v;}
static inline void uart_puts(uart_inst_t *u,const char *s){(void)u;(void)s;}
static inline void gpio_set_function(unsigned a,unsigned b){(void)a;(void)b;}

#ifdef __cplusplus
}
#endif

static inline uint32_t time_us_32(void) { return 0; }
