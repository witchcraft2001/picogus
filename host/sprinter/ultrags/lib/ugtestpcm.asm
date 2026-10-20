; SPDX-License-Identifier: GPL-2.0-or-later
; Temporary-asset PCM/FX and shared-pool stress. IDs, never voice masks.
S6IDS EQU 0x5A00                 ; up to256 owned FX IDs
S6FG EQU S6IDS+512
S6PTR EQU S6FG+2
S6LEFT EQU S6FG+4
S6CAP EQU S6FG+6
S6REQUEST EQU S6FG+8
S6SECONDS EQU S6FG+10
S6FIRST EQU S6FG+12
S6DRAIN EQU S6FG+14
S6SNAP EQU S6FG+16              ; 64-byte held summary
S6START EQU S6SNAP+64           ; output frame counter, modulo2^32
S6TARGET EQU S6START+4
S6BASELINE EQU S6TARGET+4       ; protocol/underrun/PSRAM counters
S6LAST EQU S6BASELINE+12
S6WATCH EQU S6LAST+4
S6SECOND EQU S6WATCH+2
S6OPTS EQU S6SECOND+2
S6RPCHECK EQU S6OPTS+1          ; 0=outside wrapper, 1=UG_RPC, 2=length check
S6RPCGOT EQU S6RPCHECK+1        ; wrapper-returned BC, FFFF before return
S6TEST_INIT:
    ld hl,S6IDS
    ld de,S6IDS+1
    ld bc,S6RPCGOT+1-S6IDS
    ld (hl),0
    ldir
    ld hl,60
    ld (S6SECONDS),hl
    ret
; HL option token. Only MIX accepts the options; final validation checks CMD.
S6TEST_OPTION:
    push hl
    ld de,s6_voice_prefix
    call PREFIX
    jr c,.seconds
    call NUMBER32
    pop hl
    ret c
    ld hl,(NUM32+2)
    ld a,h
    or l
    scf
    ret nz
    ld hl,(NUM32)
    ld a,h
    or l
    scf
    ret z
    ld de,257
    or a
    sbc hl,de
    ccf
    ret c
    ld hl,(NUM32)
    ld (S6REQUEST),hl
    ld a,(S6OPTS)
    bit 0,a
    scf
    ret nz
    or 1
    ld (S6OPTS),a
    xor a
    ret
.seconds:
    pop hl
    ld de,s6_seconds_prefix
    call PREFIX
    ret c
    call NUMBER32
    ret c
    ld hl,(NUM32+2)
    ld a,h
    or l
    scf
    ret nz
    ld hl,(NUM32)
    ld a,h
    or l
    scf
    ret z
    ld de,3601
    or a
    sbc hl,de
    ccf
    ret c
    ld hl,(NUM32)
    ld (S6SECONDS),hl
    ld a,(S6OPTS)
    bit 1,a
    scf
    ret nz
    or 2
    ld (S6OPTS),a
    xor a
    ret
S6TEST_VALIDATE:
    ld a,(S6OPTS)
    or a
    ret z
    ld a,(CMD)
    cp 10
    ret z
    scf
    ret
S6TEST_RUN:
    ld a,(RESP)
    and 32
    jp z,PROTOCOL
    ld a,(CMD)
    cp 8
    jr z,.audio_caps
    ld a,(RESP+1)
    and 1
    jp z,PROTOCOL
.audio_caps:
    ld hl,(RESP+20)
    ld (S6CAP),hl
    ld a,h
    or l
    jp z,PROTOCOL
    ld de,257
    or a
    sbc hl,de
    jp nc,PROTOCOL
    call BLOB_SETUP
    ld a,(RESP+7)
    or a
    jp nz,PROTOCOL
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
    ld hl,(S6REQUEST)
    ld a,h
    or l
    jr nz,.requested
    ld hl,(S6CAP)
.requested:
    ld (S6REQUEST),hl
    ld de,(S6CAP)
    or a
    sbc hl,de
    jp c,.capacity
    jp nz,PROTOCOL
.capacity:
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
    cp 8
    jp nz,.effects
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
    ld (S6FG),hl
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
    ld hl,(S6FG)
    ld (REQ),hl
    ld a,50
    ld bc,3
    ld e,0
    call RPC
    jp c,RPC_ERROR
    ret
.effects:
    ld hl,S6IDS
    ld (S6PTR),hl
    ld hl,(S6REQUEST)
    ld (S6LEFT),hl
.start:
    call S6TEST_PLAY_FX
    jp c,RPC_ERROR
    ld de,(RESP)
    ld hl,(S6PTR)
    ld (hl),e
    inc hl
    ld (hl),d
    inc hl
    ld (S6PTR),hl
    call S6TEST_DRAIN
    ld hl,(S6LEFT)
    dec hl
    ld (S6LEFT),hl
    ld a,h
    or l
    jr nz,.start
    ld a,(CMD)
    cp 10
    jp z,S6TEST_MIX
    call S6TEST_PLAY_FX
    jp nc,VERIFY_ERROR
    cp UG_ERR_NO_VOICE
    jp nz,RPC_ERROR
    ld hl,s6_fx_pass
    call SHOW
    jp PASS
