; SPDX-License-Identifier: GPL-2.0-or-later
; Known PicoGUS slot, native BASE02A0 only. No discovery prerequisite.
; Diagnostic writes: FF then A2 to native CONTROL2A2; CC/01 to CONFIG1D0.
; Requires idle STATUS01/ERROR00. No mode/SAVE/reset/object/data writes.
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
entry:
    xor a
    ld (UGCTX.ISOPEN),a
    ld hl,title
    call print
    ld hl,before_text
    call print
    call native_state
    ld a,(values)
    cp 1
    jp nz,unsafe_state
    ld a,(values+1)
    or a
    jp nz,unsafe_state
    ld hl,0x02A2
    ld a,0xFF
    call write_port
    ld hl,invalid_text
    call print
    call native_state
    ld hl,0x02A2
    ld a,0xA2
    call write_port
    ld hl,clear_text
    call print
    call native_state
    ld hl,0x01D0
    ld a,0xCC
    call write_port
    ld hl,0x01D0
    ld a,1
    call write_port
    ld hl,cfg_text
    call print
    ld hl,0x01D0
    call read_port
    call hex
    ld hl,protocol_text
    call print
    ld hl,0x01D2
    call read_port
    call hex
    ld hl,trace_sel_text
    call print
    ld hl,0x02BC
    call read_port
    call hex
    ld hl,raw_text
    call print
    ld hl,0x02BD
    call read_port
    call hex
    ld hl,flags_text
    call print
    ld hl,0x02BF
    call read_port
    call hex
    ld hl,newline
    call print
    ld hl,expected_text
    call print
    ld hl,done_text
    call print
    ld b,0
    jp finish
unsafe_state:
    ld hl,unsafe_text
    call print
    ld b,2
finish:
    ld c,0x41
    rst 0x10
    halt
native_state:
    ld hl,0x02A1
    call read_port
    ld (values),a
    ld hl,0x02A6
    call read_port
    ld (values+1),a
    ld hl,status_text
    call print
    ld a,(values)
    call hex
    ld hl,error_text
    call print
    ld a,(values+1)
    call hex
    ld hl,newline
    jp print
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
write_port:
    push af
    push hl
    ld hl,0x02A0
    ld a,PROBE_SLOT
    call UG_ISA_OPEN
    pop hl
    jr c,.failed
    pop af
    call UG_PORT_W
    jp UG_ISA_CLOSE
.failed:
    pop af
fail:
    ld hl,fail_text
    call print
    ld b,1
    jp finish
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
    DB "UG write probe: slot=",'0'+PROBE_SLOT," BASE02A0; CONFIG TRACE firmware",13,10
    DB "No Flash/mode/object writes. FF command error is intentional; A2 clears it.",13,10,0
before_text: DB "BEFORE:",0
invalid_text: DB "NATIVE FF:",0
clear_text: DB "NATIVE A2:",0
status_text: DB " STATUS=",0
error_text: DB " ERROR=",0
cfg_text: DB "CONFIG: SEL=",0
protocol_text: DB " PROTO=",0
trace_sel_text: DB " TRACE_SEL=",0
raw_text: DB " RAW=",0
flags_text: DB " FLAGS=",0
expected_text:
    DB "Expected native ERROR: FF->02, A2->00. CONFIG: SEL01 PROTO04.",13,10,0
done_text: DB "DIAGNOSTIC COMPLETE (not an acceptance PASS)",13,10,0
unsafe_text: DB "ABORT: expected idle STATUS01 ERROR00; no card writes performed.",13,10,0
fail_text: DB "DIAGNOSTIC FAILED: ISA window open",13,10,0
newline: DB 13,10,0
    INCLUDE "isa.asm"
    ASSERT $ < values
    END entry
