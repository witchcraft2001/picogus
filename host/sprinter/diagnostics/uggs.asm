; SPDX-License-Identifier: GPL-2.0-or-later
; Read-only GS alias probe for the known UltraGS BASE=02A0.
; Every read uses the normal Turbo-off ISA window; no DATA/COMMAND reads,
; no card writes, RESET, mode change, SAVE or implicit alias enable.
    IFNDEF PROBE_SLOT
    DEFINE PROBE_SLOT 0
    ENDIF
    ASSERT PROBE_SLOT == 0 || PROBE_SLOT == 1
    ORG 0x8000
header:
    DB "EXE",1
    DW 0x80,0,0,0,0,0,entry,entry,0xBFFE
    DS 0x80-($-header),0
values EQU 0xB800
left EQU values+6
entry:
    xor a
    ld (UGCTX.ISOPEN),a
    ld a,16
    ld (left),a
    ld hl,title
    call print
.sample:
    ld hl,0x02A1
    call read_port
    ld (values),a
    ld hl,0x02A6
    call read_port
    ld (values+1),a
    ld hl,0x02A7
    call read_port
    ld (values+2),a
    ld hl,0x02BB
    call read_port
    ld (values+3),a
    ld hl,0x00BB
    call read_port
    ld (values+4),a
    ld hl,0x02BB
    call read_port
    ld (values+5),a
    ld hl,status_text
    call print
    ld a,(values)
    call hex
    ld hl,error_text
    call print
    ld a,(values+1)
    call hex
    ld hl,gserror_text
    call print
    ld a,(values+2)
    call hex
    ld hl,native_text
    call print
    ld a,(values+3)
    call hex
    ld hl,alias_text
    call print
    ld a,(values+4)
    call hex
    ld hl,after_text
    call print
    ld a,(values+5)
    call hex
    ld hl,newline
    call print
    ld a,(left)
    dec a
    ld (left),a
    jp nz,.sample
    ld hl,done_text
    call print
    ld b,0
    ld c,0x41
    rst 0x10
    halt
read_port:
    push hl
    ld hl,0x02A0
    ld a,PROBE_SLOT
    call UG_ISA_OPEN
    pop hl
    jp c,fail
    call UG_PORT_R
    push af
    call UG_ISA_CLOSE
    pop af
    ret
fail:
    ld hl,fail_text
    call print
    ld b,1
    ld c,0x41
    rst 0x10
    halt
print:
    ld c,0x5C
    rst 0x10
    ret
hex:
    push af
    rrca
    rrca
    rrca
    rrca
    call nibble
    pop af
nibble:
    and 15
    add a,'0'
    cp '9'+1
    jr c,.out
    add a,7
.out:
    ld c,0x5B
    rst 0x10
    ret
title:
    DB "UG GS probe D3: slot=",'0'+PROBE_SLOT," BASE=02A0; READ ONLY",13,10
    DB "ISA Turbo OFF; GSALIAS must already be ON. No card writes.",13,10
    DB "NATIVE/AFTER=02BB; ALIAS=00BB. Idle expected 7E/7E/7E.",13,10,0
status_text: DB "STATUS=",0
error_text: DB " ERROR=",0
gserror_text: DB " GSERR=",0
native_text: DB " NATIVE=",0
alias_text: DB " ALIAS=",0
after_text: DB " AFTER=",0
newline: DB 13,10,0
done_text:
    DB "DIAGNOSTIC COMPLETE (not an acceptance PASS)",13,10
    DB "FF can mean busy CB+DB or missing reply. Photograph all rows.",13,10,0
fail_text: DB "DIAGNOSTIC FAILED: ISA window open",13,10,0
    INCLUDE "isa.asm"
    ASSERT $ < values
    END entry
