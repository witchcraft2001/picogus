; SPDX-License-Identifier: GPL-2.0-or-later
; Read-only pre-reply IOR probe, requires UG_CONFIG_PROBE R11 firmware. Run only on the known PicoGUS slot with
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
left EQU values+7
entry:
    xor a
    ld (UGCTX.ISOPEN),a
    ld a,1
    ld (left),a
    ld hl,title
    call print
.sample:
    ld hl,0x02A1
    call read_port
    ld (values+1),a
    ld hl,0x02A6
    call read_port
    ld (values+2),a
    ld hl,0x02BC
    call read_port
    ld (values+3),a
    ld hl,0x02BD
    call read_port
    ld (values+4),a
    ld hl,0x02BE
    call read_port
    ld (values+5),a
    ld hl,0x02BF
    call read_port
    ld (values+6),a
    and 0xF8
    cp 0xA0
    jr nz,wrong_fw
    ld hl,status_text
    call print
    ld a,(values+1)
    call hex
    ld hl,error_text
    call print
    ld a,(values+2)
    call hex
    ld hl,selector_text
    call print
    ld a,(values+3)
    call hex
    ld hl,write_text
    call print
    ld a,(values+4)
    call hex
    ld hl,count_text
    call print
    ld a,(values+5)
    call hex
    ld hl,flags_text
    call print
    ld a,(values+6)
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
wrong_fw:
    ld hl,wrong_text
    call print
    ld b,2
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
    DB "UG CONFIG reply probe: slot=",'0'+PROBE_SLOT," base=02A0; R11 PROBE FW ONLY",13,10
    DB "Diagnostic only; no mode, SAVE, reset or consuming reads.",13,10,0
selector_text: DB " LATE=",0
write_text: DB " INDEX=",0
count_text: DB " SENT=",0
flags_text: DB " FLAGS=",0
status_text: DB " STATUS=",0
error_text: DB " ERROR=",0
newline: DB 13,10,0
done_text: DB "HEX fields; INDEX is zero-based. LATE>00: IOR ended before byte submit.",13,10
    DB "LATE=00 does not prove host received the byte. DIAGNOSTIC ONLY.",13,10,0
wrong_text: DB "WRONG FIRMWARE / BASE / SLOT: R11 probe marker missing.",13,10,0
fail_text: DB "DIAGNOSTIC FAILED: ISA window open",13,10,0
    INCLUDE "isa.asm"
    ASSERT $ < values
    END entry
