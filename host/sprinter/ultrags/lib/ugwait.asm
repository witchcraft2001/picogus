; SPDX-License-Identifier: GPL-2.0-or-later
; Timed RPC waits. UG_DSS_TIMED reads the DSS clock (below); UG_NO_DSS
; counts the same deadlines in polls, see UG_WAIT_NEXT at the end.
; Optional DSS timed RPC profile. All DSS calls with ISA window closed.
; Seconds are accumulated modulo 60, so minute/day rollover and >60s jobs
; work identically. Polling also has a finite stagnant-clock bound.
; DSS reports whole seconds: the first tick can occur immediately after
; START. Expire only when elapsed ticks EXCEED the budget, so N seconds
; cannot expire before N real seconds (quantization adds <1 second).
UG_WAIT_RPC_START:
    IFDEF APP_PLAY
    ld a,(UGREQ.OP)
    cp UG_OP_STREAM_FEED
    jp nz,UG_WAIT_START
    xor a
    ld (UGTM.STARTED),a
    jp UG_WAIT_PHASE
    ELSE
    jp UG_WAIT_START
    ENDIF

; At most four status reads before falling back to the original deadline.
; Reset only the short-poll allowance on READY/grant/commit transitions;
; an active deadline and the stagnant-clock watchdog are never restarted.
UG_WAIT_PHASE:
    ld a,4
    ld (UGTM.FASTPOLLS),a
    ret
UG_WAIT_RPC_NEXT:
    IFDEF APP_PLAY
    ld a,(UGREQ.OP)
    cp UG_OP_STREAM_FEED
    jp nz,UG_WAIT_NEXT
    ld a,(UGTM.FASTPOLLS)
    or a
    jr z,.timed
    dec a
    ld (UGTM.FASTPOLLS),a
    or a
    ret nz
.timed:
    ld a,(UGTM.STARTED)
    or a
    jp nz,UG_WAIT_NEXT
    inc a
    ld (UGTM.STARTED),a
    call UG_WAIT_START
    xor a
    ret
    ELSE
    jp UG_WAIT_NEXT
    ENDIF

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
    jr nz,.s4
    ld a,(UGREQ.FRAME+6) ; RESET_STORE level: warm is an ordinary 1s RPC
    or a
    jr z,.clock
    jr .long
.s4:
    cp UG_OP_SEAL
    jr nz,.block
    ld a,30
    ld (UGTM.LIMIT),a
    jr .clock
.block:
    cp UG_OP_STREAM_FEED
    jr z,.transfer
    cp UG_OP_WRITE_BEGIN
    jr c,.clock
    cp UG_OP_TRANSFER_CANCEL+1
    jr nc,.clock
.transfer:
    ld a,2
    ld (UGTM.LIMIT),a
    jr .clock
.long:
    ld a,120
    ld (UGTM.LIMIT),a
.clock:
    IFNDEF UG_NO_DSS
    ld c,0x21
    rst 0x10
    ld a,b
    ld (UGTM.SEC),a
    ENDIF
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
    IFNDEF UG_NO_DSS
UG_WAIT_NEXT:
    push bc
    push de
    push hl
    push ix
    push iy
    ld a,(UGTM.NOESC)
    or a
    jr nz,.clock
    ld c,0x31
    rst 0x10
    cp 27
    jr z,.cancel
.clock:
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
    ELSE
; Synthetic clock: UGTM.STAGNANT counts polls of the current second,
; UG_SYNTH_PPS polls last at least one second at 21 MHz, so a deadline of
; N seconds never expires early; on a slower CPU it expires later.
UG_WAIT_NEXT:
    push bc
    push de
    push hl
    push ix
    push iy
    IFDEF UG_POLL_HOOK
    ld a,(UGTM.NOESC)
    or a
    jr nz,.clock
    call UG_POLL_HOOK		; CF=1: the program cancels
    jr c,.cancel
.clock:
    ENDIF
    ld hl,(UGTM.STAGNANT)
    inc hl
    ld (UGTM.STAGNANT),hl
    ld de,UG_SYNTH_PPS
    or a
    sbc hl,de
    jr c,.ok
    ld (UGTM.STAGNANT),hl	; zero: the next second begins
    ld hl,UGTM.ELAPSED
    inc (hl)
    ld a,(UGTM.LIMIT)
    cp (hl)
    jr z,.timeout
    jr c,.timeout
.ok:
    xor a
    jr .out
    IFDEF UG_POLL_HOOK
.cancel:
    ld a,UG_ERR_CANCELLED
    scf
    jr .out
    ENDIF
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
    ENDIF
