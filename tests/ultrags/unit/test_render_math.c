/* SPDX-License-Identifier: GPL-2.0-or-later
 * Exhaustive bounded numerator tests for the private audio fast paths.
 * Include the production translation unit so the test cannot accidentally
 * exercise a copied implementation or expose test-only firmware APIs.
 */
#include "ultrags/ug_render.c"
#include <assert.h>
#include <stdio.h>
int main(void) {
    for(uint32_t n=0;n<=32768u*255+127;n++) assert(div255(n)==n/255);
    for(uint32_t n=0;n<=32768u*127+63;n++) assert(div127(n)==n/127);
    for(int32_t s=-32768;s<=32767;s++) for(unsigned p=0;p<256;p++) {
        assert(pan255(s,p)==ug_rdiv((int64_t)s*p,255));
        if(p<=127) assert(balance127(s,p)==ug_rdiv((int64_t)s*p,127));
        if(p<=128) assert(balance128(s,p)==ug_rdiv((int64_t)s*p,128));
    }
    uint32_t seed=0x13579bdf;
    for(unsigned i=0;i<1000000;i++) {
        seed=seed*1664525+1013904223;int32_t s=(int16_t)seed;
        uint32_t gain=((seed>>16)%65)*((seed>>9)%65)*((seed>>2)%65);
        assert(round_shift((int64_t)s*gain,18)==ug_rdiv((int64_t)s*gain,1ll<<18));
        seed=seed*1664525+1013904223;int32_t t=(int16_t)seed;
        int64_t v=(int64_t)s*0x100000000ll+(int64_t)(t-s)*seed;
        assert(round_shift(v,32)==ug_rdiv(v,1ll<<32));
        assert(round_shift((int64_t)s*(seed&32767),15)==ug_rdiv((int64_t)s*(seed&32767),1ll<<15));
    }
    puts("Render exact math: exhaustive pan numerators, 65536x256 pan signs, million interpolation/gain/master vectors PASS");
}
