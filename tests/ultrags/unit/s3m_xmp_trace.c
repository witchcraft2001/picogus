/* SPDX-License-Identifier: GPL-2.0-or-later */
#include <xmp.h>
#include <stdio.h>
#include <assert.h>
#include <string.h>
int main(int argc,char **argv) {
    assert(argc==2);assert(!strcmp(xmp_version,"4.7.0"));
    xmp_context c=xmp_create_context();assert(c && !xmp_load_module(c,argv[1]));
    struct xmp_module_info m;xmp_get_module_info(c,&m);assert(!xmp_start_player(c,48000,0));
    assert(!xmp_set_player(c,XMP_PLAYER_MIX,100));struct xmp_frame_info f;
    for(unsigned t=0;t<20000;t++) {
        if(xmp_play_frame(c))break;xmp_get_frame_info(c,&f);if(f.loop_count)break;
        printf("%d %d %d %d %d",f.pos,f.row,f.frame,f.speed,f.bpm);
        for(int ch=0;ch<m.mod->chn;ch++) {
            struct xmp_channel_info *s=&f.channel_info[ch];
            printf(" %u %u %u %u %u 0",s->note>=12?s->note-12:127,s->period/4,s->volume,s->pan,s->position);
        }puts("");
    }
    xmp_end_player(c);xmp_release_module(c);xmp_free_context(c);return 0;
}
