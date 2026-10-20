; SPDX-License-Identifier: GPL-2.0-or-later
; Verified block concatenation, CRC32(A||B) = M(len(B))*CRC32(A) xor CRC32(B).
; No payload scan. FILECRC and UG_FILE_BLOCK_CRC contain finalized host CRCs.
UG_CRC_COMBINE:
    ld hl,(BLOCK)
    ld (UG_COMBINE_LENGTH),hl
    ld hl,UG_CRC_COMBINE_POWERS
    ld (UG_COMBINE_MATRIX),hl
.next:
    ld hl,(UG_COMBINE_LENGTH)
    ld a,h
    or l
    jr z,.finish
    srl h
    rr l
    ld (UG_COMBINE_LENGTH),hl
    jr nc,.skip
    ld hl,0
    ld (UG_COMBINE_TEMP),hl
    ld (UG_COMBINE_TEMP+2),hl
    ld a,(FILECRC)
    ld e,a
    ld a,(FILECRC+1)
    ld d,a
    ld a,(FILECRC+2)
    ld c,a
    ld a,(FILECRC+3)
    ld b,a
    ld hl,(UG_COMBINE_MATRIX)
    ld a,32
    ld (UG_COMBINE_BITS),a
.bit:
    srl b
    rr c
    rr d
    rr e
    jr nc,.zero
    ld a,(UG_COMBINE_TEMP)
    xor (hl)
    ld (UG_COMBINE_TEMP),a
    inc hl
    ld a,(UG_COMBINE_TEMP+1)
    xor (hl)
    ld (UG_COMBINE_TEMP+1),a
    inc hl
    ld a,(UG_COMBINE_TEMP+2)
    xor (hl)
    ld (UG_COMBINE_TEMP+2),a
    inc hl
    ld a,(UG_COMBINE_TEMP+3)
    xor (hl)
    ld (UG_COMBINE_TEMP+3),a
    inc hl
    jr .count
.zero:
    inc hl
    inc hl
    inc hl
    inc hl
.count:
    ld a,(UG_COMBINE_BITS)
    dec a
    ld (UG_COMBINE_BITS),a
    jr nz,.bit
    ld hl,UG_COMBINE_TEMP
    ld de,FILECRC
    ld bc,4
    ldir
.skip:
    ld hl,(UG_COMBINE_MATRIX)
    ld de,128
    add hl,de
    ld (UG_COMBINE_MATRIX),hl
    jp .next
.finish:
    ld hl,FILECRC
    ld de,UG_FILE_BLOCK_CRC
    ld b,4
.xor:
    ld a,(de)
    xor (hl)
    ld (hl),a
    inc de
    inc hl
    djnz .xor
    ret
UG_COMBINE_LENGTH: DW 0
UG_COMBINE_MATRIX: DW 0
UG_COMBINE_TEMP: DS 4,0
UG_COMBINE_BITS: DB 0
UG_FILE_BLOCK_CRC: DS 4,0
    INCLUDE "ugcrc_combine_table.asm"
