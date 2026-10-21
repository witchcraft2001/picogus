; SPDX-License-Identifier: GPL-2.0-or-later
; Generate owned MOD fixtures in private RAM, keeping zeros out of EXE code.
; DSS owns 0000..3FFF, including EXEC/EXIT state. Page1 is app RAM.
S8MOD_DATA EQU 0x4000
S8MOD_END EQU S8MOD_DATA+3164
S8TEST_BUILD:
    ld hl,S8MOD_DATA
    ld de,S8MOD_DATA+1
    ld bc,3163
    ld (hl),0
    ldir
    ld a,16
    ld (S8MOD_DATA+43),a
    ld (S8MOD_DATA+49),a
    ld a,12
    ld (S8MOD_DATA+45),a
    ld a,1
    ld (S8MOD_DATA+950),a
    ld hl,s8_signature
    ld de,S8MOD_DATA+1080
    ld bc,36
    ldir
    ld hl,S8MOD_DATA+3132
    ld b,16
.sample:
    ld (hl),64
    inc hl
    djnz .sample
    ld b,16
.tail:
    ld (hl),192
    inc hl
    djnz .tail
    ret
s8_signature: DB "8CHN",3,88,16,0,3,40,16,0,2,250,16,0,2,208,16,0
    DB 2,166,16,0,2,128,16,0,2,92,16,0,2,58,16,0
    ASSERT S8MOD_END <= BUF
    ASSERT S8MOD_DATA >= 0x4000