S6TEST_PLAY_FX:
    call SESSION_CHECK
    ret c
    ld hl,(HANDLE)
    ld (REQ),hl
    ld hl,0xFFFF
    ld (REQ+2),hl
    ld a,128
    ld (REQ+4),a
    ld (REQ+6),a
    ld a,1                    ; test assets deliberately avoid32-voice clipping
    ld (REQ+5),a
    ld a,2
    ld (REQ+7),a
    ld a,54
    ld bc,8
    ld e,4
    jp RPC
S6TEST_SNAPSHOT:
    ld a,80
    ld bc,0
    ld e,64
    call RPC
    ret c
    ld hl,RESP
    ld de,S6SNAP
    ld bc,64
    ldir
    ret
; Only RAM reads, before cleanup overwrites UGREQ.FRAME. No extra ISA traffic.
; wrapper=1: UG_RPC failed (got=FFFF); wrapper=2: wrapper length mismatch.
; wrapper=0: direct library failure, expected/got are not applicable.
S6TEST_RPC_DIAG:
    ld hl,s6_rpc_diag
    call SHOW
    ld a,(UGREQ.OP)
    call HEX8
    ld hl,s6_rpc_header
    call SHOW
    ld a,(UGREQ.FRAME)
    call HEX8
    ld a,':'
    call OUTCHAR
    ld a,(UGREQ.FRAME+1)
    call HEX8
    ld hl,s6_rpc_wrapper
    call SHOW
    ld a,(S6RPCHECK)
    call HEX8
    ld a,(S6RPCHECK)
    or a
    jr z,.done
    ld hl,s6_rpc_expected
    call SHOW
    ld a,(EXPECT)
    call HEX8
    ld hl,s6_rpc_got
    call SHOW
    ld hl,(S6RPCGOT)
    ld a,h
    call HEX8
    ld a,l
    call HEX8
.done:
    jp NL
S6TEST_DRAIN:
    ld a,32
    ld (S6DRAIN),a
.loop:
    call S6TEST_SNAPSHOT
    jp c,RPC_ERROR
    ld hl,S6DRAIN
    dec (hl)
    jr nz,.loop
    ret
S6TEST_BUSY:
    ld hl,busy_text
    ld (REASON),hl
    ld a,4
    jp EXIT
S6TEST_MIX:
    call S6TEST_SNAPSHOT
    jp c,RPC_ERROR
    ld hl,RESP+12
    ld de,S6START
    ld bc,4
    ldir
    ld hl,0
    ld (S6TARGET),hl
    ld (S6TARGET+2),hl
    ld (S6WATCH),hl
    ld de,(S6SECONDS)
.target:
    ld hl,(S6TARGET)
    ld bc,48000
    add hl,bc
    ld (S6TARGET),hl
    ld hl,(S6TARGET+2)
    ld bc,0
    adc hl,bc
    ld (S6TARGET+2),hl
    dec de
    ld a,d
    or e
    jr nz,.target
    ld a,3
    ld bc,0
    ld e,64
    call RPC
    jp c,RPC_ERROR
    ld hl,RESP+28
    ld de,S6BASELINE
    ld bc,4
    ldir
    ld hl,RESP+36
    ld bc,8
    ldir
.loop:
    call S6TEST_SNAPSHOT
    jp c,RPC_ERROR
    ld hl,(RESP+12)
    ld de,(S6START)
    or a
    sbc hl,de
    ld (NUM32),hl
    ld hl,(RESP+14)
    ld de,(S6START+2)
    sbc hl,de
    ld (NUM32+2),hl
    ld de,(S6TARGET+2)
    or a
    sbc hl,de
    jr c,.more
    jp nz,.done
    ld hl,(NUM32)
    ld de,(S6TARGET)
    or a
    sbc hl,de
    jp nc,.done
.more:
    ; A repeated verified read of our playing asset exercises the background
    ; transfer without altering another object or restarting playback.
    ld a,1
    ld (VERIFY),a
    call READ_BLOCK
    ld a,3
    ld bc,0
    ld e,64
    call RPC
    jp c,RPC_ERROR
    ld hl,RESP+28
    ld de,S6BASELINE
    ld b,4
    call .same
    ld hl,RESP+36
    ld b,8
    call .same
    ld hl,(S6WATCH)
    inc hl
    ld (S6WATCH),hl
    ld a,h
    cp 4
    jp nc,.timeout
    ld hl,(NUM32)
    ld de,(S6LAST)
    or a
    sbc hl,de
    jr nz,.progress
    ld hl,(NUM32+2)
    ld de,(S6LAST+2)
    or a
    sbc hl,de
    jp z,.loop
.progress:
    ld hl,NUM32
    ld de,S6LAST
    ld bc,4
    ldir
    ld hl,0
    ld (S6WATCH),hl
    jp .loop
.timeout:
    ld hl,s6_timeout_text
    ld (REASON),hl
    ld a,8
    jp EXIT
.same:
    ld a,(de)
    cp (hl)
    jp nz,VERIFY_ERROR
    inc hl
    inc de
    djnz .same
    ret
