; SPDX-License-Identifier: GPL-2.0-or-later
; Minimal read-only API1/VLS1 probe. Assemble with -DDOC_SLOT=0 or 1.
; UGCFG must select ULTRAGS and BASE 02A0 before this example.
    IFNDEF DOC_SLOT
    DEFINE DOC_SLOT 0
    ENDIF
    ORG 0x8000
header:
    DB "EXE",1
    DW 128,0,0,0,0,0,start,start,0xB800
    DS 128-($-header),0
start:
    ld (saved_sp),sp
    call UG_LIB_INIT
    ld a,1
    call UG_FRAME_CRC
    ld a,DOC_SLOT
    ld hl,0x02A0
    call UG_OPEN
    jr c,failed
    xor a                    ; INFO
    ld hl,0
    ld bc,0
    ld de,response
    ld ix,40
    call UG_RPC
    jr c,failed
    ld a,b
    or a
    jr nz,invalid
    ld a,c
    cp 40
    jr nz,invalid
    ld hl,response
    ld de,signature
    ld b,8                   ; UGS1, API1.0, mode8, boot ready
.check:
    ld a,(de)
    cp (hl)
    jr nz,invalid
    inc hl
    inc de
    djnz .check
    ld hl,response+36
    ld b,4
.layout:
    ld a,(de)
    cp (hl)
    jr nz,invalid
    inc hl
    inc de
    djnz .layout
    xor a
    jr finish
invalid:
    ld a,6                   ; STATE: incompatible INFO
failed:
    ; A retains the error; do not reset the card to recover discovery.
finish:
    ld (result),a
    call UG_CLOSE            ; no objects or voices have been acquired
    ld a,(result)
    ld hl,pass_text
    or a
    jr z,.print
    ld hl,fail_text
.print:
    ld c,0x5C
    rst 0x10                 ; DSS, ISA window is closed
    ld sp,(saved_sp)
    ld a,(result)
    ld b,a
    ld c,0x41
    rst 0x10
signature: DB "UGS1",1,0,8,0,"VLS1"
pass_text: DB "UltraGS API1/VLS1 ready",13,10,0
fail_text: DB "UltraGS probe failed",13,10,0
saved_sp EQU 0xB900
result EQU 0xB902
response EQU 0xBA00
    INCLUDE "ugproto.asm"
    ASSERT $ < 0xB700
    END start
