/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <stdbool.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
void ug_minimal_init(void);
void ug_minimal_transport_fault(void);
bool ug_minimal_idle(void);
bool ug_minimal_gs_idle(void);
bool ug_minimal_port(uint16_t port);
void ug_minimal_write(uint16_t port,uint8_t value,uint32_t now);
uint8_t ug_minimal_read(uint16_t port);
void ug_minimal_dispatch(void);
void ug_minimal_poll(uint32_t now);
void ug_minimal_ready(uint8_t state,uint64_t session);
#ifdef __cplusplus
}
#endif
