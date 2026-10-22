; SPDX-License-Identifier: GPL-2.0-or-later
; S8b uses only the existing private header/BUF/BACK and owned-asset cleanup.
; The 7484-byte module never resides in DSS RAM as a whole.
S8B_BUILD:
    ld hl,S8MOD_DATA+42
    ld b,8
.headers:
    ld (hl),0
    inc hl
    ld (hl),16
    inc hl
    ld (hl),0
    inc hl
    ld (hl),12
    inc hl
    ld (hl),0
    inc hl
    ld (hl),0
    inc hl
    ld (hl),0
    inc hl
    ld (hl),16
    ld de,23
    add hl,de
    djnz .headers
    ld a,6
    ld (S8MOD_DATA+950),a
    ld hl,S8MOD_DATA+952
    xor a
.orders:
    ld (hl),a
    inc hl
    inc a
    cp 6
    jr c,.orders
    ld hl,s8b_signature
    ld de,S8MOD_DATA+1080
    ld bc,4
    ldir
    ret
; Fill exactly BLOCK bytes at POS32; generation is independent of packet cap.
S8B_FILL:
    ld hl,(POS32)
    ld de,BUF
    ld bc,(BLOCK)
.loop:
    push bc
    push de
    push hl
    call S8B_BYTE
    pop hl
    pop de
    pop bc
    ld (de),a
    inc hl
    inc de
    dec bc
    ld a,b
    or c
    jr nz,.loop
    ret
S8B_BYTE:
    ld de,1084
    or a
    sbc hl,de
    jr nc,.body
    add hl,de
    ld de,S8MOD_DATA
    add hl,de
    ld a,(hl)
    ret
.body:
    ld a,h
    cp 24                     ; 6144 pattern bytes
    jr nc,.sample
    ld e,l
    ld a,h
    and 3
    or a
    jr nz,.last_row
    ld a,l
    and 0xF0
    jr z,.event
    xor a
    ret
.last_row:
    cp 3
    jr nz,.zero
    ld a,l
    and 0xF0
    cp 0xF0
    jr nz,.zero
.event:
    ; C=channel, B=pair*8 plus row63 adjustment, E=event byte index.
    ld a,h
    and 4
    ld c,a
    ld a,l
    rrca
    rrca
    and 3
    or c
    ld c,a
    ld a,h
    and 0x18
    ld b,a
    ld a,l
    and 0xF0
    jr z,.first
    inc b
.first:
    ld a,e
    and 3
    jr z,.period_high
    cp 1
    jr z,.period_low
    cp 2
    jr nz,.zero
    ld a,c
    inc a
    rlca
    rlca
    rlca
    rlca
    ret
.period_high:
    call S8B_PERIOD
    ld a,h
    ret
.period_low:
    call S8B_PERIOD
    ld a,l
    ret
.zero:
    xor a
    ret
.sample:
    ld a,l
    and 0xE0
    rrca
    rrca
    rrca                       ; channel*4
    add a,24
    bit 4,l
    ret z
    neg
    ret
S8B_PERIOD:
    ld hl,856
    ld de,30
    ld a,c
    or a
    jr z,.pair
.channel:
    or a
    sbc hl,de
    dec a
    jr nz,.channel
.pair:
    ld e,b
    ld d,0
    or a
    sbc hl,de
    ret
S8B_CHECK_VOICE:
    ld a,(S8INDEX)
    ld c,a
    ld b,0
    call S8B_PERIOD
    ld de,(RESP+34)
    or a
    sbc hl,de
    jp nz,VERIFY_ERROR
    ret
S8B_FINISH:
    xor a
    ld (S8ORDER),a
.next_pair:
    ld hl,(S8PLAY)
    ld (REQ),hl
    ld a,(S8ORDER)
    ld l,a
    ld h,0
    ld (REQ+2),hl
    ld a,63
    ld (REQ+4),a
    ld a,51
    ld bc,5
    ld e,0
    call RPC
    jp c,RPC_ERROR
    ; Bound the outer poll too: RPC's own deadline restarts at every snapshot.
    ld hl,8192
    ld (S8WAIT),hl
.wait:
    ld c,0x31
    rst 0x10
    cp 27
    jp z,CANCEL_APP
    call S6TEST_SNAPSHOT
    jp c,RPC_ERROR
    call S8TEST_CHECK_MUSIC
    ld a,(S8ORDER)
    ld hl,RESP+36
    cp (hl)
    jr nz,.transition
    ld hl,(S8WAIT)
    dec hl
    ld (S8WAIT),hl
    ld a,h
    or l
    jr nz,.wait
    ld a,8
    jp EXIT
.transition:
    inc a
    cp 6
    jr c,.expected
    xor a
.expected:
    cp (hl)
    jp nz,VERIFY_ERROR
    ld hl,S8ORDER
    inc (hl)
    ld a,(hl)
    cp 6
    jr c,.next_pair
    ; Full readback AFTER playback, including header, both halves and samples.
    call START_BLOCKS
.readback:
    call NEXT_BLOCK
    jr z,.done
    call S8B_FILL
    call READ_BLOCK
    ld hl,BUF
    ld de,BACK
    ld bc,(BLOCK)
.compare:
    ld a,(de)
    cp (hl)
    jp nz,VERIFY_ERROR
    inc hl
    inc de
    dec bc
    ld a,b
    or c
    jr nz,.compare
    call ADVANCE
    jr .readback
.done:
    ld hl,s8b_pass
    call SHOW
    jp PASS
s8b_signature: DB "FLT8"
s8b_pass: DB "FLT8 eight distinct channels/three pairs/odd orders/pause/resume/readback PASS; audio REAL_PENDING",13,10,0
