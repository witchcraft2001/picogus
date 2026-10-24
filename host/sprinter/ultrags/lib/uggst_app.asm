; SPDX-License-Identifier: GPL-2.0-or-later
; Fixed-slot diagnostic: GS 00B3/00BB with software Turbo enabled.
; CONFIG/native operations keep the ordinary 3.5 MHz window contract.
    ORG 0x6000
HEADER:
    DB "EXE",1
    DW 128,0,0,0,0,0,START,START,0xBFFE
    DS 128-($-HEADER),0
START: jp ENTRY
    DEFINE UG_ISA_TURBO_OFF    ; D03: Turbo off inside ISA windows, CONFIG discovery
    INCLUDE "isa.asm"
    DEFINE APP_PROTO
    DEFINE APP_PCM
    DEFINE APP_S6TEST
    INCLUDE "ugmem.asm"
    END START
