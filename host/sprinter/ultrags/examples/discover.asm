; SPDX-License-Identifier: GPL-2.0-or-later
; Минимальная проверка карты API1/VLS1, только чтение. Сборка: -DDOC_SLOT=0 или 1.
; Перед запуском UGCFG должна включить режим ULTRAGS и BASE 02A0.
    IFNDEF DOC_SLOT
    DEFINE DOC_SLOT 0
    ENDIF
    DEFINE UG_NO_DSS          ; библиотека UltraGS не вызывает DSS
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
    xor a                    ; команда INFO
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
    ld b,8                   ; UGS1, API 1.0, режим 8, загрузка без ошибок
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
    ld a,6                   ; STATE: ответ INFO не подходит
failed:
    ; В A остаётся код ошибки; проверка карту не сбрасывает.
finish:
    ld (result),a
    call UG_CLOSE            ; объектов и голосов программа не занимала
    ld a,(result)
    ld hl,pass_text
    or a
    jr z,.print
    ld hl,fail_text
.print:
    ld c,0x5C
    rst 0x10                 ; вызов DSS: окно ISA уже закрыто
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
