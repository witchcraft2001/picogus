; SPDX-License-Identifier: GPL-2.0-or-later
; Common protocol-4 selection. UGCTX.SLOT/BASE must be initialized.
; Preserves BC/DE/HL/IX/IY, PAGE3 and IFF. Every bus operation has its own
; short Turbo-off window. Delays/DSS run with ISA closed. No data read or
; mutation is retried here. E3/FWSTRING may be reselected only BEFORE data.
    IFNDEF UGCONFIG_INC
    DEFINE UGCONFIG_INC
    INCLUDE "isa.asm"
UG_CFG_SELECT: ; A=selector; CF=1 A=wire TIMEOUT/CANCELLED on failure
    ld (UGCFG.TARGET),a
    ; A different harmless selector is a fence against an old matching echo
    ; (especially repeated E3/FWSTRING). No stream data is read until the
    ; transition to the requested selector is observed.
    or a
    ld a,0
    jr nz,.fence
    inc a
.fence:
    ld (UGCFG.SEL),a
    push bc
    push de
    push hl
    push ix
    push iy
    ld c,0x21
    rst 0x10
    ld a,b
    ld (UGCFG.SEC),a
    ld hl,0
    ld (UGCFG.COUNT),hl
    xor a
    ld (UGCFG.OUTERFAIL),a
.retry:
    IFDEF UG_CFG_POLL_HOOK
    call UG_CFG_POLL_HOOK
    jr c,.outer_fail
    ENDIF
    call UG_CFG_TRY
    jr nc,.matched
.poll:
    IFDEF UG_CFG_POLL_HOOK
    call UG_CFG_POLL_HOOK
    jr c,.outer_fail
    ENDIF
    ld c,0x31
    rst 0x10
    cp 27
    jr z,.cancel
    ld c,0x21
    rst 0x10
    ld a,(UGCFG.SEC)
    ld c,a
    ld a,b
    sub c
    jr nc,.elapsed
    add a,60
.elapsed:
    cp 3
    jr nc,.timeout
    ld hl,(UGCFG.COUNT)
    inc hl
    ld (UGCFG.COUNT),hl
    bit 5,h ; 8192 polls: finite even when DSS clock stops
    jr nz,.timeout
    ld a,l
    or a
    jr z,.retry
    call UG_CFG_PAUSE
    call UG_CFG_ECHO
    jr c,.poll
.matched:
    ld a,(UGCFG.TARGET)
    ld hl,UGCFG.SEL
    cp (hl)
    jr z,.success
    ld (hl),a
    jr .retry
.success:
    xor a
    jr .out
.cancel:
    ld a,UG_ERR_CANCELLED
    scf
    jr .out
.timeout:
    ld a,UG_ERR_TIMEOUT
    scf
    jr .out
    IFDEF UG_CFG_POLL_HOOK
.outer_fail:
    push af
    ld a,1
    ld (UGCFG.OUTERFAIL),a
    pop af
    ENDIF
.out:
    pop iy
    pop ix
    pop hl
    pop de
    pop bc
    ret
UG_CFG_TRY: ; one nonblocking attempt, selector already in UGCFG.SEL
    ld a,1
    ld (UGCFG.STAGE),a
    call UG_CFG_OPEN
    ld a,0xCC
    ld (0xC1D0),a
    call UG_CFG_CLOSE
    call UG_CFG_PAUSE
    ld a,2
    ld (UGCFG.STAGE),a
    call UG_CFG_OPEN
    ld a,(UGCFG.SEL)
    ld (0xC1D0),a
    call UG_CFG_CLOSE
    call UG_CFG_PAUSE
UG_CFG_ECHO:
    ld a,3
    ld (UGCFG.STAGE),a
    call UG_CFG_OPEN
    ld a,(0xC1D0)
    call UG_CFG_CLOSE
    ld (UGCFG.OBS),a
    push hl
    ld hl,UGCFG.SEL
    cp (hl)
    pop hl
    scf
    ret nz
    ld a,4
    ld (UGCFG.STAGE),a
    ; Permit the selected data path to settle before any consuming read.
    call UG_CFG_PAUSE
    xor a
    ret
UG_CFG_PAUSE:
    push bc
    ld b,0 ; 256 DJNZ iterations: 3323T >=158us at 21MHz
.loop:
    djnz .loop
    pop bc
    ret
UG_CFG_OPEN:
    push af
    push bc
    push hl
    ld a,(UGCTX.SLOT)
    ld hl,(UGCTX.BASE)
    call UG_ISA_OPEN
    pop hl
    pop bc
    pop af
    ret
UG_CFG_CLOSE:
    push af
    push bc
    call UG_ISA_CLOSE
    pop bc
    pop af
    ret
UG_CFG_READ8:
    call UG_CFG_SELECT
    ret c
UG_CFG_DATA8: ; selected stream: exactly one consuming read, no retry
    call UG_CFG_OPEN
    ld a,(0xC1D2)
    call UG_CFG_CLOSE
    or a
    ret
UG_CFG_READ16:
    call UG_CFG_SELECT
    ret c
    call UG_CFG_OPEN
    ld hl,(0xC1D1)
    call UG_CFG_CLOSE
    or a
    ret
    ENDIF
