; SPDX-License-Identifier: GPL-2.0-or-later
; S8a owned assets. Existing foreground is never stopped by concurrent FX tests.
S8MODE EQU 0x5E00
S8COUNT EQU S8MODE+1
S8HANDLES EQU S8MODE+2           ; at most 4 FX + one background object
S8CH EQU S8MODE+12
S8INDEX EQU S8MODE+13
S8MUSIC EQU S8MODE+14
S8PLAY EQU S8MODE+16
S8WORK EQU S8MODE+18
S8ELAPSED EQU S8MODE+20
S8SOURCE EQU S8MODE+24
S8CLEAN EQU S8MODE+26
S8PERIOD EQU S8MODE+27
S8TEST_INIT:
    xor a
    ld (S8MODE),a
    ld (S8COUNT),a
    ret
S8TEST_MOD:
    ld a,(RESP+4)
    and 16
    jp z,PROTOCOL
    ld hl,(RESP+20)
    ld (S6CAP),hl
    call BLOB_SETUP
    call S6TEST_SNAPSHOT
    jp c,RPC_ERROR
    ld a,(RESP+24)
    dec a
    cp 2
    jp c,S6TEST_BUSY
    ld hl,(RESP+54)
    ld a,h
    or l
    jp nz,S6TEST_BUSY
    ld a,2
    ld (S8MODE),a
    ld a,3
    ld (PCM_KIND),a
    ld hl,S8MOD_END-S8MOD_DATA
    ld (SIZE32),hl
    ld hl,0
    ld (SIZE32+2),hl
    call S8TEST_RESERVE
    ld hl,S8MOD_DATA
    ld (S8SOURCE),hl
    call START_BLOCKS
.upload:
    call NEXT_BLOCK
    jr z,.sealed
    ld hl,(S8SOURCE)
    ld de,BUF
    ld bc,(BLOCK)
    ldir
    ld (S8SOURCE),hl
    call FOLD_FILE
    call WRITE_BLOCK
    call ADVANCE
    jr .upload
.sealed:
    call SEAL_BLOB
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,1
    ld (REQ+2),a
    ld a,49
    ld bc,3
    ld e,2
    call RPC
    jp c,RPC_ERROR
    ld hl,(RESP)
    ld (S8PLAY),hl
    call S6TEST_DRAIN
    call S8TEST_CHECK_MUSIC
    xor a
    ld (S8INDEX),a
.voices:
    ld hl,S6SNAP+4
    ld de,REQ
    ld bc,8
    ldir
    ld hl,S6SNAP
    ld bc,4
    ldir
    ld a,(S8INDEX)
    ld l,a
    ld h,0
    ld (REQ+12),hl
    ld hl,1
    ld (REQ+14),hl
    ld a,82
    ld bc,16
    ld e,40
    call RPC
    jp c,RPC_ERROR
    ld a,(S8INDEX)
    ld hl,RESP+26
    cp (hl)
    jp nz,VERIFY_ERROR
    ld a,(RESP+27)
    or a
    jp nz,VERIFY_ERROR
    ld a,(RESP+36)
    cp 127
    jp z,VERIFY_ERROR
    ld a,(RESP+39)
    and 9
    cp 9
    jp nz,VERIFY_ERROR
    ld hl,S8INDEX
    inc (hl)
    ld a,(hl)
    cp 8
    jr c,.voices
    ld a,1
    call S8TEST_CONTROL
    call S6TEST_DRAIN
    ld a,(RESP+24)
    cp 2
    jp nz,VERIFY_ERROR
    ld a,2
    call S8TEST_CONTROL
    call S6TEST_DRAIN
    call S8TEST_CHECK_MUSIC
    ld hl,s8_mod_pass
    call SHOW
    jp PASS
S8TEST_CONTROL:
    ld (REQ+2),a
    ld hl,(S8PLAY)
    ld (REQ),hl
    ld a,50
    ld bc,3
    ld e,0
    call RPC
    jp c,RPC_ERROR
    ret
; Called with the snapshot already taken by the existing FX entry.
S8TEST_FX:
    ld a,(RESP+25)
    cp 2
    jp nz,S6TEST_BUSY
    ld hl,(RESP+26)
    ld de,8
    or a
    sbc hl,de
    jp nz,S6TEST_BUSY
    ld hl,(RESP+20)
    ld (S8PLAY),hl
    ld hl,(RESP+28)
    ld (S8MUSIC),hl
    ld a,1
    ld (S8MODE),a
    ld (S8CH),a
S8TEST_PHASE:
    xor a
    ld (S8INDEX),a
.asset:
    ld a,1
    ld (PCM_KIND),a
    ld hl,1024
    ld (SIZE32),hl
    ld hl,0
    ld (SIZE32+2),hl
    call S8TEST_RESERVE
    call START_BLOCKS
    call NEXT_BLOCK
    ; 512 signed16 samples, periods64/128/256/512 across four mono assets.
    ld a,(S8INDEX)
    ld b,a
    ld a,32
    inc b
.period:
    dec b
    jr z,.period_done
    add a,a
    jr .period
.period_done:
    ld (S8PERIOD),a
    ld e,a
    ld d,0
    ld hl,BUF
    ld bc,512
.tone:
    ld a,d
    or a
    ld a,8
    jr z,.value
    ld a,0xF8
.value:
    ld (hl),0
    inc hl
    ld (hl),a
    ld a,(S8CH)
    cp 2
    jr nz,.signed_done
    ld a,c
    and 1
    jr z,.signed_done
    ld a,(hl)
    neg
    ld (hl),a
