; SPDX-License-Identifier: GPL-2.0-or-later
; Optional DSS timed RPC profile. All DSS calls with ISA window closed.
; Seconds are accumulated modulo 60, so minute/day rollover and >60s jobs
; work identically. Polling also has a finite stagnant-clock bound.
UG_WAIT_START:
    push af
    push bc
    push de
    push hl
    push ix
    push iy
    ld a,1
    ld (UGTM.LIMIT),a
    ld a,(UGREQ.OP)
    cp UG_OP_MEM_TEST
    jr z,.long
    cp UG_OP_RESET_STORE
    jr nz,.clock
    ld a,(UGREQ.FRAME+6) ; RESET_STORE level: warm is an ordinary 1s RPC
    or a
    jr z,.clock
.long:
    ld a,120
    ld (UGTM.LIMIT),a
.clock:
    ld c,0x21
    rst 0x10
    ld a,b
    ld (UGTM.SEC),a
    xor a
    ld (UGTM.ELAPSED),a
    ld (UGTM.STAGNANT),a
    ld (UGTM.STAGNANT+1),a
    ld (UGTM.STAGNANT+2),a
    pop iy
    pop ix
    pop hl
    pop de
    pop bc
    pop af
    ret
UG_WAIT_NEXT:
    push bc
    push de
    push hl
    push ix
    push iy
    ld c,0x31
    rst 0x10
    cp 27
    jr z,.cancel
    ld c,0x21
    rst 0x10
    ld a,(UGTM.SEC)
    ld c,a
    ld a,b
    ld (UGTM.SEC),a
    sub c
    jr nc,.delta
    add a,60
.delta:
    or a
    jr z,.stagnant
    ld hl,UGTM.ELAPSED
    add a,(hl)
    ld (hl),a
    ld b,a
    ld a,(UGTM.LIMIT)
    cp b
    jr z,.timeout
    jr c,.timeout
    xor a
    ld (UGTM.STAGNANT),a
    ld (UGTM.STAGNANT+1),a
    ld (UGTM.STAGNANT+2),a
.stagnant:
    ld hl,UGTM.STAGNANT
    inc (hl)
    jr nz,.ok
    inc hl
    inc (hl)
    jr nz,.ok
    inc hl
    inc (hl)
    ld a,(hl)
    cp 4
    jr nc,.timeout
.ok:
    xor a
    jr .out
.cancel:
    ld a,UG_ERR_CANCELLED
    scf
    jr .out
.timeout:
    ld a,UG_ERR_TIMEOUT
    scf
.out:
    pop iy
    pop ix
    pop hl
    pop de
    pop bc
    ret
; Yield before the ninth frame byte; register values and flags preserved.
UG_FRAME_YIELD:
    push af
    ld a,(UGTM.CHUNK)
    cp 8
    jr c,.count
    push bc
    push de
    push hl
    call UG_ISA_CLOSE
    call UG_WIN_OPEN
    pop hl
    pop de
    pop bc
    xor a
.count:
    inc a
    ld (UGTM.CHUNK),a
    pop af
    ret
