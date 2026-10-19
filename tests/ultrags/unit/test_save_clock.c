/* SPDX-License-Identifier: GPL-2.0-or-later */
#include "mock.h"
#include "system/flash_settings.h"
#include <string.h>
uint8_t mock_flash[0x200000];
unsigned mock_clock=370000000,mock_clock_changes,mock_erases,mock_programs;
unsigned mock_prepares,mock_restores;
#ifdef SAVE_EXPECT_LEGACY
#define EXPECT_CLOCK 240000000
#else
#define EXPECT_CLOCK 370000000
#endif
void flash_range_erase(uint32_t off,size_t size) {
    assert(mock_clock==EXPECT_CLOCK);
    assert(off==0x1ff000&&size==4096);
    memset(mock_flash+off,255,size);mock_erases++;
}
void flash_range_program(uint32_t off,const uint8_t *data,size_t size) {
    assert(mock_clock==EXPECT_CLOCK);
    assert(off==0x1ff000&&size==256);
    memcpy(mock_flash+off,data,size);mock_programs++;
}
int main(void) {
    Settings settings;
    getDefaultSettings(&settings);settings.startupMode=8;
    memset(mock_flash,0xa5,sizeof(mock_flash));
    saveSettings(&settings);
    assert(mock_erases==1&&mock_programs==1&&mock_clock==370000000);
    assert(!memcmp(mock_flash+0x1ff000,&settings,sizeof(settings)));
    for(unsigned i=0;i<0x1ff000;i++)assert(mock_flash[i]==0xa5);
    for(unsigned i=sizeof(settings);i<256;i++)assert(!mock_flash[0x1ff000+i]);
    for(unsigned i=256;i<4096;i++)assert(mock_flash[0x1ff000+i]==255);
#ifdef SAVE_EXPECT_LEGACY
    assert(mock_clock_changes==3); /* 240 -> USB PLL48 -> PLL_SYS370 */
#else
    assert(!mock_clock_changes);
#endif
}
