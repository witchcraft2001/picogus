; SPDX-License-Identifier: GPL-2.0-or-later
; Read-only boot fault probe. Run only on the known PicoGUS slot with
; ULTRAGS BASE=02A0 after a failed switch. No config discovery prerequisite:
; unlike normal clients, this deliberately diagnoses broken discovery.
; It never writes ISA card ports or reads consuming DATA/RESPONSE registers.
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
left EQU values+3
entry:
    xor a
    ld (UGCTX.ISOPEN),a
    ld a,16
    ld (left),a
    ld hl,title
    call print
.sample:
    ld hl,0x01D0
    call read_port
    ld (values),a
    ld hl,0x02A1
    call read_port
    ld (values+1),a
    ld hl,0x02A6
    call read_port
    ld (values+2),a
    ld hl,cfg_text
    call print
    ld a,(values)
    call hex
    ld hl,status_text
    call print
    ld a,(values+1)
    call hex
    ld hl,error_text
    call print
    ld a,(values+2)
    call hex
    ld hl,newline
    call print
    ld a,(left)
    dec a
    ld (left),a
    jr nz,.sample
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
    DB "UG boot probe: slot=",'0'+PROBE_SLOT," base=02A0; READ ONLY",13,10
    DB "Diagnostic only; no mode, SAVE, reset or consuming reads.",13,10,0
cfg_text: DB "CFG_1D0=",0
status_text: DB " STATUS_2A1=",0
error_text: DB " ERROR_2A6=",0
newline: DB 13,10,0
done_text: DB "DIAGNOSTIC COMPLETE (not an acceptance PASS)",13,10,0
fail_text: DB "DIAGNOSTIC FAILED: ISA window open",13,10,0
    DEFINE UG_ISA_TURBO_OFF    ; D03: Turbo off inside ISA windows, CONFIG discovery
    INCLUDE "isa.asm"
    ASSERT $ < values
    END entry
