; SPDX-License-Identifier: GPL-2.0-or-later
; FM windows contain one register/value pair. DSS runs only after close.
OPLWINDOW: DB 0
OPLTURBO: DB 1
OPLFX: DB 1
OPLOWN: DB 0
OPLCHANNEL: DB 0
OPLSECOND: DB 0
OPLELAPSED: DW 0
OPLSTAGNANT: DS 3,0
OPLOPENSTAGE: DB 0
OPLOPENVALUES: DS 5,0xFF
OPLPHASE: DB 0
OPLCAPS: DS 4,0xFF
OPLTIMERSTAGE: DB 0
OPLTIMERVALUES: DB 0xFF,0xFF,0xFF
OPL_INIT:
    xor a
    ld (OPLOWN),a
    ld (OPLWINDOW),a
    ld (OPLPHASE),a
    ld (OPLOPENSTAGE),a
    ld (OPLTIMERSTAGE),a
    dec a
    ld (OPLTIMERVALUES),a
    ld (OPLTIMERVALUES+1),a
    ld (OPLTIMERVALUES+2),a
    ld (OPLCAPS),a
    ld (OPLCAPS+1),a
    ld (OPLCAPS+2),a
    ld (OPLCAPS+3),a
    ld (OPLOPENVALUES),a
    ld (OPLOPENVALUES+1),a
    ld (OPLOPENVALUES+2),a
    ld (OPLOPENVALUES+3),a
    ld (OPLOPENVALUES+4),a
    ld a,1
    ; Never interpret unverified INFO/CAPS bytes as capabilities.
    ld (VERIFY),a
    ld (OPLTURBO),a
    ld (OPLFX),a
    ld hl,10
    ld (S6SECONDS),hl
    ret
OPL_PARSE:
    ld a,(ARGC)
    cp 1
    scf
    ret nz
    ld hl,(ARGS)
    ld de,opl_test
    call EQUAL
    ld a,8
    jr z,.ok
    ld hl,(ARGS)
    ld de,opl_mix
    call EQUAL
    scf
    ret nz
    ld a,10
.ok:
    ld (CMD),a
    xor a
    ret
OPL_VALIDATE:
    ld a,(S6OPTS)
    and 0xFD
    scf
    ret nz
    ld a,(GTRESET)
    or a
    scf
    ret nz
    ld hl,(S6SECONDS)
    ld de,1801
    or a
    sbc hl,de
    ccf
    ret
OPL_OPTION:
    push hl
    ld de,opl_turbo_on
    call EQUAL
    pop hl
    ld a,1
    jr z,.turbo
    push hl
    ld de,opl_turbo_off
    call EQUAL
    pop hl
    ld a,0
    jr z,.turbo
    push hl
    ld de,opl_mono
    call EQUAL
    pop hl
    ld a,1
    jr z,.fx
    ld de,opl_stereo
    call EQUAL
    ld a,2
    jr z,.fx
    scf
    ret
.turbo:
    ld (OPLTURBO),a
    xor a
    ret
.fx:
    ld (OPLFX),a
    xor a
    ret
OPL_OPEN:
    ld a,(OPLTURBO)
    ld (OPLWINDOW),a
    ld a,(SLOT)
    ld hl,0x388
    jp UG_ISA_OPEN
OPL_CLOSE:
    call UG_ISA_CLOSE
    xor a
    ld (OPLWINDOW),a
    ret
; A=register E=value; preserve registers for bounded programming loops.
OPL_WRITE:
    push af
    push bc
    push de
    push hl
    push af
    call OPL_OPEN
    pop af
    ld (0xC388),a
    ld b,6
.address_delay:
    ld a,(0xC388)
    djnz .address_delay
    ld a,e
    ld (0xC389),a
    ld b,36
.data_delay:
    ld a,(0xC388)
    djnz .data_delay
    call OPL_CLOSE
    pop hl
    pop de
    pop bc
    pop af
    ret
OPL_STATUS:
    call OPL_OPEN
    ld a,(0xC388)
    push af
    call OPL_CLOSE
    pop af
    ret
OPL_RUN:
    ld a,8
    ld (OPLPHASE),a
    ld a,(RESP+1)
    and 32
    jp z,OPL_CAP_MISSING
    ; Refuse occupied foreground before altering FM or allocating objects.
    ld a,9
    ld (OPLPHASE),a
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
    ld a,1
    ld (OPLOWN),a
    ld a,10
    ld (OPLPHASE),a
    ld a,4
    ld e,0x60
    call OPL_WRITE
    ld e,0x80
    call OPL_WRITE
    ld a,1
    ld (OPLTIMERSTAGE),a
    call OPL_STATUS
    ld (OPLTIMERVALUES),a
    and 0xE0
    jp nz,OPL_TIMER_FAIL
    ld a,2
    ld e,255
    call OPL_WRITE
    ld a,4
    ld e,0x21
    call OPL_WRITE
    ld a,2
    ld (OPLTIMERSTAGE),a
    ld b,8
