; SPDX-License-Identifier: GPL-2.0-or-later
; Actual EXE: direct pre-session windows, nesting, invalid slot, reopen.
; Harness seeds B300 with slot and independently checks IO order/context.
    INCLUDE "st-head.inc"
    ld a,2
    ld hl,0x1D0
    call UG_ISA_OPEN
    jp nc,st_fail
    cp UG_ERR_BAD_ARGUMENT
    jp nz,st_fail
    ld de,0x1234
    ld ix,0x5678
    ld iy,0x9ABC
    call probe
    jp c,st_failA
    call probe
    jp c,st_failA
    ld a,d
    cp 0x12
    jp nz,st_fail
    ld a,e
    cp 0x34
    jp nz,st_fail
    push ix
    pop hl
    ld bc,0x5678
    or a
    sbc hl,bc
    jp nz,st_fail
    push iy
    pop hl
    ld bc,0x9ABC
    or a
    sbc hl,bc
    jp nz,st_fail
    jp st_pass
probe:
    ld a,(0xB300)
    ld hl,0x1D0
    call UG_ISA_OPEN
    ret c
    ld a,(0xB300)
    ld hl,0x1D0
    call UG_ISA_OPEN
    jp nc,st_fail
    cp UG_ERR_STATE
    jp nz,st_fail
    ld hl,0x1D0
    call UG_PORT_R
    call UG_ISA_CLOSE
    ret
    INCLUDE "st-tail.inc"
