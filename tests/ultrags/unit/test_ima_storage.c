/* SPDX-License-Identifier: GPL-2.0-or-later */
/* WAV IMA ADPCM through the production command path: ALLOC, BULK upload,
 * SEAL, OBJECT_INFO, PLAY_PCM and PLAY_FX. Each playback of an ADPCM object
 * is compared with the same commands on a PCM WAV holding ffmpeg's decode of
 * that file (tools/ultrags/gen-adpcm.py); outputs must be identical. */
#include "sdk_mock.h"
#include "ug_storage.h"
#include "ug_minimal.h"
#include "ug_config.h"
#include "ug_hwmap.h"
#include "ug_psram.h"
#include "ug_s4.h"
#include "ultrags_protocol.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
extern void ug_hw_test_reset(void);
void ug_storage_grant_ack(uint32_t now);
uint8_t ug_storage_data_write(uint8_t byte, uint32_t now);
static Settings settings;
static ug_psram_t ps;
static uint8_t r[128], len, status;
static uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static void put16(uint8_t *p, uint16_t n) { p[0] = (uint8_t)n; p[1] = (uint8_t)(n >> 8); }
static uint8_t call(uint8_t op, const void *q, unsigned n) {
    unsigned limit = 100000;
    while (!ug_storage_command(op, q, n, r, &len, &status, time_us_32())) {
        int16_t idle[256]; assert(limit--); (void)idle;
    }
    return status;
}
static void init(void) {
    mock_reset(); ug_hw_test_reset(); ug_hw_claim_audio(); ug_hw_claim_psram_sm();
    assert(!ug_psram_init(&ps, pio1, 1, 1.85f, 8u << 20, false));
    memset(&settings, 0, sizeof(settings)); settings.Volume.mainVol = 100;
    settings.UltraGS.basePort = 0x2a0; settings.UltraGS.bulkAlias = 65535;
    ug_config_init(&ug_cfg, &settings, 8, NULL, 0, 0, 0); ug_minimal_init();
    ug_storage_bind(&ps, 321); ug_storage_publish(8u << 20, 0, 0); ug_storage_main_volume(100);
}
static uint8_t *load(const char *dir, const char *name, uint32_t *size) {
    char path[512]; snprintf(path, sizeof(path), "%s/%s", dir, name);
    FILE *f = fopen(path, "rb"); assert(f);
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *b = malloc((size_t)n); assert(b && fread(b, 1, (size_t)n, f) == (size_t)n); fclose(f);
    *size = (uint32_t)n; return b;
}
static uint16_t upload(const uint8_t *data, uint32_t size) {
    uint8_t a[5] = {2, (uint8_t)size, (uint8_t)(size >> 8), (uint8_t)(size >> 16), (uint8_t)(size >> 24)};
    assert(!call(UG_OP_ALLOC, a, 5) && len == 6);
    uint16_t h = get16(r);
    for (uint32_t offset = 0; offset < size;) {
        uint16_t count = (uint16_t)(size - offset > 1024 ? 1024 : size - offset);
        uint8_t q[9] = {0}; put16(q, h); ug_put32(q + 2, offset); put16(q + 6, count);
        assert(!call(UG_OP_WRITE_BEGIN, q, 9) && len == 4);
        uint32_t token = ug_get32(r); ug_storage_grant_ack(time_us_32());
        for (unsigned i = 0; i < count; i++) assert(ug_storage_data_write(data[offset + i], time_us_32()) == 0);
        uint8_t e[4]; ug_put32(e, token); assert(!call(UG_OP_WRITE_END, e, 4) && len == 0);
        offset += count;
    }
    return h;
}
static uint8_t seal(uint16_t h) { uint8_t q[7] = {0}; put16(q, h); return call(UG_OP_SEAL, q, 7); }
static void info(uint16_t h) { uint8_t q[2]; put16(q, h); assert(!call(UG_OP_OBJECT_INFO, q, 2) && len == 38); }