.timer1:
    push bc
    call OPL_STATUS
    pop bc
    djnz .timer1
    ld (OPLTIMERVALUES+1),a
    and 0xE0
    cp 0xC0
    jp nz,OPL_TIMER_FAIL
    ld a,4
    ld e,0x60
    call OPL_WRITE
    ld e,0x80
    call OPL_WRITE
    ld a,3
    ld e,255
    call OPL_WRITE
    ld a,4
    ld e,0x42
    call OPL_WRITE
    ld a,3
    ld (OPLTIMERSTAGE),a
    ; At least320us even in Turbo:32 bounded status windows.
    ld b,32
.timer2:
    push bc
    call OPL_STATUS
    pop bc
    djnz .timer2
    ld (OPLTIMERVALUES+2),a
    and 0xE0
    cp 0xA0
    jp nz,OPL_TIMER_FAIL
    ld a,4
    ld e,0x60
    call OPL_WRITE
    ld e,0x80
    call OPL_WRITE
    ld a,11
    ld (OPLPHASE),a
    ld a,1
    ld e,32
    call OPL_WRITE
    ; A previous AdLib client may have left rhythm, NOTE-SEL, waveform or
    ; feedback/additive settings. Establish the complete test instrument.
    ld a,8
    ld e,0
    call OPL_WRITE
    ld a,0xBD
    call OPL_WRITE
    ld a,0xB0
    ld b,9
.reset_channels:
    call OPL_WRITE
    add a,0x10
    call OPL_WRITE
    sub 0x0F
    djnz .reset_channels
    ld hl,opl_operators
    ld b,18
.operators:
    ld a,(hl)
    add a,0x20
    ld e,0x21
    call OPL_WRITE
    ld a,(hl)
    add a,0x40
    ld e,24
    call OPL_WRITE
    ld a,(hl)
    add a,0x60
    ld e,0xF3
    call OPL_WRITE
    ld a,(hl)
    add a,0x80
    ld e,0x35
    call OPL_WRITE
    ld a,(hl)
    add a,0xE0
    ld e,0
    call OPL_WRITE
    inc hl
    djnz .operators
    ld b,9
    ld a,0xA0
    ld hl,opl_frequencies
.notes:
    ld e,(hl)
    inc hl
    call OPL_WRITE
    add a,0x10
    ld e,0x31
    call OPL_WRITE
    sub 0x0F
    djnz .notes
    ld a,(CMD)
    cp 10
    jr nz,.test
    ld a,1
    ld bc,0
    ld e,44
    call RPC
    jp c,RPC_ERROR
    jp S8TEST_MOD
.test:
    call BLOB_SETUP
    ld hl,0
    ld (OPLELAPSED),hl
    ld (OPLSTAGNANT),hl
    xor a
    ld (OPLSTAGNANT+2),a
    ld c,0x21
    rst 0x10
    ld a,b
    ld (OPLSECOND),a
.wait:
    ld c,0x31
    rst 0x10
    cp 27
    jr nz,.clock
    ld a,10
    jp EXIT
.clock:
    ld c,0x21
    rst 0x10
    ld a,(OPLSECOND)
    ld c,a
    ld a,b
    ld (OPLSECOND),a
    sub c
    jr nc,.delta
    add a,60
.delta:
    or a
    jr z,.stagnant
    ld e,a
    ld d,0
    ld hl,(OPLELAPSED)
    add hl,de
    ld (OPLELAPSED),hl
    ld de,(S6SECONDS)
    or a
    sbc hl,de
    jp nc,PASS
    ; Alternate melodic and rhythm mode, exercising all five drum keys.
    ld a,(OPLELAPSED)
    and 1
    ld e,0
    jr z,.rhythm
    ld e,0x3F
.rhythm:
    ld a,0xBD
    call OPL_WRITE
    ld hl,0
    ld (OPLSTAGNANT),hl
    xor a
    ld (OPLSTAGNANT+2),a
.stagnant:
    ld hl,OPLSTAGNANT
    inc (hl)
    jp nz,.wait
    inc hl
    inc (hl)
    jp nz,.wait
    inc hl
    inc (hl)
    ld a,(hl)
    cp 4
    jp c,.wait
    ld a,8
    jp EXIT
OPL_MEMORY_MISSING:
    ld hl,opl_memory_failure_text
    ld (REASON),hl
    jp PROTOCOL
OPL_CAP_MISSING:
    ld hl,opl_cap_failure_text
    ld (REASON),hl
    jp PROTOCOL
; Before cleanup overwrites RESP, retain the verified CAPS and failing stage.
OPL_DIAGNOSTIC:
    ld a,(ERR)
    cp 2
    ret c
    ld hl,opl_phase_text
    call SHOW
    ld a,(OPLPHASE)
    call HEX8
    ld hl,opl_caps_text
    call SHOW
    ld hl,OPLCAPS
    ld b,4
    call HEX_BYTES
    call NL
    ld a,(OPLPHASE)
    cp 2
    ret nz
    ld hl,opl_open_text
    call SHOW
    ld a,(OPLOPENSTAGE)
    call HEX8
    ld hl,opl_open_base_text
    call SHOW
    ld hl,BASE
    ld b,2
    call HEX_BYTES
    ld hl,opl_open_error_text
    call SHOW
    ld a,(UG_LAST_ERROR)
    call HEX8
    ld hl,opl_open_values_text
    call SHOW
    ld hl,OPLOPENVALUES
    ld b,5
