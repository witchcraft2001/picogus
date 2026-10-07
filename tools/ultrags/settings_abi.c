/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation; either version 2 of the License, or
 *  (at your option) any later version.
 *
 *  ARM ABI measurement of `struct Settings` for the S0a budget.
 *  Compiled for armv6-m with the same -mcpu/-mthumb flags as firmware;
 *  each metric becomes a symbol whose *size* equals the value -- read
 *  out with `nm -S`. Bitfield members cannot be addressed via offsetof;
 *  the containing anonymous sub-struct's offset+size is published
 *  instead (documented limitation of this method).
 *
 *  Not linked into firmware -- object file only.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "system/flash_settings.h"   /* the real struct, no copy */

/* off_* symbols are emitted as offsetof+1 (a size-0 array is
 * impossible); subtract 1 when reading. All other symbols are raw.
 *
 * prospective Ultra GS tail: 4 bytes appended, legacy offsets kept */
struct UgTail { Settings s; struct { uint16_t basePort; uint16_t bulkAlias; } ug_tail; };

#define SYM(name, expr) char ug_abi_##name[(expr) > 0 ? (expr) : 1]

SYM(sizeof_settings,   sizeof(Settings));
SYM(off_magic,offsetof(Settings, magic) + 1);
SYM(off_version,offsetof(Settings, version) + 1);
SYM(off_startupMode,offsetof(Settings, startupMode) + 1);
SYM(off_Global,offsetof(Settings, Global) + 1);
SYM(off_Joy,offsetof(Settings, Joy) + 1);
SYM(off_GUS,offsetof(Settings, GUS) + 1);
SYM(off_SB,offsetof(Settings, SB) + 1);
SYM(off_MPU,offsetof(Settings, MPU) + 1);
SYM(off_CMS,offsetof(Settings, CMS) + 1);
SYM(off_Tandy,offsetof(Settings, Tandy) + 1);
SYM(off_Mouse,offsetof(Settings, Mouse) + 1);
SYM(off_NE2K,offsetof(Settings, NE2K) + 1);
SYM(off_WiFi,offsetof(Settings, WiFi) + 1);
SYM(off_CD,offsetof(Settings, CD) + 1);
SYM(off_MMB,offsetof(Settings, MMB) + 1);
SYM(off_Volume,offsetof(Settings, Volume) + 1);
SYM(off_SB16,offsetof(Settings, SB16) + 1);
SYM(sz_GUS,            sizeof(((Settings *)0)->GUS));   /* bitfield inside */
SYM(sz_SB,             sizeof(((Settings *)0)->SB));
SYM(sz_MPU,            sizeof(((Settings *)0)->MPU));
SYM(sz_CD,             sizeof(((Settings *)0)->CD));
SYM(sz_SB16,           sizeof(((Settings *)0)->SB16));
SYM(off_ug_tail,offsetof(struct UgTail, ug_tail) + 1); /* append point */
SYM(sizeof_ugtail,     sizeof(struct UgTail));
SYM(page_headroom,     256 - (int)sizeof(Settings)); /* FLASH_PAGE_SIZE 256 */

SYM(settings_version, SETTINGS_VERSION);
_Static_assert(sizeof(Settings) < 256, "Settings exceeds Flash page");
_Static_assert(offsetof(struct UgTail, ug_tail) == sizeof(Settings), "tail shifted legacy layout");