enum { QUANTA = 720 }; /* 1.92 s: every case plays twice through its end */
static int16_t out_a[QUANTA * 256], out_b[QUANTA * 256];
static void render(int16_t *out) { for (unsigned i = 0; i < QUANTA; i++) ug_storage_render(out + 256 * i, 128); }
static void silence(void) {
    uint8_t stop[3] = {0, 0, 0}; assert(!call(UG_OP_CONTROL, stop, 3) || status == UG_ERR_STATE);
    uint8_t all[2] = {0, 0}; assert(!call(UG_OP_STOP_FX, all, 2));
    int16_t tmp[256]; for (unsigned i = 0; i < 4; i++) ug_storage_render(tmp, 128);
}
static void play_pcm(uint16_t h, uint16_t repeats, uint8_t gain, uint8_t pan, int16_t *out) {
    uint8_t q[6]; put16(q, h); put16(q + 2, repeats); q[4] = gain; q[5] = pan;
    assert(!call(UG_OP_PLAY_PCM, q, 6) && len == 2);
    render(out); silence();
}
static void play_fx(uint16_t h, uint8_t gain, uint8_t pan, uint8_t flags, int16_t *out) {
    uint8_t q[8] = {0}; put16(q, h); put16(q + 2, UINT16_MAX); q[4] = 128; q[5] = gain; q[6] = pan; q[7] = flags;
    assert(!call(UG_OP_PLAY_FX, q, 8) && len == 4);
    render(out); silence();
}
static void same(const char *what) {
    unsigned nonzero = 0;
    for (unsigned i = 0; i < QUANTA * 256; i++) {
        if (out_a[i] != out_b[i]) { fprintf(stderr, "%s: sample %u ima %d pcm %d\n", what, i, out_a[i], out_b[i]); exit(1); }
        nonzero += out_a[i] != 0;
    }
    assert(nonzero > 1000);
}

int main(int argc, char **argv) {
    assert(argc == 2);
    init();
    assert(!call(UG_OP_CAPS, NULL, 0) && len == 44);
    assert(ug_get32(r + 4) & 256u); /* formats bit8: WAV IMA ADPCM */
    static const char *cases[][2] = {{"m11k.wav", "m11k.pcm.wav"}, {"s22k.wav", "s22k.pcm.wav"},
                                     {"s48k.wav", "s48k.pcm.wav"}};
    for (unsigned c = 0; c < 3; c++) {
        uint32_t isz, psz;
        uint8_t *iw = load(argv[1], cases[c][0], &isz), *pw = load(argv[1], cases[c][1], &psz);
        uint16_t hi = upload(iw, isz), hp = upload(pw, psz);
        assert(!seal(hi) && !seal(hp));
        info(hi);
        uint32_t frames = ug_get32(r + 30), rate = ug_get32(r + 26);
        uint8_t channels = r[34];
        assert(r[2] == 2 && r[3] == 1 && r[35] == 4 && r[36] == 3 && ug_get32(r + 14) != 0);
        info(hp);
        assert(ug_get32(r + 30) == frames && ug_get32(r + 26) == rate && r[34] == channels && r[35] == 16 && r[36] == 2);
        play_pcm(hi, 2, 50, 30, out_a); play_pcm(hp, 2, 50, 30, out_b); same("PLAY_PCM x2");
        play_fx(hi, 64, 200, 2, out_a); play_fx(hp, 64, 200, 2, out_b); same("PLAY_FX LOOP_OBJECT");
        play_fx(hi, 48, 128, 0, out_a); play_fx(hp, 48, 128, 0, out_b); same("PLAY_FX once");
        printf("IMA storage %s: OBJECT_INFO bits=4 format=3 frames=%u ch=%u, PLAY_PCM/PLAY_FX equal PCM decode PASS\n",
               cases[c][0], frames, channels);
        uint8_t q[2]; put16(q, hi); assert(!call(UG_OP_FREE, q, 2)); put16(q, hp); assert(!call(UG_OP_FREE, q, 2));
        /* A broken block layout is rejected at SEAL; the object is INVALID. */
        iw[32] = 34; /* block_align low byte: odd number of data words */
        hi = upload(iw, isz); assert(seal(hi) == UG_ERR_FORMAT); info(hi); assert(r[3] == 2);
        put16(q, hi); assert(!call(UG_OP_FREE, q, 2));
        free(iw); free(pw);
    }
    puts("IMA ADPCM storage PASS");
    return 0;
}
