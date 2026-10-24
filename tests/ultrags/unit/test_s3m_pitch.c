/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "ug_s3m.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static uint8_t aux[1024];
static int read_aux(void *ctx,uint32_t off,uint8_t *dst,uint32_t n) {
    (void)ctx;assert(n<=256 && off+n<=sizeof(aux));memcpy(dst,aux+off,n);return 0;
}
static ug_s3m_player player;
static void start(uint32_t rate,uint8_t note,bool amiga) {
    ug_s3m_info info={.aux_size=sizeof(aux),.enabled=1,.orders=2,.instruments=1,
        .patterns=1,.channels=1,.speed=6,.bpm=125,.volume=64,.amiga_limits=amiga};
    info.order[1]=255;info.pan[0]=128;
    ug_s3m_sample sample={.length=8192,.c2spd=rate,.volume=48};
    uint32_t row=ug_s3m_rows_offset(&info)+256;
    memset(aux,0,sizeof(aux));memcpy(aux+sizeof(info),&sample,sizeof(sample));
    memcpy(aux+ug_s3m_rows_offset(&info),&row,4);
    const uint8_t event[]={1,0,note,1,48,0,0};memcpy(aux+row,event,sizeof(event));
    ug_s3m_start(&player,&info,read_aux,NULL,0);assert(player.playing && !player.error);
}
int main(void) {
    /* C4 at the lowest legal tuning advances one sample per second; C0 is
     * four octaves slower. Q32 quantization and the ST3 clock constant permit
     * less than 0.01% error, without a wrapped Q8 period or a zero step. */
    for(unsigned octave=0;octave<=4;octave++) {
        start(1,octave*16,false);
        uint64_t step=ug_s3m_step(&player.channel[0]);
        uint64_t expected=(UINT64_C(1)<<32)/(48000u*(1u<<(4-octave)));
        assert(step && step*10000>=expected*9999 && step<=expected);
        if(!octave)assert(player.channel[0].period>UINT32_MAX);
    }
    start(65535,0x40,false);
    uint64_t step=ug_s3m_step(&player.channel[0]);
    uint64_t expected=((UINT64_C(1)<<32)*65535)/48000;
    assert(step*10000>=expected*9999 && step<=expected);
    start(8363,0,true);assert(player.channel[0].period==856*1024);
    start(8363,0x80,true);assert(player.channel[0].period==453*256);
    start(65535,0x9b,false);assert(player.channel[0].period==64*256);
    puts("S3M C2SPD 1/65535, C0..C4 fractional frequency, B9 minimum output period and Amiga note limits PASS");
    return 0;
}