.open_values:
    ld a,(hl)
    inc hl
    call HEX8
    djnz .open_values
    jp NL
opl_open_text: DB "OPL OPEN stage=",0
opl_open_base_text: DB " base=",0
opl_open_error_text: DB " error=",0
opl_open_values_text: DB " values=",0
opl_revision_text: DB "UGOPL diagnostic R3 CRC=ON",13,10,0
opl_phase_text: DB "OPL DIAG R3 phase=",0
opl_caps_text: DB " caps=",0
opl_memory_failure_text: DB "MEMORY_CAP_MISSING",0
opl_cap_failure_text: DB "ADLIB_CAP_MISSING",0
opl_crc_failure_text: DB "NATIVE_FRAME_CRC",0
OPL_TIMER_FAIL:
    ld hl,opl_timer_stage_text
    call SHOW
    ld a,(OPLTIMERSTAGE)
    call HEX8
    ld hl,opl_timer_reset_text
    call SHOW
    ld a,(OPLTIMERVALUES)
    call HEX8
    ld hl,opl_timer1_text
    call SHOW
    ld a,(OPLTIMERVALUES+1)
    call HEX8
    ld hl,opl_timer2_text
    call SHOW
    ld a,(OPLTIMERVALUES+2)
    call HEX8
    call NL
    ld hl,opl_timer_failure_text
    ld (REASON),hl
    ld a,9
    jp EXIT
opl_timer_stage_text: DB "OPL TIMER stage=",0
opl_timer_reset_text: DB " reset=",0
opl_timer1_text: DB " timer1=",0
opl_timer2_text: DB " timer2=",0
opl_timer_failure_text: DB "OPL_TIMER_STATUS",0
OPL_MIX_DONE:
    ld a,3
    ld bc,0
    ld e,64
    call RPC
    jp c,RPC_ERROR
    ld hl,opl_render_text
    call SHOW
    ld hl,RESP+44
    call DEC32
    ld hl,opl_underrun_text
    call SHOW
    ld hl,RESP+36
    call DEC32
    ld hl,opl_psram_text
    call SHOW
    ld hl,RESP+40
    call DEC32
    ld hl,opl_protocol_text
    call SHOW
    ld hl,RESP+28
    call DEC32
    ld hl,opl_clips_text
    call SHOW
    ld hl,RESP+60
    call DEC32
    call NL
    ld hl,RESP+28
    ld b,4
    call .zero
    ld hl,RESP+36
    ld b,8
    call .zero
    ; Full-quantum timing is measured by the card, not the Z80 host clock.
    ld hl,(RESP+46)
    ld a,h
    or l
    jr nz,.over_budget
    ld hl,(RESP+44)
    ld de,2668
    or a
    sbc hl,de
    jp c,PASS
.over_budget:
    ld hl,opl_budget_text
    ld (REASON),hl
    ld a,7
    jp EXIT
.zero:
    ld a,(hl)
    or a
    jp nz,VERIFY_ERROR
    inc hl
    djnz .zero
    ret
opl_render_text: DB "max_render_us=",0
opl_underrun_text: DB " underruns=",0
opl_psram_text: DB " psram_errors=",0
opl_protocol_text: DB " protocol_errors=",0
opl_clips_text: DB " clips=",0
opl_budget_text: DB "render exceeds 2667us",0
OPL_CLEANUP:
    ld a,(OPLOWN)
    or a
    ret z
    xor a
    ld (OPLOWN),a
    ld a,4
    ld e,0x60
    call OPL_WRITE
    ld e,0x80
    call OPL_WRITE
    ld a,0xBD
    ld e,0
    call OPL_WRITE
    ld a,0xB0
    ld b,9
.off:
    call OPL_WRITE
    inc a
    djnz .off
    ; Force release at maximum rate, then mute every operator.
    ld hl,opl_operators
    ld b,18
.release:
    ld a,(hl)
    add a,0x80
    ld e,0xFF
    call OPL_WRITE
    ld a,(hl)
    add a,0x40
    ld e,63
    call OPL_WRITE
    inc hl
    djnz .release
    ret
opl_operators: DB 0,3,1,4,2,5,8,11,9,12,10,13,16,19,17,20,18,21
opl_frequencies: DB 0x80,0x87,0x8E,0x95,0x9C,0xA3,0xAA,0xB1,0xB8
opl_test: DB "TEST",0
opl_mix: DB "MIX",0
opl_turbo_on: DB "/TURBO:ON",0
opl_turbo_off: DB "/TURBO:OFF",0
opl_mono: DB "/FX:MONO",0
opl_stereo: DB "/FX:STEREO",0
