/* SPDX-License-Identifier: GPL-2.0-or-later
 * Ultra GS S0a synthetic profiles shared by the host and diagnostic.
 * Spec: ultra-gs-docs/ultra-gs.md §15 S0a; no production wire ABI.
 */
#ifndef UG_PROFILE_H
#define UG_PROFILE_H
#include "ug_render.h"
int ug_profile_load(ug_mem_if mem);
int ug_profile_setup(ug_mixer *m, ug_mem_if mem, unsigned profile);
#endif
