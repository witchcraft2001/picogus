/* SPDX-License-Identifier: GPL-2.0-or-later
 * This program is free software under GPL version 2 or any later version.
 */
#include "ug_s3m.h"
#include <string.h>

static uint16_t le16(const uint8_t *b) { return b[0]|((uint16_t)b[1]<<8); }
static uint32_t le32(const uint8_t *b) { return le16(b)|((uint32_t)le16(b+2)<<16); }
static bool range(uint32_t off,uint32_t n,uint32_t size) { return off<=size && n<=size-off; }
uint32_t ug_s3m_rows_offset(const ug_s3m_info *i) { return sizeof(*i)+i->instruments*sizeof(ug_s3m_sample); }
void ug_s3m_parser_init(ug_s3m_parser *p,uint32_t size) {
    memset(p,0,sizeof(*p));p->info.file_size=size;
}
static bool effect_valid(unsigned fx,unsigned v) {
    if(!fx || fx==255) return true;
    if((fx>=1 && fx<=12) || fx==15 || (fx>=17 && fx<=22) || fx==24) {
        if(fx==19) {
            unsigned x=v>>4,y=v&15;
            return !v || x==1 || x==2 || ((x==3 || x==4) && y<=3) ||
                   x==8 || (x>=11 && x<=14);
        }
        if(fx==22) return v<=64;
        if(fx==24) return v<=128; /* surround is outside the PCM profile */
        return true;
    }
    return false;
}
static void empty_row(ug_s3m_parser *p) {
    memset(p->present,0,sizeof(p->present));
    for(unsigned c=0;c<32;c++) {
        memset(p->events[c],0,5);p->events[c][0]=p->events[c][2]=255;
    }
}
/* Consume at most one 256-byte input window on each cooperative step. */
static int byte(ug_s3m_parser *p,ug_mod_read_fn read,void *ctx,uint8_t *out) {
    if(p->cursor==p->end) return -1;
    if(p->cache_used==p->cache_size) {
        unsigned n=p->end-p->cursor;if(n>256)n=256;
        if(read(ctx,p->cursor,p->cache,n))return -2;
        p->cache_used=0;p->cache_size=(uint16_t)n;
    }
    *out=p->cache[p->cache_used++];p->cursor++;return 0;
}
int ug_s3m_parser_step(ug_s3m_parser *p,ug_mod_read_fn read,void *ctx,
                        ug_s3m_write_fn write,void *wctx) {
    ug_s3m_info *i=&p->info;uint8_t b[256];
    if(p->stage==0) {
        if(i->file_size<96)return -1;
        if(read(ctx,0,b,96))return -2;
        if(b[28]!=0x1a || b[29]!=16 || memcmp(b+44,"SCRM",4))return -1;
        i->orders=le16(b+32);i->instruments=le16(b+34);i->patterns=le16(b+36);
        unsigned flags=le16(b+38),ffi=le16(b+42);
        if(!i->orders || i->orders>256 || i->instruments>255 || !i->patterns || i->patterns>254 ||
           (ffi!=1 && ffi!=2) || (flags&~0x50u) || le16(b+62))return -1;
        i->signed_samples=ffi==1;i->fast_slides=(flags&64)!=0 || le16(b+40)==0x1300;
        i->amiga_limits=(flags&16)!=0;i->volume=b[48];i->speed=b[49];i->bpm=b[50];
        if(i->volume>64 || !i->speed || i->bpm<32)return -1;
        p->pan_present=b[53]==252;p->stereo_output=(b[51]&128)!=0;
        p->table_end=96+i->orders+2u*(i->instruments+i->patterns)+(p->pan_present?32:0);
        if(p->table_end>i->file_size)return -1;
        for(unsigned c=0;c<32;c++) {
            if(!(b[64+c]&128)) {
                if(b[64+c]>=16)return -1;
                i->enabled|=1u<<c;i->channels=c+1;
            }
            i->pan[c]=p->stereo_output?(b[64+c]<8?48:192):128;
        }
        if(!i->channels)return -1;
        p->stage=1;return 0;
    }
    if(p->stage==1) {
        if(read(ctx,96,i->order,i->orders))return -2;
        bool song=false;
        for(unsigned n=0;n<i->orders;n++) {
            unsigned v=i->order[n];
            if(v<254 && v>=i->patterns)return -1;
            if(v<254) { p->used[v/8]|=1u<<(v&7);song=true; }
        }
        if(!song)return -1;
        p->stage=2;return 0;
    }
    if(p->stage==2) {
        if(p->pan_present) {
            if(read(ctx,p->table_end-32,b,32))return -2;
            for(unsigned c=0;c<32;c++)if(b[c]&32)i->pan[c]=(b[c]&15)*16;
        }
        p->stage=3;return 0;
    }
    if(p->stage==3) {
        if(p->instrument<i->instruments) {
            if(read(ctx,96+i->orders+2u*p->instrument,b,2))return -2;
            uint32_t off=(uint32_t)le16(b)*16;ug_s3m_sample s={0};
            if(off) {
                if(off<p->table_end || !range(off,80,i->file_size))return -1;
                if(read(ctx,off,b,80))return -2;
                if(b[0]>1)return -1;
                if(b[0]) {
                    if(memcmp(b+76,"SCRS",4) || b[30] || (b[31]&~7u) || b[28]>64)return -1;
                    s.offset=((uint32_t)b[13]<<20)|((uint32_t)le16(b+14)<<4);
                    s.length=le32(b+16);s.loop_start=le32(b+20);s.loop_end=le32(b+24);
                    s.c2spd=le32(b+32);s.volume=b[28];s.flags=b[31];
                    uint64_t bytes=(uint64_t)s.length*((s.flags&4)?2:1)*((s.flags&2)?2:1);
                    if(bytes>UINT32_MAX || !range(s.offset,(uint32_t)bytes,i->file_size) ||
                       (s.length && (s.offset<p->table_end || !s.c2spd || s.c2spd>65535)))return -1;
                    if((s.flags&1) && !(s.loop_start<s.loop_end && s.loop_end<=s.length))return -1;
                    if(!(s.flags&1))s.loop_start=s.loop_end=0;
                    if(s.flags&2)p->stereo_instruments[p->instrument/8]|=1u<<(p->instrument&7);
                }
            }
            if(write && write(wctx,sizeof(*i)+p->instrument*sizeof(s),(const uint8_t *)&s,sizeof(s)))return -2;
            p->instrument++;return 0;
        }
        p->stage=4;return 0;
    }
    if(p->stage==4) {
        if(p->pattern==i->patterns) {
            i->aux_size=ug_s3m_rows_offset(i)+i->patterns*256u+p->event_bytes;
            p->written=0;p->stage=6;return 0;
        }
        if(read(ctx,96+i->orders+2u*(i->instruments+p->pattern),b,2))return -2;
        uint32_t off=(uint32_t)le16(b)*16;p->empty_pattern=!off;
        if(off) {
            if(off<p->table_end || !range(off,2,i->file_size))return -1;
            if(read(ctx,off,b,2))return -2;
            uint32_t len=le16(b);
            if(len<66 || !range(off,len,i->file_size))return -1;
            p->cursor=off+2;p->end=off+len;
        }
        p->cache_used=p->cache_size=0;p->row=0;empty_row(p);p->stage=5;return 0;
    }
    if(p->stage==5) {
        /* Each call consumes one token or emits one merged row, bounded even
         * for hostile streams containing thousands of duplicates per row. */
        uint8_t token=0;int rc;
        if(!p->empty_pattern && (rc=byte(p,read,ctx,&token)))return rc;
        if(token) {
            unsigned c=token&31;uint8_t *e=p->events[c];p->present[c]=1;
            if(token&32) {
                if((rc=byte(p,read,ctx,&e[0])) || (rc=byte(p,read,ctx,&e[1])))return rc;
                if((e[0]<254 && ((e[0]&15)>11 || (e[0]>>4)>9)) || e[1]>i->instruments)return -1;
            }
            if(token&64) {
                if((rc=byte(p,read,ctx,&e[2])))return rc;
                if(e[2]!=255 && e[2]>64)return -1;
            }
            if(token&128) {
                if((rc=byte(p,read,ctx,&e[3])) || (rc=byte(p,read,ctx,&e[4])))return rc;
                if(!effect_valid(e[3],e[4]))return -1;
                if(e[3]==255)e[3]=0;
            }
            return 0;
        }
        unsigned n=1;b[0]=0;
        for(unsigned c=0;c<32;c++)if(p->present[c] && (i->enabled&(1u<<c))) {
            uint8_t *e=p->events[c];b[n++]=c;memcpy(b+n,e,5);n+=5;++b[0];
            /* Any stereo assignment in any ordered pattern reserves a pair,
             * even if the subsequent note uses instrument memory after a jump. */
            if((p->used[p->pattern/8]&(1u<<(p->pattern&7))) && e[1] &&
               (p->stereo_instruments[(e[1]-1)/8]&(1u<<((e[1]-1)&7))))i->stereo|=1u<<c;
        }
        uint32_t off=ug_s3m_rows_offset(i)+i->patterns*256u+p->event_bytes;
        if(write && (write(wctx,off,b,n) || write(wctx,ug_s3m_rows_offset(i)+p->pattern*256u+p->row*4u,(const uint8_t *)&off,4)))return -2;
        p->event_bytes+=n;
        if(++p->row==64) {
            /* Trailing padding is permitted, but may not hide more events. */
            p->stage=7;
        } else empty_row(p);
        return 0;
    }
    if(p->stage==7) {
        if(!p->empty_pattern && p->cursor<p->end) {
            uint8_t v;int rc=byte(p,read,ctx,&v);if(rc)return rc;if(v)return -1;return 0;
        }
        ++p->pattern;p->stage=4;return 0;
    }
    if(p->stage==6) {
        unsigned n=sizeof(*i)-p->written;if(n>256)n=256;
        if(write && write(wctx,p->written,(const uint8_t *)i+p->written,n))return -2;
        p->written+=n;if(p->written<sizeof(*i))return 0;
        p->stage=8;
    }
    return 1;
}

