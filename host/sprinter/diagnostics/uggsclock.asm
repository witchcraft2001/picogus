; SPDX-License-Identifier: GPL-2.0-or-later
; Diagnostic exception to production Turbo-OFF-only ISA access.
; Read exactly the known enabled GS status alias, never DATA or COMMAND.
; Each read has a separate bounded ISA window, with PAGE3/IFF restored.
; Switch Turbo before opening ISA; close ISA before returning Turbo ON.
    IFNDEF PROBE_SLOT
    DEFINE PROBE_SLOT 0
    ENDIF
    ASSERT PROBE_SLOT == 0 || PROBE_SLOT == 1
    ORG 0x8000
header:
    DB "EXE",1
    DW 0x80,0,0,0,0,0,entry,entry,0xBFFE
    DS 0x80-($-header),0
entry:
    ld a,16
    ld (remaining),a
    ld hl,title
    call print
.sample:
    ld a,2
    call read_status
    ld (slow1),a
    ld a,3
    call read_status
    ld (fast),a
    ld a,2
    call read_status
    ld (slow2),a
    ld hl,slow1_text
    call print
    ld a,(slow1)
    call hex
    ld hl,fast_text
    call print
    ld a,(fast)
    call hex
    ld hl,slow2_text
    call print
    ld a,(slow2)
    call hex
    ld hl,newline
    call print
    ld a,(remaining)
    dec a
    ld (remaining),a
    jr nz,.sample
    ld hl,done
    call print
    ld b,0
    ld c,0x41
    rst 0x10
    halt
; A=2 (software Turbo OFF) or 3 (ON); returns sampled status in A.
read_status:
    ld (requested),a
    ld a,i
    jp pe,.iff
    ld a,i
.iff:
    push af
    di
    pop af
    ld a,0
    jp po,.save_iff
    inc a
.save_iff:
    ld (saved_iff),a
    ld bc,0x00E2
    in a,(c)
    ld (saved_page),a
    ld bc,0x003C
    ld a,(requested)
    out (c),a
    ld bc,0x1FFD
    ld a,0x11
    out (c),a
    ld bc,0x00E2
    ld a,0xD4+PROBE_SLOT*2
    out (c),a
    ld bc,0x9FBD
    xor a
    out (c),a
    ; Same absolute read instruction/address as PROPLAY's detection.
    ld a,(0xC0BB)
    ld (sampled),a
    ld bc,0x1FFD
    ld a,1
    out (c),a
    ld bc,0x00E2
    ld a,(saved_page)
    out (c),a
    ld bc,0x003C
    ld a,3
    out (c),a
    ld a,(saved_iff)
    or a
    ld a,(sampled)
    ret z
    ei
    ret
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
remaining: DB 0
requested: DB 0
saved_iff: DB 0
saved_page: DB 0
sampled: DB 0
slow1: DB 0
fast: DB 0
slow2: DB 0
title:
    DB "UG GS clock probe D4: slot=",'0'+PROBE_SLOT," port=00BB; READ ONLY",13,10
    DB "Requires ULTRAGS and GSALIAS ON. No card writes.",13,10
    DB "SLOW1/FAST/SLOW2 request Turbo OFF/ON/OFF.",13,10
    DB "Hardware clock is not measured. PAGE3/IFF restored.",13,10,0
slow1_text: DB "SLOW1=",0
fast_text: DB " FAST=",0
slow2_text: DB " SLOW2=",0
newline: DB 13,10,0
done:
    DB "DIAGNOSTIC COMPLETE (not an acceptance PASS)",13,10
    DB "DSS Turbo ON restored. Photograph all rows.",13,10,0
    ASSERT $ < 0xB800
    END entry
