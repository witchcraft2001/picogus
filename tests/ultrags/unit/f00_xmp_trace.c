/* SPDX-License-Identifier: GPL-2.0-or-later */
#include <xmp.h>
#include <assert.h>
#include <stdio.h>
int main(int argc,char **argv) {
    assert(argc==2);xmp_context c=xmp_create_context();assert(c && !xmp_load_module(c,argv[1]));
    struct xmp_module_info m;xmp_get_module_info(c,&m);fprintf(stderr,"libxmp %s: %s\n",xmp_version,m.mod->type);
    assert(!xmp_start_player(c,48000,0));struct xmp_frame_info f;
    for(unsigned ticks=0;ticks<100000;ticks++) {
        if(xmp_play_frame(c))break;xmp_get_frame_info(c,&f);if(f.loop_count)break;
        printf("{\"order\":%d,\"pattern\":%d,\"row\":%d,\"tick\":%d,\"speed\":%d,\"bpm\":%d,\"time_ms\":%d,\"frame_us\":%d}\n",f.pos,f.pattern,f.row,f.frame,f.speed,f.bpm,f.time,f.frame_time);
    }
    xmp_end_player(c);xmp_release_module(c);xmp_free_context(c);return 0;
}
