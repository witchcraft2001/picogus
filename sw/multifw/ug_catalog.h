/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 * Byte-oriented UGCF resolver, shared by bootloader, runtime and HOST tests.
 */
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
#define UG_CATALOG_OFFSET 0x7c00u
#define UG_CATALOG_SIZE 148u
#define UG_IMAGE_START 0x8000u
#define UG_SETTINGS_OFFSET 0x1ff000u
#define UG_HANDOFF_MAGIC 0x42534755u

typedef struct { uint32_t offset, length, crc; } ug_image;
typedef struct {
    uint32_t requested, verified;
    uint8_t active, result;
    ug_image image;
    bool safe;
} ug_boot;
uint32_t ug_crc32(const void *data, size_t length);
uint32_t ug_get32(const uint8_t *p);
void ug_put32(uint8_t *p, uint32_t v);
uint8_t ug_catalog_validate(const uint8_t *catalog, bool runtime);
uint8_t ug_catalog_resolve(const uint8_t *catalog, uint32_t mode, ug_image *out);
uint8_t ug_image_validate(const uint8_t *flash, size_t size, const ug_image *image);
ug_boot ug_boot_select(const uint8_t *flash, size_t size, const ug_image *recovery,
                      bool watchdog, uint32_t *request, uint8_t persisted, bool settings_valid);
bool ug_handoff(uint32_t magic, uint32_t packed, uint32_t verified, uint8_t active,
                uint8_t *result, uint32_t *checked);
#ifdef __cplusplus
}
#endif
