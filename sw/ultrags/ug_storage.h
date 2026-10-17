/* SPDX-License-Identifier: GPL-2.0-or-later */
#pragma once
#include <stdint.h>
#include <stdbool.h>
typedef struct ug_psram_s ug_psram_t;
#ifdef __cplusplus
extern "C" {
#endif
void ug_storage_bind(ug_psram_t *ps,uint64_t session);
void ug_storage_publish(uint32_t physical,uint8_t error,uint8_t audio_error);
bool ug_storage_busy(void);
/* Atomic maintenance gate; includes paused and accepted pending instances. */
bool ug_storage_playback_busy(void);
void ug_storage_cancel(uint32_t now);
/* Returns false while the one asynchronous command is still executing. */
bool ug_storage_command(uint8_t op,const uint8_t *request,uint8_t size,
                        uint8_t *response,uint8_t *length,uint8_t *status,uint32_t now);
/* Core1 only: render one complete output quantum into interleaved S16 stereo. */
bool ug_storage_render(int16_t *out,uint32_t frames);
void ug_storage_main_volume(uint8_t percent);
#ifdef __cplusplus
}
#endif