.signed_done:
    inc hl
    dec e
    jr nz,.sample_done
    ld a,(S8PERIOD)
    ld e,a
    ld a,d
    xor 1
    ld d,a
.sample_done:
    dec bc
    ld a,b
    or c
    jr nz,.tone
    call FOLD_FILE
    call WRITE_BLOCK
    ld hl,PCM_DESC
    ld de,PCM_DESC+1
    ld bc,23
    ld (hl),0
    ldir
    ld hl,48000
    ld (PCM_DESC),hl
    ld a,(S8CH)
    ld (PCM_DESC+4),a
    ld a,16
    ld (PCM_DESC+5),a
    ld a,2
    ld (PCM_DESC+6),a
    ld hl,1024
    ld (PCM_DESC+12),hl
    call PCM_CONFIGURE
    call SEAL_BLOB
    call S6TEST_PLAY_FX
    jp c,RPC_ERROR
    ; Pause/resume only the just-created instance; keep its ID in SRAM.
    ld hl,(RESP)
    ld (S8WORK),hl
    ld (REQ),hl
    ld a,1
    ld (REQ+2),a
    call .control_fx
    ld hl,(S8WORK)
    ld (REQ),hl
    ld a,2
    ld (REQ+2),a
    call .control_fx
    ld hl,S8INDEX
    inc (hl)
    ld a,(S8CH)
    cp 2
    ld a,4
    jr nz,.count
    ld a,2
.count:
    cp (hl)
    jp nz,.asset
    call S6TEST_DRAIN
    call S8TEST_CHECK_MUSIC
    jp S6TEST_MIX
.control_fx:
    ld a,57
    ld bc,3
    ld e,0
    call RPC
    jp c,RPC_ERROR
    ret
S8TEST_CHECK_MUSIC:
    ld a,(RESP+24)
    cp 1
    jp nz,VERIFY_ERROR
    ld a,(RESP+25)
    cp 2
    jp nz,VERIFY_ERROR
    ld hl,(RESP+20)
    ld de,(S8PLAY)
    or a
    sbc hl,de
    jp nz,VERIFY_ERROR
    ld hl,(RESP+26)
    ld de,8
    or a
    sbc hl,de
    jp nz,VERIFY_ERROR
    ret
S8TEST_BACKGROUND:
    ld hl,NUM32
    ld de,S8ELAPSED
    ld bc,4
    ldir
    call S8TEST_CHECK_MUSIC
    xor a
    ld (PCM_KIND),a
    ld hl,1024
    ld (SIZE32),hl
    ld hl,0
    ld (SIZE32+2),hl
    call S8TEST_RESERVE
    call START_BLOCKS
    call NEXT_BLOCK
    call PATTERN
    call FOLD_FILE
    call WRITE_BLOCK
    call SEAL_BLOB
    call READ_BLOCK
    ld hl,BUF
    ld de,BACK
    ld bc,1024
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
    ld hl,(HANDLE)
    ld (S8WORK),hl
    ; Read source bytes of the playing module through the same transfer API.
    ld hl,(S8MUSIC)
    ld (HANDLE),hl
    call READ_BLOCK
    ld hl,(S8WORK)
    ld (HANDLE),hl
    ld (REQ),hl
    ld a,17
    ld bc,2
    ld e,0
    call RPC
    jp c,RPC_ERROR
    ld hl,S8COUNT
    dec (hl)
    xor a
    ld (OWN),a
    ld hl,S8ELAPSED
    ld de,NUM32
    ld bc,4
    ldir
    ret
S8TEST_NEXT_PHASE:
    ld hl,s8_phase_pass
    call SHOW
    ld a,(S8CH)
    ld l,a
    ld h,0
    call DEC16
    call NL
    call S8TEST_CLEANUP
    ld a,(S8CH)
    cp 2
    jp z,PASS
    ld a,2
    ld (S8CH),a
    ld a,1
    ld (S8MODE),a
    xor a
    ld (UGTM.NOESC),a
    jp S8TEST_PHASE
S8TEST_RESERVE:
    call RESERVE
    ld a,(S8COUNT)
    cp 5
    jp nc,VERIFY_ERROR
    add a,a
    ld e,a
    ld d,0
    ld hl,S8HANDLES
    add hl,de
    ld de,(HANDLE)
    ld (hl),e
    inc hl
    ld (hl),d
    ld hl,S8COUNT
    inc (hl)
    ret
S8TEST_CLEANUP:
    ld a,(S8MODE)
    or a
    ret z
    xor a
    ld (S8CLEAN),a
.loop:
    ld a,(S8CLEAN)
    ld hl,S8COUNT
    cp (hl)
    jr nc,.done
    add a,a
    ld e,a
    ld d,0
    ld hl,S8HANDLES
    add hl,de
    ld e,(hl)
    inc hl
    ld d,(hl)
    ld (HANDLE),de
    ld a,1
    ld (OWN),a
    ld hl,0
    ld (S6FG),hl
    call S6TEST_CLEANUP
    call BLOB_CLEANUP
    ld hl,S8CLEAN
    inc (hl)
    jr .loop
.done:
    xor a
    ld (OWN),a
    ld (S8MODE),a
    ld (S8COUNT),a
    ret
s8_mod_pass: DB "MOD8 eight channels/pause/resume PASS; audio REAL_PENDING",13,10,0
s8_phase_pass: DB "MOD8+FX/background PASS channels_per_FX=",0
    INCLUDE "ugtestmod8_data.inc"
