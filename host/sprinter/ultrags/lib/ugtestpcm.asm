; SPDX-License-Identifier: GPL-2.0-or-later
; Standalone PCM/FX smoke on real API. Temporary asset and only owned IDs cleaned.
S6IDS EQU 0x5A00
S6PTR EQU S6IDS+10
S6N EQU S6IDS+12
S6TEST_INIT:
    ld hl,S6IDS
    ld de,S6IDS+1
    ld bc,15
    ld (hl),0
    ldir
    ret
S6TEST_RUN:
    ; ENTRY leaves CAPS in RESP. Reject unavailable suites before ALLOC.
    ld a,(RESP)
    and 32
    jp z,PROTOCOL
    ld a,(CMD)
    cp 9
    jr nz,.capable
    ld a,(RESP+1)
    and 1
    jp z,PROTOCOL
.capable:
    call BLOB_SETUP
    ld a,(RESP+7) ; INFO boot state from BLOB_SETUP
    or a
    jp nz,PROTOCOL
    ld a,80
    ld bc,0
    ld e,128
    call RPC
    jp c,RPC_ERROR
    ld a,(CMD)
    cp 8
    jr nz,.fxempty
    ld a,(RESP+24)
    dec a
    cp 2
    jp c,.busy
.fxempty:
    ld a,8
    ld (REQ),a
    ld a,4
    ld (REQ+1),a
    ld a,81
    ld bc,2
    ld e,66
    call RPC
    jp c,RPC_ERROR
    ld ix,RESP+2
    ld b,4
.check:
    ld a,(ix+6)
    or a
    jp nz,.busy
    ld de,16
    add ix,de
    djnz .check
    ld a,1
    ld (PCM_KIND),a
    ld hl,48000
    ld (PCM_DESC),hl
    ld a,1
    ld (PCM_DESC+4),a
    ld a,8
    ld (PCM_DESC+5),a
    ld hl,512
    ld (SIZE32),hl
    call PCM_PREFLIGHT
    call RESERVE
    call START_BLOCKS
    call NEXT_BLOCK
    call PATTERN
    call WRITE_BLOCK
    call PCM_CONFIGURE
    call SEAL_BLOB
    call SESSION_CHECK
    jp c,RPC_ERROR
    ld a,(CMD)
    cp 9
    jr z,.fx
    ld hl,(HANDLE)
    ld (REQ),hl
    ld hl,0
    ld (REQ+2),hl
    ld a,64
    ld (REQ+4),a
    ld a,128
    ld (REQ+5),a
    ld a,48
    ld bc,6
    ld e,2
    call RPC
    jp c,RPC_ERROR
    ld hl,(RESP)
    ld (S6IDS+8),hl
    call S6TEST_DRAIN
    ld a,1
    call .control
    call S6TEST_DRAIN
    ld a,(RESP+24)
    cp 2
    jp nz,VERIFY_ERROR
    ld a,2
    call .control
    call S6TEST_DRAIN
    ld a,(RESP+24)
    cp 1
    jp nz,VERIFY_ERROR
    ld hl,s6_pcm_pass
    call SHOW
    jp PASS
.control:
    ld (REQ+2),a
    ld hl,(S6IDS+8)
    ld (REQ),hl
    ld a,50
    ld bc,3
    ld e,0
    call RPC
    jp c,RPC_ERROR
    ret
.fx:
    ld hl,S6IDS
    ld (S6PTR),hl
    ld a,4
    ld (S6N),a
.start:
    call .playfx
    jp c,RPC_ERROR
    ld de,(RESP)
    ld hl,(S6PTR)
    ld (hl),e
    inc hl
    ld (hl),d
    inc hl
    ld (S6PTR),hl
    ld hl,S6N
    dec (hl)
    jr nz,.start
    call .playfx
    jp nc,VERIFY_ERROR
    cp UG_ERR_NO_VOICE
    jp nz,RPC_ERROR
    call S6TEST_DRAIN
    ld hl,s6_fx_pass
    call SHOW
    jp PASS
.playfx:
    call SESSION_CHECK
    jp c,RPC_ERROR
    ld hl,(HANDLE)
    ld (REQ),hl
    ld hl,0
    ld (REQ+2),hl
    ld a,128
    ld (REQ+4),a
    ld (REQ+6),a
    ld a,64
    ld (REQ+5),a
    ld a,2
    ld (REQ+7),a
    ld a,54
    ld bc,8
    ld e,4
    jp RPC
.busy:
    ld hl,busy_text
    ld (REASON),hl
    ld a,4
    jp EXIT
S6TEST_DRAIN:
    ; Multiple coherent reads allow accepted events to reach a render boundary.
    ld a,32
    ld (S6N),a
.loop:
    ld a,80
    ld bc,0
    ld e,128
    call RPC
    jp c,RPC_ERROR
    ld hl,S6N
    dec (hl)
    jr nz,.loop
    ret
S6TEST_CLEANUP:
    ld a,(OWN)
    or a
    ret z
    ld a,1
    ld (UGTM.NOESC),a
    call SESSION_CHECK
    ret c
    ; A PLAY may have been accepted without delivering its token. Drain the
    ; queue, then recover only instances referencing our private test asset.
    call .drain
    ret c
    ld hl,(RESP+28)
    ld de,(HANDLE)
    or a
    sbc hl,de
    jr nz,.fx_ids
    ld hl,(RESP+20)
    ld (S6IDS+8),hl
.fx_ids:
    ld a,8
    ld (REQ),a
    ld a,4
    ld (REQ+1),a
    ld a,81
    ld bc,2
    ld e,66
    call RPC
    ret c
    ld ix,RESP+2
    ld hl,S6IDS
    ld b,4
.recover:
    push hl
    ld e,(ix+4)
    ld d,(ix+5)
    ld hl,(HANDLE)
    or a
    sbc hl,de
    pop hl
    jr nz,.advance
    ld e,(ix+0)
    ld d,(ix+1)
    ld (hl),e
    inc hl
    ld (hl),d
    dec hl
.advance:
    inc hl
    inc hl
    ld de,16
    add ix,de
    djnz .recover
    call SESSION_CHECK
    ret c
    ld hl,S6IDS
    ld (S6PTR),hl
    ld a,5
    ld (S6N),a
.loop:
    ld hl,(S6PTR)
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (S6PTR),hl
    ld a,d
    or e
    jr z,.next
    ld (REQ),de
    xor a
    ld (REQ+2),a
    ld a,(S6N)
    cp 1
    ld a,57
    jr nz,.rpc
    ld a,50
.rpc:
    ld bc,3
    ld e,0
    call RPC
.next:
    ld hl,S6N
    dec (hl)
    jr nz,.loop
    ; Cleanup must never re-enter EXIT when a recovery query itself fails.
.drain:
    ld a,32
    ld (S6N),a
.drain_loop:
    ld a,80
    ld bc,0
    ld e,128
    call RPC
    ret c
    ld hl,S6N
    dec (hl)
    jr nz,.drain_loop
    ret
s6_pcm_pass: DB "PCM RAW/PLAY/PAUSE/RESUME PASS; audio REAL_PENDING",13,10,0
s6_fx_pass: DB "FX four independent lanes/NO_VOICE PASS; audio REAL_PENDING",13,10,0
