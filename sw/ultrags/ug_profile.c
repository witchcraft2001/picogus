/* SPDX-License-Identifier: GPL-2.0-or-later
 * Ultra GS S0a synthetic fixtures. Long spans force recurring cache fills;
 * short loops and multi-turn pitches exercise the same renderer separately.
 */
#include "ug_profile.h"

#define SRC_BASE 0x101u
#define SRC_LEN 1024u
#define FX_BASE 0x110001u
#define FX_LEN 1024u
#define STRIDE 0x2000u

static int fill(ug_mem_if mem, uint32_t off, uint32_t bytes, unsigned seed) {
    uint8_t b[256], rb[256];
    if (!mem.write || !mem.read || off > mem.size || bytes > mem.size - off)
        return -1;
    for (uint32_t done = 0; done < bytes; done += sizeof(b)) {
        uint32_t n = bytes - done;
        if (n > sizeof(b)) n = sizeof(b);
        for (uint32_t j = 0; j < n; j++)
            b[j] = (uint8_t)((done + j) * 37u + seed);
        if (mem.write(mem.ctx, off + done, b, n) ||
            mem.read(mem.ctx, off + done, rb, n) || memcmp(b, rb, n))
            return -1;
    }
    return 0;
}

int ug_profile_load(ug_mem_if mem) {
    for (unsigned i = 0; i < 8; i++)
        if (fill(mem, SRC_BASE + i * STRIDE, SRC_LEN, i * 13u)) return -1;
    /* Each source also fits a full interleaved stereo fixture for profile B. */
    for (unsigned i = 0; i < 4; i++)
        if (fill(mem, FX_BASE + i * STRIDE, FX_LEN * 4u, i * 29u)) return -1;
    return 0;
}

int ug_profile_setup(ug_mixer *m, ug_mem_if mem, unsigned profile) {
    if (!m || (profile != 1 && profile != 2)) return -1;
    ug_mixer_init(m, mem);
    static const uint64_t steps[8] = {
        0x180000000ull, 0x280000000ull, 0x400000000ull, 0x555555555ull,
        0x700000000ull, 0xc00000000ull, 0x1340000000ull, 0x2000000000ull
    };
    static const uint8_t pans[8] = {0, 40, 85, 128, 170, 215, 255, 128};
    for (unsigned i = 0; i < 8; i++) {
        /* Two tiny loops; six voices traverse > two cache lines repeatedly. */
        uint32_t start = i < 2 ? 254u : 8u;
        uint32_t end = i < 2 ? start + i + 2u : SRC_LEN - 8u;
        if (ug_lane_set(m, i, SRC_BASE + i * STRIDE, SRC_LEN, start, end,
                        steps[i], 56, pans[i], UG_FMT_S8, UG_LANE_MONO, 1, 0))
            return -1;
    }
    for (unsigned i = 0; i < 4; i++) {
        unsigned ch = i & 1u;
        uint32_t off = FX_BASE + (profile == 1 ? i : i / 2u) * STRIDE;
        if (ug_lane_set(m, 8 + i, off, FX_LEN, 0, FX_LEN,
                        profile == 1 ? 3ull << 32 : 0x280000000ull,
                        60, (uint8_t)(64 + i * 32), UG_FMT_S16LE,
                        profile == 1 ? UG_LANE_MONO :
                            (ch ? UG_LANE_RIGHT : UG_LANE_LEFT),
                        1, profile == 1 ? 0 : ch))
            return -1;
    }
    return 0;
}
