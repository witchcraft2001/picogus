; SPDX-License-Identifier: GPL-2.0-or-later
    ORG 0x6000
HEADER:
    DB "EXE",1
    DW 128,0,0,0,0,0,START,START,0xBFFE
    DS 128-($-HEADER),0
START: jp ENTRY
    DEFINE APP_PROTO
    DEFINE APP_PCM
    DEFINE APP_S6TEST
    DEFINE APP_OPL
    DEFINE UG_ISA_TURBO_OFF    ; D03: Turbo off inside ISA windows, CONFIG discovery
    INCLUDE "isa.asm"
    INCLUDE "ugmem.asm"
    END START