.done:
    ld hl,s6_mix_pass
    call SHOW
    jp PASS
S6TEST_CLEANUP:
    ld a,(OWN)
    or a
    ret z
    ld a,1
    ld (UGTM.NOESC),a
    call SESSION_CHECK
    ret c
    call .drain
    ret c
    ld hl,(RESP+28)
    ld de,(HANDLE)
    or a
    sbc hl,de
    jr nz,.pages
    ld hl,(RESP+20)
    ld (S6FG),hl
.pages:
    ld hl,0
    ld (S6FIRST),hl
    ld hl,S6IDS
    ld (S6PTR),hl
.page:
    ld hl,S6SNAP+4
    ld de,REQ
    ld bc,8
    ldir
    ld hl,S6SNAP
    ld bc,4
    ldir
    ld hl,(S6FIRST)
    ld (REQ+12),hl
    ld hl,6
    ld (REQ+14),hl
    ld a,81
    ld hl,REQ
    ld de,RESP
    ld ix,128
    ld bc,16
    call UG_RPC
    ret c
    call S6TEST_PAGE_VALIDATE
    ret c
    ld a,(RESP+14)
    ld b,a
    or a
    jr z,.stop
    ld ix,RESP+20
.recover:
    ld l,(ix+4)
    ld h,(ix+5)
    ld de,(HANDLE)
    or a
    sbc hl,de
    jr nz,.advance
    ld hl,(S6PTR)
    ld a,(ix+0)
    ld (hl),a
    inc hl
    ld a,(ix+1)
    ld (hl),a
    inc hl
    ld (S6PTR),hl
.advance:
    ld de,16
    add ix,de
    djnz .recover
    ld hl,(S6FIRST)
    ld de,(RESP+14)
    add hl,de
    ld (S6FIRST),hl
    ld de,(RESP+16)
    or a
    sbc hl,de
    jp c,.page
.stop:
    ld hl,(S6PTR)
    ld de,S6IDS
    or a
    sbc hl,de
    srl h
    rr l
    ld (S6LEFT),hl
    ld hl,S6IDS
    ld (S6PTR),hl
.loop:
    ld hl,(S6LEFT)
    ld a,h
    or l
    jr z,.foreground
    dec hl
    ld (S6LEFT),hl
    ld hl,(S6PTR)
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (S6PTR),hl
    ld (REQ),de
    xor a
    ld (REQ+2),a
    ld a,57
    ld bc,3
    ld e,0
    call RPC
    jp .loop
.foreground:
    ld hl,(S6FG)
    ld a,h
    or l
    jr z,.drain
    ld (REQ),hl
    xor a
    ld (REQ+2),a
    ld a,50
    ld bc,3
    ld e,0
    call RPC
.drain:
    ld a,32
    ld (S6DRAIN),a
.drain_loop:
    call S6TEST_SNAPSHOT
    ret c
    ld hl,S6DRAIN
    dec (hl)
    jr nz,.drain_loop
    ret
S6TEST_PAGE_VALIDATE:
    ld a,b
    or a
    jr nz,.bad
    ld a,c
    ld (S6SECOND),a
    cp 20
    jr c,.bad
    ld hl,REQ
    ld de,RESP
    ld b,14
.key:
    ld a,(de)
    cp (hl)
    jr nz,.bad
    inc hl
    inc de
    djnz .key
    ld hl,(RESP+18)
    ld de,16
    or a
    sbc hl,de
    jr nz,.bad
    ld hl,(RESP+16)
    ld de,(S6CAP)
    or a
    sbc hl,de
    jr c,.total
    jr nz,.bad
.total:
    ld hl,(RESP+14)
    ld a,h
    or a
    jr nz,.bad
    ld a,l
    cp 7
    jr nc,.bad
    add a,a
    add a,a
    add a,a
    add a,a
    add a,20
    ld hl,S6SECOND
    cp (hl)
    jr nz,.bad
    ld hl,(S6FIRST)
    ld de,(RESP+14)
    add hl,de
    jr c,.bad
    ld de,(RESP+16)
    or a
    sbc hl,de
    jr c,.more
    jr nz,.bad
    xor a
    ret
.more:
    ld hl,(RESP+14)
    ld a,h
    or l
    ret nz
.bad:
    scf
    ret
s6_voice_prefix: DB "/VOICES:",0
s6_seconds_prefix: DB "/SECONDS:",0
s6_pcm_pass: DB "PCM RAW/PLAY/PAUSE/RESUME PASS; audio REAL_PENDING",13,10,0
s6_fx_pass: DB "FX shared pool/NO_VOICE PASS; audio REAL_PENDING",13,10,0
s6_mix_pass: DB "MIX requested voices/background VERIFY PASS; audio REAL_PENDING",13,10,0

s6_timeout_text: DB "OUTPUT_CLOCK_STOPPED",0
s6_rpc_diag: DB "UGTEST-D2 rpc_op=0x",0
s6_rpc_header: DB " frame_status:len=0x",0
s6_rpc_wrapper: DB " wrapper=0x",0
s6_rpc_expected: DB " expected=0x",0
s6_rpc_got: DB " got=0x",0