/* Periods use ST3 units (four Amiga periods), Q8. Keep fractional tuning
 * through slides; only the public snapshot rounds to an Amiga period. */
static const uint16_t periods[12]={1712,1616,1524,1440,1356,1280,1208,1140,1076,1016,960,907};
static uint64_t note_period(unsigned note,uint32_t rate) {
    if(!rate)return 0;
    /* C0 at C2SPD=1 exceeds 32 bits in Q8; never wrap a valid tuning. */
    return ((uint64_t)periods[note%12]*4096u*8363u/rate)>>(note/12);
}
static uint8_t volume(int v) { return v<0?0:v>64?64:(uint8_t)v; }
static uint32_t clamp_period(const ug_s3m_player *p,int64_t v) {
    uint32_t low=p->info.amiga_limits?453u*256:0;
    uint32_t high=p->info.amiga_limits?856u*1024:65535u*256;
    return v<low?low:v>high?high:(uint32_t)v;
}
static int waveform(ug_s3m_channel *c,unsigned phase,unsigned wave) {
    static const uint8_t sine[32]={0,24,49,74,97,120,141,161,180,197,212,224,235,244,250,253,
                                  255,253,250,244,235,224,212,197,180,161,141,120,97,74,49,24};
    phase&=63;
    if(wave==1)return 255-(int)phase*8;
    if(wave==2)return phase<32?255:0;
    if(wave==3) { c->random=c->random*1664525u+1013904223u;return (int)(c->random>>23)-255; }
    return phase<32?sine[phase]:-(int)sine[phase-32];
}
static bool choose_order(ug_s3m_player *p,unsigned order) {
    for(unsigned n=0;n<=p->info.orders;n++) {
        if(order>=p->info.orders || p->info.order[order]==255) {
            if(!p->loop_song) { p->playing=0;return false; }
            order=0;
        }
        if(p->info.order[order]<254) { p->order=order;return true; }
        ++order;
    }
    p->playing=0;return false;
}
static void event(ug_s3m_player *p,unsigned ch,const uint8_t e[5]) {
    ug_s3m_channel *c=&p->channel[ch];
    unsigned fx=e[3],arg=e[4],note=e[0];bool porta=(fx==7 || fx==12) && c->base_period;
    bool new_volume=false;
    if(e[1]) {
        ug_s3m_sample s;
        if(p->read(p->ctx,sizeof(p->info)+(e[1]-1u)*sizeof(s),(uint8_t *)&s,sizeof(s))) {
            p->error=1;p->playing=0;return;
        }
        if(note!=254) { c->volume=s.volume;new_volume=true; }
        if(!porta) { c->sample=s;c->instrument=e[1]; }
    }
    if(fx==19 && (arg>>4)==2) {
        static const uint16_t tune[16]={7894,7952,8010,8068,8126,8185,8244,8303,8363,8424,8485,8546,8608,8670,8733,8796};
        c->sample.c2spd=tune[arg&15];
    }
    if(note==254) { c->volume=0;c->mix_volume=0; }
    else if(note!=255 && c->instrument) {
        unsigned n=(note>>4)*12+(note&15);uint64_t period=note_period(n,c->sample.c2spd);
        if(p->info.amiga_limits)period=clamp_period(p,(int64_t)period);
        c->target_period=period;
        if(!porta) {
            c->note=n;c->base_period=period;c->sample_offset=0;++c->trigger;
            c->vib_pos=c->trem_pos=0;
        }
    }
    if(e[2]!=255) { c->volume=e[2];new_volume=true; }
    c->effect=fx;c->param=arg;
    if(fx==7 || fx==8 || fx==21) {
        uint8_t *mem=fx==7?&c->porta:&c->vibrato;
        if(arg)*mem=arg;else arg=*mem;
        if(arg)c->memory=arg;
    } else if(fx==1 || fx==4 || fx==5 || fx==6 || fx==9 || fx==10 || fx==11 || fx==12 || fx==15 || fx==17 || fx==18) {
        /* L takes its porta rate from the common ST3 memory BEFORE D updates it. */
        if(fx==12)c->porta=c->memory;
        if(arg)c->memory=arg;else arg=c->memory;
    }
    if(fx==19 && (arg>>4)!=8 && arg!=0xc0) {
        static const uint8_t translated[16]={0,3,5,4,7,0,0,0,0,0,0,6,12,13,14,0};
        static const uint8_t original[16]={0,0,0,1,3,2,11,4,8,0,0,0,12,13,14,0};
        if(arg)c->memory=translated[arg>>4]*16+(arg&15);
        else arg=original[c->memory>>4]*16+(c->memory&15);
    }
    c->param=arg;
    unsigned x=arg>>4,y=arg&15;
    switch(fx) {
    case 1: if(arg)p->speed=arg;break; /* A00 uses ST3 memory, never MOD F00. */
    case 2: p->jump=arg;p->break_row=0;break;
    case 3: p->break_row=x*10+y;if(p->break_row>=64)p->break_row=0;break;
    case 8:case 21:
        if(x)c->vib_speed=x;
        if(y)c->vib_depth=y*(fx==21?1:4);
        break;
    case 15:if(note<254)c->sample_offset=arg*256u;break;
    case 17:if(arg)c->retrig_param=arg;if(note<254)c->retrig_count=(arg&15)+1;break;
    case 18:if(x)c->trem_speed=x;if(y)c->trem_depth=y;break;
    case 19:
        switch(x) {
        case 1:c->gliss=y!=0;break;
        case 3:c->vib_wave=y;break;
        case 4:c->trem_wave=y;break;
        case 8:c->pan=y*16;break;
        case 11:
            if(!y)c->loop_row=p->row;
            else {
                if(!c->loop_count)c->loop_count=y;
                else --c->loop_count;
                if(c->loop_count)p->loop_row=c->loop_row;
            }break;
        case 12:if(y)c->cut=y;break;
        case 14:if(!p->delay)p->delay=y;break;
        default:break;
        }break;
    case 20:if(arg>=32)p->bpm=arg;break;
    case 22:p->volume=arg;break;
    case 24:c->pan=arg==128?255:arg*2;break;
    default:break;
    }
    /* ST3 scales a new instrument/volume by global volume at assignment. */
    if(new_volume)c->volume=c->volume*p->volume/64;
}
static void tick_channel(ug_s3m_player *p,unsigned ch,bool first) {
    ug_s3m_channel *c=&p->channel[ch];
    if(c->delay && p->tick==c->delay) { c->delay=0;event(p,ch,c->delayed); }
    unsigned fx=c->effect,arg=c->param,x=arg>>4,y=arg&15;
    if(fx==4 || fx==11 || fx==12) {
        int change=0;
        if(y==15 && x) { if(first)change=x; }
        else if(x==15 && y) { if(first)change=-(int)y; }
        else if(!first || p->info.fast_slides || x==15 || y==15)change=y?-(int)y:(int)x;
        c->volume=volume((int)c->volume+change);
    }
    if((fx==5 || fx==6) && c->base_period) {
        int delta=0;
        if(x==15) { if(first)delta=y*1024; }
        else if(x==14) { if(first)delta=y*256; }
        else if(!first)delta=arg*1024;
        c->base_period=clamp_period(p,(int64_t)c->base_period+(fx==5?delta:-delta));
    }
    if((fx==7 || fx==12) && !first && c->base_period && c->target_period) {
        uint32_t step=c->porta*1024u;
        if(c->base_period<c->target_period) {
            uint64_t d=c->target_period-c->base_period;c->base_period+=d<step?d:step;
        } else { uint64_t d=c->base_period-c->target_period;c->base_period-=d<step?d:step; }
    }
    if(fx==17) {
        if(!c->retrig_count || !--c->retrig_count) {
            static const int8_t add[16]={0,-1,-2,-4,-8,-16,0,0,0,1,2,4,8,16,0,0};
            unsigned op=c->retrig_param>>4;int v=c->volume+add[op];
            if(op==6)v=v*2/3;else if(op==7)v/=2;else if(op==14)v=v*3/2;else if(op==15)v*=2;
            c->volume=volume(v);c->sample_offset=0;++c->trigger;c->retrig_count=c->retrig_param&15;
        }
    }
    if(c->cut && p->tick==c->cut) { c->volume=0;c->cut=0; }
    c->period=c->base_period;c->mix_volume=c->volume;
    if(c->gliss && (fx==7 || fx==12) && c->period) {
        /* Monotone period table: at most seven probes, even on 32 channels. */
        unsigned lo=0,hi=119;
        while(lo<hi) {
            unsigned mid=(lo+hi)/2;
            if(note_period(mid,c->sample.c2spd)>c->period)lo=mid+1;else hi=mid;
        }
        uint64_t below=note_period(lo,c->sample.c2spd);
        uint64_t above=lo?note_period(lo-1,c->sample.c2spd):below;
        uint64_t da=above>c->period?above-c->period:c->period-above;
        uint64_t db=below>c->period?below-c->period:c->period-below;
        c->period=da<=db?above:below;
    }
    if(fx==10 && arg && c->period) {
        static const uint32_t ratio[16]={65536,61858,58386,55109,52016,49097,46341,43740,41285,38968,36781,34716,32768,30929,29193,27554};
        unsigned tick=p->tick%p->speed;unsigned n=tick%3==1?x:tick%3==2?y:0;
        c->period=(c->period*ratio[n])>>16;
    }
    if((fx==8 || fx==11 || fx==21) && c->period) {
        int delta=waveform(c,c->vib_pos,c->vib_wave)*c->vib_depth/512;
        c->period=clamp_period(p,(int64_t)c->period+delta*1024);
        if(!first)c->vib_pos=(c->vib_pos+c->vib_speed)&63;
    }
    if(fx==18) {
        c->mix_volume=volume((int)c->volume+waveform(c,c->trem_pos,c->trem_wave)*c->trem_depth/64);
        if(!first)c->trem_pos=(c->trem_pos+c->trem_speed)&63;
    }
    if(fx==9) {
        if(!c->tremor_count)c->tremor_count=(x?x:1)|128;
        else if(c->tremor_count==128)c->tremor_count=y?y:1;
        --c->tremor_count;
        if(!(c->tremor_count&128))c->mix_volume=0;
    }
    c->mix_volume=c->mix_volume*p->volume/64;
    if(!c->base_period)c->period=0;
    else if(c->period<64*256)c->period=64*256;
}
static void row(ug_s3m_player *p) {
    uint32_t off;uint8_t b[193];unsigned pat=p->info.order[p->order];
    p->jump=p->break_row=p->loop_row=-1;
    uint32_t present=0;
    for(unsigned c=0;c<32;c++)p->channel[c].delay=p->channel[c].cut=0;
    if(p->read(p->ctx,ug_s3m_rows_offset(&p->info)+pat*256u+p->row*4u,(uint8_t *)&off,4) ||
       p->read(p->ctx,off,b,1))goto io_error;
    if(b[0]>32 || !range(off,1u+b[0]*6u,p->info.aux_size))goto format_error;
    if(b[0] && p->read(p->ctx,off+1,b+1,b[0]*6u))goto io_error;
    for(unsigned n=0;n<b[0];n++) {
        unsigned ch=b[1+n*6];const uint8_t *e=b+2+n*6;
        if(ch>=32)goto format_error;
        ug_s3m_channel *c=&p->channel[ch];present|=1u<<ch;
        if(e[3]==19 && (e[4]>>4)==13 && (e[4]&15)) {
            memcpy(c->delayed,e,5);c->delay=e[4]&15;
        } else event(p,ch,e);
    }
    for(unsigned c=0;c<p->info.channels;c++) { if(!(present&(1u<<c)))p->channel[c].effect=0;tick_channel(p,c,true); }
    return;
io_error:p->error=1;p->playing=0;return;
format_error:p->error=2;p->playing=0;
}
static void init_channels(ug_s3m_player *p) {
    memset(p->channel,0,sizeof(p->channel));
    for(unsigned c=0;c<32;c++) { p->channel[c].note=127;p->channel[c].pan=p->info.pan[c];p->channel[c].random=c+1; }
    p->volume=p->info.volume;p->speed=p->info.speed;p->bpm=p->info.bpm;
}
void ug_s3m_start(ug_s3m_player *p,const ug_s3m_info *i,ug_mod_read_fn read,void *ctx,uint8_t flags) {
    memset(p,0,sizeof(*p));p->info=*i;p->read=read;p->ctx=ctx;p->loop_song=flags&1;p->playing=1;
    init_channels(p);if(choose_order(p,0))row(p);
}
void ug_s3m_tick(ug_s3m_player *p) {
    if(!p->playing || p->paused)return;
    if(p->pending_speed) { p->speed=p->pending_speed;p->bpm=p->pending_bpm;p->pending_speed=0; }
    if(++p->row_tick<(unsigned)p->speed*(p->delay+1u)) {
        p->tick=(uint8_t)(p->row_tick%p->speed);
        for(unsigned c=0;c<p->info.channels;c++)tick_channel(p,c,p->tick==0);return;
    }
    p->tick=0;p->row_tick=0;p->delay=0;
    unsigned order=p->order,next_row=p->row+1;
    if(p->jump>=0 || p->break_row>=0) { order=p->jump>=0?(unsigned)p->jump:order+1;next_row=p->break_row>=0?(unsigned)p->break_row:0; }
    else if(p->loop_row>=0)next_row=p->loop_row;
    else if(next_row>=64) { ++order;next_row=0; }
    if(order!=p->order)for(unsigned c=0;c<32;c++)p->channel[c].loop_count=p->channel[c].loop_row=0;
    if(choose_order(p,order)) { p->row=next_row;row(p); }
}
int ug_s3m_seek(ug_s3m_player *p,uint16_t order,uint8_t next_row) {
    if(!p->playing || order>=p->info.orders || next_row>=64 || p->info.order[order]==255)return -1;
    p->tempo_fraction=0;p->tick=0;p->row_tick=0;p->delay=p->pending_speed=p->error=0;
    init_channels(p);if(choose_order(p,order)) { p->row=next_row;row(p); }return 0;
}
uint64_t ug_s3m_step(const ug_s3m_channel *c) {
    return c->period?(((uint64_t)14317056u<<32)/48000u*256u)/c->period:1;
}
