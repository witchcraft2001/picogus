; SPDX-License-Identifier: GPL-2.0-or-later
; Private standalone transport. Does not call UG_OPEN or bypass its mode8 gate.
; DSS IX entry ABI: length-prefixed command line. All DSS calls use closed windows.
    IFDEF UGTEST_S4
    ORG 0x6000 ; combined BUS/PROTO/PCM/FX/MIX code, below B800 workspace
    ELSE
    ORG 0x8000
    ENDIF
HEADER:
	DB "EXE",1
	DW 128,0,0,0,0,0,ENTRY,ENTRY,0xBFFE
	DS 128-($-HEADER),0
    IFDEF UGTEST_S4
TX EQU 0x5000
RX EQU 0x5400
    ELSE
TX EQU 0xB000
RX EQU 0xB400
    ENDIF
SNAP EQU 0xB800
CLI EQU 0xB850
V EQU 0xB900
SLOT EQU V
BASE EQU V+1
CHUNK EQU V+3
QUIET EQU V+4
MIRROR EQU V+5
BYTES EQU V+6
LOOPS EQU V+10
BLOCK EQU V+12
DIRECTION EQU V+14
CHECK EQU V+15
SOAK EQU V+16
HELP EQU V+18
BUSARG EQU V+19
PARSEPTR EQU V+20
NUMBER EQU V+22
RADIX EQU V+26
OPTION EQU V+27
REMAIN EQU V+28
CURRENT EQU V+32
LEFT EQU V+34
PTR EQU V+36
LOOPLEFT EQU V+38
PASSCRC EQU V+40
PASSDIR EQU V+41
PATTERN EQU V+42
EXPECTED EQU V+43
ERRCODE EQU V+44
START EQU V+45
FINISH EQU V+49
TOTAL EQU V+53
SETUPTIME EQU V+57
DATATIME EQU V+61
ENDTIME EQU V+65
PHASE EQU V+69
SERVICES EQU V+73
CHUNKS EQU V+77
MOVED EQU V+81
WRCOUNT EQU V+85
RDCOUNT EQU V+89
BLOCKCOUNT EQU V+93
CRC_SAVE EQU V+97
PREVTIME EQU V+101
STAGNANT EQU V+105
SOAKSTART EQU V+107
SESSION EQU V+111
METHODALL EQU V+115
TIMEOUTSTART EQU V+116
SPIKE EQU V+120
QUOTIENT EQU V+124
DIVREM EQU V+128
ASSERTDELAY EQU V+132
RESPONSEDELAY EQU V+134
METHODERR EQU V+136
IDENTIFIED EQU V+137
SPIKESTARTED EQU V+138
RETRIES EQU V+139
PHASECOUNT EQU V+140
	INCLUDE "ugmem.inc"
ENTRY:
    IFDEF UGTEST_S4
    ; Inspect complete tokens within the DSS length, leaving IX unchanged for
    ; the selected parser. DSS may retain leading whitespace; options may also
    ; precede the suite. Fixed offsets silently sent these calls to BUS syntax.
    ld b,(ix+0)
    ld a,b
    cp 160
    jp nc,.diag
    push ix
    pop hl
    inc hl
.suite_scan:
    ld a,b
    or a
    jp z,.diag
    ld a,(hl)
    cp ' '
    jp z,.suite_skip
    cp 9
    jp z,.suite_skip
    ld d,h
    ld e,l
    ld c,0
.suite_token:
    ld a,b
    or a
    jr z,.suite_end
    ld a,(hl)
    cp ' '
    jr z,.suite_end
    cp 9
    jr z,.suite_end
    inc hl
    dec b
    inc c
    jr .suite_token
.suite_end:
    push hl
    ld h,d
    ld l,e
    ld a,c
    cp 2
    jp z,.suite_fx
    cp 3
    jp z,.suite_pcm
    cp 4
    jp z,.suite_mod8
    cp 5
    jp nz,.suite_other
    ld a,(hl)
    and 0xDF
    cp 'P'
    jp nz,.suite_other
    inc hl
    ld a,(hl)
    and 0xDF
    cp 'R'
    jp nz,.suite_other
    inc hl
    ld a,(hl)
    and 0xDF
    cp 'O'
    jp nz,.suite_other
    inc hl
    ld a,(hl)
    and 0xDF
    cp 'T'
    jp nz,.suite_other
    inc hl
    ld a,(hl)
    and 0xDF
    cp 'O'
    jp z,.suite_native
    jp .suite_other
.suite_mod8:
    ld a,(hl)
    and 0xDF
    cp 'M'
    jp nz,.suite_other
    inc hl
    ld a,(hl)
    and 0xDF
    cp 'O'
    jp nz,.suite_other
    inc hl
    ld a,(hl)
    and 0xDF
    cp 'D'
    jp nz,.suite_other
    inc hl
    ld a,(hl)
    cp '8'
    jp z,.suite_native
    jp .suite_other
.suite_pcm:
    ld a,(hl)
    and 0xDF
    cp 'M'
    jp z,.suite_mix
    cp 'P'
    jp nz,.suite_other
    inc hl
    ld a,(hl)
    and 0xDF
    cp 'C'
    jp nz,.suite_other
    inc hl
    ld a,(hl)
    and 0xDF
    cp 'M'
    jp z,.suite_native
    jp .suite_other
.suite_mix:
    inc hl
    ld a,(hl)
    and 0xDF
    cp 'I'
    jp nz,.suite_other
    inc hl
    ld a,(hl)
    and 0xDF
    cp 'X'
    jp z,.suite_native
    jp .suite_other
.suite_fx:
    ld a,(hl)
    and 0xDF
    cp 'F'
    jp nz,.suite_other
    inc hl
    ld a,(hl)
    and 0xDF
    cp 'X'
    jp nz,.suite_other
.suite_native:
    pop hl
    jp S4TEST.ENTRY
.suite_other:
    pop hl
    jp .suite_scan
.suite_skip:
    inc hl
    dec b
    jp .suite_scan
.diag:
    ENDIF
	; Copy CLI before any DSS call may clobber IX.
	ld b,(ix+0)
	ld hl,CLI
	ld a,b
	cp 160
	jp nc,SYNTAX_INIT
	inc ix
.copy:
	ld a,b
	or a
	jr z,.copied
	ld a,(ix+0)
	cp 'a'
	jr c,.store
	cp 'z'+1
	jr nc,.store
	sub 32
.store:
	ld (hl),a
	inc hl
	inc ix
	djnz .copy
.copied:
	ld (hl),0
	ld hl,V
	ld de,V+1
	ld bc,143
	ld (hl),0
	ldir
	ld hl,UGMEM_BASE
	ld de,UGMEM_BASE+1
	ld bc,399
	ld (hl),0
	ldir
	ld hl,UGD_BASE
	ld (BASE),hl
	ld a,8
	ld (CHUNK),a
	ld hl,256
	ld (BLOCK),hl
	ld a,1
	ld (BYTES+2),a
	ld hl,4
	ld (LOOPS),hl
	ld a,1
	ld (METHODALL),a
	ld a,2
	ld (CHECK),a
	call PARSE
	jp c,EXIT
	ld a,(HELP)
	or a
	jr z,.run
	ld hl,help_text
	call PRINT
	xor a
	jp EXIT
.run:
	IFNDEF S1_BUS
	ld a,(QUIET)
	or a
	jr nz,.noskip
	ld a,(METHODALL)
	or a
	jr z,.noskip
	ld hl,skip_text
	call PRINT
.noskip:
	ENDIF
	IFDEF S1_BUS
	ld a,(BUSARG)
	or a
	jp z,SYNTAX
	ld hl,0
	ld (BYTES),hl
	ld hl,16
	ld (BYTES+2),hl ; 1048576 in each direction
	ld hl,1
	ld (LOOPS),hl
	xor a
	ld (CHECK),a
	ENDIF
	call VALIDATE_TOTAL
	jp c,EXIT
	call IDENTIFY
	jp c,EXIT
	ld a,1
	ld (IDENTIFIED),a
	call SET_DELAYS
	call START_SPIKE
	jp c,EXIT
	call RESET_SESSION
	jp c,EXIT
	call GET_SNAPSHOT
	ld hl,SNAP
	ld de,SESSION
	call COPY4
	ld a,(MIRROR)
	or a
	jr z,.nomirror
	call MIRROR_TEST
	jp c,EXIT
	call RESET_SESSION
.nomirror:
	call CLOCK
	ld hl,FINISH
	ld de,SOAKSTART
	call COPY4
.again:
	ld a,(CHECK)
	cp 2
	jr nz,.one
	xor a
	ld (PASSCRC),a
	call RUN_DIRECTIONS
	jp c,EXIT
	ld a,1
.one:
	ld (PASSCRC),a
	call RUN_DIRECTIONS
	jp c,EXIT
	ld hl,(SOAK)
	ld a,h
	or l
	jp z,SUCCESS
	call CLOCK
	ld hl,SOAKSTART
	call ELAPSED
	ld a,(TOTAL+2)
	or a
	jp nz,SUCCESS
	ld hl,(TOTAL)
	ld de,(SOAK)
	or a
	sbc hl,de
	jp c,.again
SUCCESS:
	call SPIKE_REPORT
	jp c,EXIT
	call RESET_CHECK
	jp c,EXIT
	xor a
	jp EXIT
SYNTAX_INIT:
	xor a
	ld (QUIET),a
	ld (IDENTIFIED),a
	ld (SPIKESTARTED),a
	ld (UGCTX.ISOPEN),a
SYNTAX:
	ld a,1
EXIT:
	ld (ERRCODE),a
	ld a,(UGCTX.ISOPEN)
	or a
	call nz,UG_ISA_CLOSE
	ld a,(ERRCODE)
	or a
	jr z,.clean
	ld a,(IDENTIFIED)
	or a
	jr z,.clean
	ld a,UGD_CANCEL
	call COMMAND ; covers failures in MIRROR and initial/session checks too
	ld a,(SPIKESTARTED)
	or a
	jr z,.clean
	call OPEN
	ld a,UGD_SEL_CMD
	call SELECT
	ld a,3 ; best-effort STOP only for a run accepted from this process
	ld (0xC1D2),a
	call CLOSE
.clean:
	IFDEF S1_DEF_CLEANUP
	call OPEN
	ENDIF
	ld a,(ERRCODE)
	or a
	jr z,.pass
	ld hl,fail_text
	call PRINT
	ld a,(ERRCODE)
	call PRINT_DEC8
	ld hl,reason_text
	call PRINT
	ld a,(ERRCODE)
	ld hl,reason_syntax
	cp 1
	jr z,.reason
	ld hl,reason_absent
	cp 2
	jr z,.reason
	cp 3
	jr nz,.notapi
	ld a,(METHODERR)
	or a
	ld hl,reason_api
	jr z,.reason
	cp 1
	ld hl,reason_unsafe
	jr z,.reason
	ld hl,reason_method
	jr .reason
.notapi:
	ld a,(ERRCODE)
	ld hl,reason_audio
	cp 7
	jr z,.reason
	ld hl,reason_timeout
	cp 8
	jr z,.reason
	ld hl,reason_verify
	cp 9
	jr z,.reason
	ld hl,reason_cancel
.reason:
	call PRINT
	jr .end
.pass:
	ld hl,pass_text
	call PRINT
.end:
	ld a,(ERRCODE)
	ld b,a
	ld c,0x41
	rst 0x10
	halt

; ---- strict tokens, case normalized in entry copy ----
PARSE:
	ld hl,CLI
.next:
	ld a,(hl)
	cp ' '
	jr nz,.token
	inc hl
	jr .next
.token:
	or a
	ret z
	ld (PARSEPTR),hl
	ld de,option_table
.find:
	ld a,(de)
	or a
	jr z,.bad
	push de
	ld hl,(PARSEPTR)
.match:
	ld a,(de)
	or a
	jr z,.matched
	cp (hl)
	jr nz,.skip
	inc de
	inc hl
	jr .match
.skip:
	pop de
.skipstr:
	ld a,(de)
	inc de
	or a
	jr nz,.skipstr
	inc de ; option id
	jr .find
.matched:
	pop bc
	inc de
	ld a,(de)
	ld (OPTION),a
	ld (PARSEPTR),hl
	cp 20
	jr c,.numeric
	ld a,(hl)
	or a
	jr z,.flag
	cp ' '
	jr nz,.bad
.flag:
	ld a,(OPTION)
	call FLAG
	ret c
	ld hl,(PARSEPTR)
	jr .next
.numeric:
	ld a,(OPTION)
	cp 2
	ld a,10
	jr nz,.radix
	ld a,16
.radix:
	ld (RADIX),a
	call PARSE_NUMBER
	ret c
	call SET_NUMBER
	ret c
	ld hl,(PARSEPTR)
	jp .next
.bad:
	ld a,1
	scf
	ret
FLAG:
	cp 36
	jr c,.supported
	sub 35
	ld (METHODERR),a
	ld a,3
	scf
	ret
.supported:
	cp 20
	jr nz,.f21
	ld a,1
	ld (QUIET),a
	or a
	ret
.f21:
	cp 21
	jr nz,.f22
	ld a,1
	ld (HELP),a
	or a
	ret
.f22:
	cp 22
	jr nz,.f23
	ld a,1
	ld (MIRROR),a
	or a
	ret
.f23:
	cp 23
	jr nz,.f24
	ld a,1
	ld (BUSARG),a
	or a
	ret
.f24:
	cp 24 ; REAL: request is recorded, still cannot certify timing
	ret z
	cp 25 ; fixed
	jr nz,.all
	xor a
	ld (METHODALL),a
	ret
.all:
	cp 26 ; ALL
	jr nz,.f27
	ld a,1
	ld (METHODALL),a
	or a
	ret
.f27:
	cp 27
	jr nz,.f28
	ld a,1
	ld (DIRECTION),a
	or a
	ret
.f28:
	cp 28
	jr nz,.f29
	ld a,2
	ld (DIRECTION),a
	or a
	ret
.f29:
	cp 29
	jr nz,.f30
	xor a
	ld (DIRECTION),a
	ret
.f30:
	cp 30
	jr nz,.f31
	xor a
	ld (CHECK),a
	ret
.f31:
	cp 31
	jr nz,.f32
	ld a,1
	ld (CHECK),a
	or a
	ret
.f32:
	cp 32
	jr nz,.f33
	ld a,2
	ld (CHECK),a
	or a
	ret
.f33:
	cp 33
	jr nz,.f34
	ld a,8
	ld (CHUNK),a
	or a
	ret
.f34:
	cp 34
	jr nz,.f35
	ld a,8
	ld (CHUNK),a
	or a
	ret
.f35:
	scf
	ret

; NUMBER u32 with overflow rejection. Decimal or 0x, BASE always hex.
PARSE_NUMBER:
	ld hl,NUMBER
	ld b,4
	xor a
.zero:
	ld (hl),a
	inc hl
	djnz .zero
	ld hl,(PARSEPTR)
	ld a,(hl)
	cp '0'
	jr nz,.digits
	inc hl
	ld a,(hl)
	cp 'X'
	dec hl
	jr nz,.digits
	inc hl
	inc hl
	ld a,16
	ld (RADIX),a
.digits:
	ld b,0
.loop:
	ld a,(hl)
	or a
	jr z,.done
	cp ' '
	jr z,.done
	cp '0'
	jr c,.bad
	cp '9'+1
	jr c,.digit
	cp 'A'
	jr c,.bad
	cp 'F'+1
	jr nc,.bad
	sub 7
.digit:
	sub '0'
	ld c,a
	ld a,(RADIX)
	cp c
	jr z,.bad
	jr c,.bad
	push bc
	push hl
	ld hl,NUMBER
	ld de,REMAIN
	call COPY4
	ld hl,NUMBER
	ld b,4
	xor a
.clear:
	ld (hl),a
	inc hl
	djnz .clear
	ld a,(RADIX)
	ld b,a
.mul:
	push bc
	ld hl,REMAIN
	ld de,NUMBER
	call ADD4
	pop bc
	jr c,.overflow
	djnz .mul
	pop hl
	pop bc
	push hl
	ld hl,NUMBER
	ld a,(hl)
	add a,c
	ld (hl),a
	ld a,0
	inc hl
	adc a,(hl)
	ld (hl),a
	ld a,0
	inc hl
	adc a,(hl)
	ld (hl),a
	ld a,0
	inc hl
	adc a,(hl)
	ld (hl),a
	pop hl
	jr c,.bad
	inc b
	inc hl
	jr .loop
.overflow:
	pop hl
	pop bc
.bad:
	ld a,1
	scf
	ret
.done:
	ld a,b
	or a
	jr z,.bad
	ld (PARSEPTR),hl
	ret
SET_NUMBER:
	ld a,(OPTION)
	cp 3
	jp z,.bytes
	ld hl,(NUMBER+2)
	ld a,h
	or l
	jp nz,.bad
	ld hl,(NUMBER)
	ld a,(OPTION)
	cp 1
	jr nz,.base
	ld a,h
	or a
	jp nz,.bad
	ld a,l
	cp 2
	jp nc,.bad
	ld (SLOT),a
	or a
	ret
.base:
	cp 2
	jr nz,.loops
	ld de,UGD_BASE
	or a
	sbc hl,de
	jp nz,.bad
	ld hl,(NUMBER)
	ld (BASE),hl
	ret
.loops:
	cp 4
	jr nz,.block
	ld a,h
	or l
	jp z,.bad
	ld (LOOPS),hl
	or a
	ret
.block:
	cp 5
	jr nz,.soak
	ld a,h
	or l
	jp z,.bad
	ld de,1025
	or a
	sbc hl,de
	jp nc,.bad
	ld hl,(NUMBER)
	ld (BLOCK),hl
	or a
	ret
.soak:
	cp 8
	jr c,.spike
	ld de,1001
	or a
	sbc hl,de
	jp nc,.bad
	ld hl,(NUMBER)
	ld a,(OPTION)
	cp 8
	jr nz,.response
	ld (ASSERTDELAY),hl
	or a
	ret
.response:
	ld (RESPONSEDELAY),hl
	or a
	ret
.spike:
	cp 7
	jr nz,.soakvalue
	ld a,h
	or a
	jp nz,.bad
	ld a,l
	cp 1
	jp c,.bad
	cp 3
	jp nc,.bad
	ld (SPIKE),a
	or a
	ret
.soakvalue:
	ld (SOAK),hl
	or a
	ret
.bytes:
	ld hl,NUMBER
	ld a,(hl)
	inc hl
	or (hl)
	inc hl
	or (hl)
	inc hl
	or (hl)
	jp z,.bad
	ld hl,NUMBER
	ld de,BYTES
	jp COPY4
.bad:
	ld a,1
	scf
	ret
VALIDATE_TOTAL:
	ld hl,NUMBER
	ld b,4
	xor a
.zero:
	ld (hl),a
	inc hl
	djnz .zero
	ld bc,(LOOPS)
.loop:
	push bc
	ld hl,BYTES
	ld de,NUMBER
	call ADD4
	pop bc
	jr c,.bad
	dec bc
	ld a,b
	or c
	jr nz,.loop
	ret
.bad:
	ld a,1
	scf
	ret

option_table:
	DB "/SLOT:",0,1,"/BASE:",0,2,"/BYTES:",0,3,"/LOOPS:",0,4,"/BLOCK:",0,5,"/SOAK:",0,6,"/SPIKE:",0,7
	DB "/ASSERT:",0,8,"/RESPONSE:",0,9
	DB "/QUIET",0,20,"/?",0,21,"/MIRROR",0,22,"BUS",0,23,"/REAL",0,24
	DB "/METHOD:FIXED",0,25,"/METHOD:ALL",0,26
	DB "/METHOD:STACK",0,36,"/METHOD:ALIAS",0,37,"/METHOD:SLOW",0,37
	DB "/DIRECTION:WRITE",0,27,"/DIRECTION:READ",0,28,"/DIRECTION:BOTH",0,29
	DB "/CHECK:NONE",0,30,"/CHECK:CRC",0,31,"/CHECK:BOTH",0,32
	DB "/CPU:21",0,33,"/CPU:3.5",0,34,"/CPU:UNKNOWN",0,34,0

; ---- ISA helpers: preserve caller registers except AF ----
OPEN:
	push bc
	push de
	push hl
	ld a,(SLOT)
	ld hl,(BASE)
	call UG_ISA_OPEN
	pop hl
	pop de
	pop bc
	ret
CLOSE:
	push af
	push bc
	call UG_ISA_CLOSE
	pop bc
	pop af
	ret
SELECT: ; A=private config selector, window already open
	ld (0xC1D0),a
	ret
IDENTIFY:
	call OPEN
	ld a,0xCC
	call SELECT
	xor a
	call SELECT
	ld a,(0xC1D2)
	cp 0xDD
	jr nz,.absent
	ld a,1
	call SELECT
	ld a,(0xC1D2)
	cp 4
	jr nz,.protocol
	ld a,UGD_SEL_VERSION
	call SELECT
	ld a,(0xC1D2)
	cp UG_DIAG_VERSION
	jr nz,.protocol
	ld a,3
	call SELECT
	ld a,(0xC1D2)
	or a
	jr nz,.absent ; standalone has INVALID_MODE, never mode8
	ld a,UGD_SEL_BASE
	call SELECT
	ld a,(0xC1D1)
	ld hl,(BASE)
	cp l
	jr nz,.protocol
	ld a,(0xC1D2)
	cp h
	jr nz,.protocol
	call CLOSE
	xor a
	ret
.absent:
	call CLOSE
	ld a,2
	scf
	ret
.protocol:
	call CLOSE
	ld a,3
	scf
	ret
REG_WRITE: ; E=offset, A=value
	push hl
	push af
	ld hl,(BASE)
	ld a,l
	add a,e
	ld l,a
	jr nc,.ok
	inc h
.ok:
	set 6,h
	set 7,h
	pop af
	ld (hl),a
	pop hl
	ret
COMMAND: ; A=command, opens one small window
	push af
	call OPEN
	pop af
	ld e,UGD_REG_CMD
	call REG_WRITE
	call CLOSE
	ret
SET_DELAYS:
	call OPEN
	ld a,UGD_SEL_ASSERT_US
	call SELECT
	ld hl,(ASSERTDELAY)
	ld a,l
	ld (0xC1D1),a
	ld a,h
	ld (0xC1D2),a
	call CLOSE
	call OPEN
	ld a,UGD_SEL_RESPONSE_US
	call SELECT
	ld hl,(RESPONSEDELAY)
	ld a,l
	ld (0xC1D1),a
	ld a,h
	ld (0xC1D2),a
	call CLOSE
	ld hl,(ASSERTDELAY)
	ld de,(RESPONSEDELAY)
	add hl,de
	ld a,h
	or l
	ret z
	ld de,1000 ; conservative data-window budget (real timing still required)
	ex de,hl
	ld b,0
.divide:
	or a
	sbc hl,de
	jr c,.divdone
	inc b
	jr .divide
.divdone:
	ld a,b
	or a
	jr nz,.nonzero
	inc a
.nonzero:
	ld b,a
	ld a,(CHUNK)
	cp b
	ret c
	ld a,b
	ld (CHUNK),a
	ret
; Finite retries happen only between closed ISA windows, including ESC/time.
RETRY_BEGIN:
	call CLOCK
	ld hl,FINISH
	ld de,TIMEOUTSTART
	call COPY4
	ld a,64
	ld (RETRIES),a
	ret
RETRY_NEXT:
	call ESC_CHECK
	ret c
	call CLOCK
	ld hl,TIMEOUTSTART
	call ELAPSED
	ld a,(TOTAL+2)
	ld hl,TOTAL+3
	or (hl)
	jr nz,.timeout
	ld hl,(TOTAL)
	ld de,5
	or a
	sbc hl,de
	jr nc,.timeout
	ld a,(RETRIES)
	dec a
	ld (RETRIES),a
	jr z,.timeout
	xor a
	ret
.timeout:
	ld a,8
	scf
	ret
START_SPIKE:
	ld a,(SPIKE)
	or a
	ret z
	call RETRY_BEGIN
.send:
	call OPEN
	ld a,UGD_SEL_ARG
	call SELECT
	xor a
	ld (0xC1D1),a
	ld (0xC1D2),a ; default 24000 quanta = 64 s
	ld a,UGD_SEL_CMD
	call SELECT
	ld a,(SPIKE)
	ld (0xC1D2),a
	ld a,(0xC1D1) ; command acceptance, not asynchronous state
	call CLOSE
	cp UGD_CMD_OK
	jr z,.accepted
	cp UGD_CMD_BUSY
	jp nz,SPIKE_BADAPI
	call RETRY_NEXT
	ret c
	jr .send
.accepted:
	ld a,1
	ld (SPIKESTARTED),a
	call RETRY_BEGIN
.ready:
	call SPIKE_FETCH
	jr nc,.state
	cp UGD_CMD_BUSY
	ret nz
	jr .retry
.state:
	ld a,(RX+UGD_SPIKE_STATE)
	cp UGD_STATE_ERR
	jp z,SPIKE_BADAUDIO
	ld a,(SPIKE)
	ld hl,RX+UGD_SPIKE_PROFILE
	cp (hl)
	jr nz,.retry
	ld a,(RX+UGD_SPIKE_STATE)
	cp UGD_STATE_RUN
	ret z
	cp UGD_STATE_DONE
	ret z
.retry:
	call RETRY_NEXT
	ret c
	jr .ready
SPIKE_FETCH:
	; Freeze a coherent snapshot. BUSY must be checked before any bytes.
	call OPEN
	ld a,UGD_SEL_STATUS
	call SELECT
	ld a,(0xC1D1)
	call CLOSE
	or a
	jr z,.frozen
	scf
	ret
.frozen:
	ld hl,RX
	ld (PTR),hl
	ld a,UGD_SPIKE_SIZE
	ld (LEFT),a
.loop:
	call OPEN
	ld hl,(PTR)
	ld a,(0xC1D2)
	ld (hl),a
	inc hl
	ld (PTR),hl
	call CLOSE
	ld a,(LEFT)
	dec a
	ld (LEFT),a
	jr nz,.loop
	ld a,(RX)
	cp 'U'
	jp nz,SPIKE_BADAPI
	ld a,(RX+1)
	cp 'G'
	jp nz,SPIKE_BADAPI
	ld a,(RX+2)
	cp UG_DIAG_VERSION
	jp nz,SPIKE_BADAPI
	xor a
	ret
SPIKE_BADAPI:
	ld a,3
	scf
	ret
SPIKE_BADAUDIO:
	ld a,7
	scf
	ret
SPIKE_REPORT:
	ld a,(SPIKE)
	or a
	ret z
	call RETRY_BEGIN
.fetch:
	call SPIKE_FETCH
	jr nc,.report
	cp UGD_CMD_BUSY
	ret nz
	call RETRY_NEXT
	ret c
	jr .fetch
.report:
	ld hl,spike_text
	call PRINT
	ld hl,RX
	ld b,UGD_SPIKE_SIZE/4
.print:
	push bc
	push hl
	call HEX32
	ld hl,space_text
	call PRINT
	pop hl
	ld de,4
	add hl,de
	pop bc
	djnz .print
	ld hl,newline
	call PRINT
	ld hl,spike_pending
	call PRINT
	ld a,(SPIKE)
	ld hl,RX+UGD_SPIKE_PROFILE
	cp (hl)
	jp nz,SPIKE_BADAUDIO
	ld a,(RX+UGD_SPIKE_STATE)
	cp UGD_STATE_RUN
	jr z,.audit
	cp UGD_STATE_DONE
	jp nz,SPIKE_BADAUDIO
.audit:
	ld a,(RX+UGD_SPIKE_FLAGS)
	and 5 ; audit must have passed; fatal fuse must be clear
	cp 1
	jp nz,SPIKE_BADAUDIO
	ld hl,RX+UGD_SPIKE_UNDERRUNS
	call ZERO4
	jp nz,SPIKE_BADAUDIO
	ld hl,RX+UGD_SPIKE_FETCH_ERRORS
	call ZERO4
	jp nz,SPIKE_BADAUDIO
	ld hl,RX+UGD_SPIKE_BG_ERRORS
	call ZERO4
	jp nz,SPIKE_BADAUDIO
	ld hl,RX+UGD_SPIKE_RES_FAULTS
	call ZERO4
	jp nz,SPIKE_BADAUDIO
	xor a
	ret
ZERO4:
	ld b,4
	xor a
.loop:
	or (hl)
	inc hl
	djnz .loop
	ret
RESET_SESSION:
	ld a,UGD_RESET
	call COMMAND
	ret
GET_SNAPSHOT:
	call OPEN
	ld a,UGD_SEL_BUS
	call SELECT
	call CLOSE
	ld hl,SNAP
	ld (PTR),hl
	ld a,UGD_BUS_SIZE
	ld (LEFT),a
.loop:
	ld a,(CHUNK)
	ld b,a
	ld a,(LEFT)
	cp b
	jr nc,.full
	ld b,a
.full:
	push bc
	call OPEN
	ld hl,(PTR)
.read:
	ld a,(0xC1D2)
	ld (hl),a
	inc hl
	djnz .read
	ld (PTR),hl
	call CLOSE
	pop bc
	ld a,(LEFT)
	sub b
	ld (LEFT),a
	jr nz,.loop
	ret
CHECK_STATUS:
	call CLOCK
	ld hl,FINISH
	ld de,TIMEOUTSTART
	call COPY4
	ld ix,64 ; finite fallback when DSS clock is stopped
.poll:
	push ix
	call OPEN
	ld hl,(BASE)
	inc hl
	set 6,h
	set 7,h
	ld a,(hl)
	call CLOSE
	pop ix
	or a
	ret z
	bit 7,a
	jr nz,.bad
	push ix
	call CLOCK
	ld hl,TIMEOUTSTART
	call ELAPSED
	pop ix
	ld hl,(TOTAL)
	ld de,5
	or a
	sbc hl,de
	jr nc,.timeout
	dec ix
	push ix
	pop hl
	ld a,h
	or l
	jr nz,.poll
.timeout:
	ld a,8
	scf
	ret
.bad:
	ld a,9
	scf
	ret
RESET_CHECK:
	call RESET_SESSION
	call GET_SNAPSHOT
	ld hl,SNAP
	ld de,SESSION
	call EQUAL4
	jr z,.bad
	ld hl,SNAP+4
	ld b,21
.zero:
	ld a,(hl)
	inc hl
	or a
	jr nz,.bad
	djnz .zero
	IFNDEF S1_DEF_FUSE
	ld a,(SNAP+25)
	and 1
	jr nz,.bad
	ENDIF
	ret
.bad:
	ld a,9
	scf
	ret
MIRROR_TEST:
	; Explicit /MIRROR acknowledges an isolated bench. Only BASE+0400 mirror.
	ld hl,1
	ld (CURRENT),hl
	ld a,UGD_PATTERN
	call BEGIN
	call OPEN
	ld hl,(BASE)
	set 6,h
	set 7,h
	set 2,h
	ld a,(hl)
	cp 7
	call CLOSE
	jr nz,.bad
	ld a,UGD_END
	call COMMAND
	jp CHECK_STATUS
.bad:
	ld a,9
	scf
	ret
BEGIN: ; A=mode, CURRENT len
	push af
	call OPEN
	ld hl,(CURRENT)
	ld a,l
	ld e,UGD_REG_LEN_LO
	call REG_WRITE
	ld a,h
	ld e,UGD_REG_LEN_HI
	call REG_WRITE
	pop af
	ld e,UGD_REG_CMD
	call REG_WRITE
	call CLOSE
	ret

; ---- measurements: second-resolution DSS, midnight wrap ----
CLOCK:
	ld c,0x21
	rst 0x10
	ld a,h
	ld e,l
	ld d,b
	ld hl,0
	ld (FINISH),hl
	ld (FINISH+2),hl
	ld b,a
.hour:
	ld a,b
	or a
	jr z,.minute
	push bc
	push de
	ld hl,const3600
	ld de,FINISH
	call ADD4
	pop de
	pop bc
	djnz .hour
.minute:
	ld b,e
.min:
	ld a,b
	or a
	jr z,.second
	push bc
	push de
	ld hl,const60
	ld de,FINISH
	call ADD4
	pop de
	pop bc
	djnz .min
.second:
	ld a,d
	ld (NUMBER),a
	xor a
	ld (NUMBER+1),a
	ld (NUMBER+2),a
	ld (NUMBER+3),a
	ld hl,NUMBER
	ld de,FINISH
	call ADD4
	; Stagnant clock protection for SOAK; bounded even when clock stops.
	ld hl,FINISH
	ld de,PREVTIME
	call EQUAL4
	jr nz,.moving
	ld hl,(STAGNANT)
	inc hl
	ld (STAGNANT),hl
	ret
.moving:
	ld hl,0
	ld (STAGNANT),hl
	ld hl,FINISH
	ld de,PREVTIME
	jp COPY4
ELAPSED: ; HL=start u32 -> TOTAL elapsed seconds (wrap 24h)
	ld de,FINISH
	ld ix,TOTAL
	ld b,4
	or a
.sub:
	ld a,(de)
	sbc a,(hl)
	ld (ix+0),a
	inc de
	inc hl
	inc ix
	djnz .sub
	ret nc
	ld hl,const86400
	ld de,TOTAL
	jp ADD4
PHASE_START:
	call CLOCK
	ld hl,FINISH
	ld de,PHASE
	jp COPY4
PHASE_END: ; DE=accumulator
	push de
	ld hl,const1
	ld de,PHASECOUNT
	call ADD4
	call CLOCK
	ld hl,PHASE
	call ELAPSED
	pop de
	ld hl,TOTAL
	jp ADD4
ESC_CHECK:
	ld c,0x31
	rst 0x10
	cp 27
	jr z,.cancel
	ld hl,(SOAK)
	ld a,h
	or l
	ret z
	ld hl,(STAGNANT)
	ld de,128
	or a
	sbc hl,de
	jr c,.noidle
	; Closed-window SOAK pacing: even the fastest supported CPU must
	; give the 1-second DSS clock time to tick before stagnant fallback.
	; 16384 iterations * ~26T = ~20ms at21MHz; outside measured phases.
	ld bc,16384
.idle:
	dec bc
	ld a,b
	or c
	jr nz,.idle
	call CLOCK
.noidle:
	ld hl,(STAGNANT)
	ld de,1024
	or a
	sbc hl,de
	jr nc,.timeout
	xor a
	ret
.timeout:
	xor a
	ld a,8
	scf
	ret
.cancel:
	ld a,10
	scf
	ret

RUN_DIRECTIONS:
	ld a,(DIRECTION)
	cp 2
	jr z,.read
	ld a,1
	ld (PASSDIR),a
	call RUN_PASS
	ret c
	ld a,(DIRECTION)
	cp 1
	ret z
.read:
	ld a,2
	ld (PASSDIR),a
	jp RUN_PASS
RUN_PASS:
	call RESET_SESSION
	xor a
	ld hl,PHASECOUNT
	ld b,4
.zero:
	ld (hl),a
	inc hl
	djnz .zero
	ld hl,SETUPTIME
	ld de,SETUPTIME+1
	ld bc,43 ; through BLOCKCOUNT (stats area)
	ld (hl),0
	ldir
	ld a,7
	ld (PATTERN),a
	ld (EXPECTED),a
	ld hl,(LOOPS)
	ld (LOOPLEFT),hl
	call CLOCK
	ld hl,FINISH
	ld de,START
	call COPY4
.loop:
	ld hl,BYTES
	ld de,REMAIN
	call COPY4
.block:
	ld hl,(BLOCK)
	ld (CURRENT),hl
	ld hl,(REMAIN+2)
	ld a,h
	or l
	jr nz,.full
	ld hl,(REMAIN)
	ld de,(BLOCK)
	or a
	sbc hl,de
	jr nc,.full
	ld hl,(REMAIN)
	ld (CURRENT),hl
.full:
	call PHASE_START
	call FILL
	ld a,(PASSCRC)
	or a
	jr z,.nocrc
	ld hl,TX
	ld bc,(CURRENT)
	call UG_CRC32
	ld hl,UGCRC.OUT
	ld de,CRC_SAVE
	call COPY4
.nocrc:
	ld a,(PASSDIR)
	cp 1
	ld a,UGD_WRITE
	jr z,.begin
	ld a,UGD_PATTERN
.begin:
	IFDEF S1_DEF_OVERBLOCK
	ld hl,1025
	ld (CURRENT),hl
	ENDIF
	call BEGIN
	ld hl,const3
	ld de,SERVICES
	call ADD4
	ld de,SETUPTIME
	call PHASE_END
	call PHASE_START
	ld a,(PASSDIR)
	call TRANSFER
	ld de,DATATIME
	call PHASE_END
	call PHASE_START
	ld a,UGD_END
	call COMMAND
	call CHECK_STATUS
	jp c,.fail
	ld hl,const2
	ld de,SERVICES
	call ADD4
	ld hl,CURRENT
	ld de,MOVED
	call ADD16TO32
	ld a,(PASSDIR)
	cp 1
	ld de,WRCOUNT
	jr z,.count
	ld de,RDCOUNT
.count:
	ld hl,CURRENT
	call ADD16TO32
	IFDEF S1_DEF_COUNTER
	ld hl,const1
	ld de,WRCOUNT
	call ADD4
	ENDIF
	ld hl,const1
	ld de,BLOCKCOUNT
	call ADD4
	ld a,(PASSDIR)
	cp 2
	jr nz,.write
	ld a,(PASSCRC)
	or a
	jr nz,.readcrc
	ld de,ENDTIME
	call PHASE_END
	call VERIFY
	jp c,.fail
	call PHASE_START
	jr .finish
.readcrc:
	call VERIFY
	jp c,.fail
	jr .finish
.write:
	; NONE: comparison/readback is excluded from the measured data/finalize.
	ld a,(PASSCRC)
	or a
	jr z,.outside
	call ECHO_VERIFY
	jp c,.fail
	jr .finish
.outside:
	ld de,ENDTIME
	call PHASE_END
	call ECHO_VERIFY
	jp c,.fail
	call PHASE_START
.finish:
	ld de,ENDTIME
	call PHASE_END
	call COUNTERS
	jp c,.fail
	ld hl,const29
	ld de,SERVICES
	call ADD4
	ld a,(PASSDIR)
	cp 1
	jr nz,.servicesdone
	ld hl,const4
	ld de,SERVICES
	call ADD4
.servicesdone:
	call ESC_CHECK
	jr nc,.continue
	jp .fail
.continue:
	ld hl,(REMAIN)
	ld de,(CURRENT)
	or a
	sbc hl,de
	ld (REMAIN),hl
	ld hl,(REMAIN+2)
	ld de,0
	sbc hl,de
	ld (REMAIN+2),hl
	ld a,h
	or l
	ld hl,(REMAIN)
	or h
	or l
	jp nz,.block
	ld hl,(LOOPLEFT)
	dec hl
	ld (LOOPLEFT),hl
	ld a,h
	or l
	jp nz,.loop
	call CLOCK
	; Sum disjoint timed phases; NONE verification/control is excluded.
	ld hl,SETUPTIME
	ld de,TOTAL
	call COPY4
	ld hl,DATATIME
	ld de,TOTAL
	call ADD4
	ld hl,ENDTIME
	ld de,TOTAL
	call ADD4
	call REPORT
	xor a
	ret
.fail:
	push af
	ld a,UGD_CANCEL
	call COMMAND
	pop af
	scf
	ret
FILL:
	ld hl,TX
	ld bc,(CURRENT)
	ld a,(PATTERN)
.loop:
	ld (hl),a
	inc hl
	add a,13
	dec bc
	ld d,a
	ld a,b
	or c
	ld a,d
	jr nz,.loop
	ld (PATTERN),a
	ret
TRANSFER: ; A=1 write, 2 read. chunks always <=8 (ISA at 3.5 MHz)
	ld (OPTION),a
	ld hl,(CURRENT)
	ld (LEFT),hl
	ld hl,TX
	cp 1
	jr z,.ptr
	ld hl,RX
.ptr:
	ld (PTR),hl
.loop:
	ld hl,(LEFT)
	ld a,(CHUNK)
	ld b,a
	ld a,h
	or a
	jr nz,.full
	ld a,l
	cp b
	jr nc,.full
	ld b,a
.full:
	push bc
	call OPEN
	IFDEF S1_DEF_DSSWIN
	push af
	push bc
	push de
	push hl
	ld c,0x21
	rst 0x10
	pop hl
	pop de
	pop bc
	pop af
	ENDIF
	ld hl,(PTR)
	ld de,(BASE)
	set 6,d
	set 7,d
	ld a,(OPTION)
	cp 1
	jr nz,.read
.write:
	ld a,(hl)
	IFNDEF S1_DEF_DROP
	ld (de),a
	ENDIF
	IFDEF S1_DEF_DUPLICATE
	ld (de),a
	ENDIF
	inc hl
	djnz .write
	jr .done
.read:
	ld a,(de)
	ld (hl),a
	inc hl
	djnz .read
.done:
	ld (PTR),hl
	call CLOSE
	pop bc
	ld e,b
	ld d,0
	ld hl,(LEFT)
	or a
	sbc hl,de
	ld (LEFT),hl
	push hl
	ld hl,const1
	ld de,CHUNKS
	call ADD4
	pop hl
	ld a,h
	or l
	jr nz,.loop
	ret
ECHO_VERIFY:
	ld a,UGD_ECHO
	call BEGIN
	ld a,2
	call TRANSFER
	ld a,UGD_END
	call COMMAND
	ld hl,CURRENT
	ld de,RDCOUNT
	call ADD16TO32
	ld hl,const1
	ld de,BLOCKCOUNT
	call ADD4
	jp VERIFY
VERIFY:
	ld a,(PASSCRC)
	or a
	jr z,.compare
	ld hl,RX
	ld bc,(CURRENT)
	call UG_CRC32
	ld hl,UGCRC.OUT
	ld de,CRC_SAVE
	call EQUAL4
	jr nz,.bad
.compare:
	ld hl,TX
	ld de,RX
	ld bc,(CURRENT)
.loop:
	ld a,(de)
	cp (hl)
	jr nz,.bad
	inc hl
	inc de
	dec bc
	ld a,b
	or c
	jr nz,.loop
	ret
.bad:
	ld a,9
	scf
	ret
COUNTERS:
	call GET_SNAPSHOT
	ld hl,SNAP+UGD_BUS_WRITTEN
	ld de,WRCOUNT
	call EQUAL4
	jr nz,.bad
	ld hl,SNAP+UGD_BUS_READ
	ld de,RDCOUNT
	call EQUAL4
	jr nz,.bad
	ld hl,SNAP+UGD_BUS_BLOCKS
	ld de,BLOCKCOUNT
	call EQUAL4
	jr nz,.bad
	ld hl,SNAP+UGD_BUS_ERRORS
	ld b,4
.loop:
	ld a,(hl)
	or a
	jr nz,.bad
	inc hl
	djnz .loop
	IFNDEF S1_DEF_FUSE
	ld a,(SNAP+UGD_BUS_FLAGS)
	and 1
	jr nz,.bad
	ENDIF
	xor a
	ret
.bad:
	ld a,9
	scf
	ret

COPY4:
	ld bc,4
	ldir
	or a
	ret
ADD16TO32:
	ld a,(hl)
	ld (NUMBER),a
	inc hl
	ld a,(hl)
	ld (NUMBER+1),a
	xor a
	ld (NUMBER+2),a
	ld (NUMBER+3),a
	ld hl,NUMBER
ADD4:
	ld b,4
	or a
.loop:
	ld a,(de)
	adc a,(hl)
	ld (de),a
	inc hl
	inc de
	djnz .loop
	ret
EQUAL4:
	ld b,4
.loop:
	ld a,(de)
	cp (hl)
	ret nz
	inc de
	inc hl
	djnz .loop
	ret
PRINT:
	ld c,0x5C
	rst 0x10
	ret
PRINT_DEC8:
	cp 10
	jr c,.one
	push af
	ld a,'1'
	ld c,0x5B
	rst 0x10
	pop af
	sub 10
.one:
	add a,'0'
	ld c,0x5B
	rst 0x10
	ret
HEX32:
	inc hl
	inc hl
	inc hl
	ld b,4
.loop:
	ld a,(hl)
	push bc
	push hl
	push af
	rrca
	rrca
	rrca
	rrca
	call NIBBLE
	pop af
	call NIBBLE
	pop hl
	pop bc
	dec hl
	djnz .loop
	ret
NIBBLE:
	and 15
	add a,'0'
	cp '9'+1
	jr c,.out
	add a,7
.out:
	ld c,0x5B
	rst 0x10
	ret
REPORT:
	ld a,(QUIET)
	or a
	ret nz
	ld hl,report_text
	call PRINT
	ld a,(PASSDIR)
	call PRINT_DEC8
	ld hl,check_text
	call PRINT
	ld a,(PASSCRC)
	call PRINT_DEC8
	ld hl,bytes_text
	call PRINT
	ld hl,MOVED
	call HEX32
	ld hl,total_text
	call PRINT
	ld hl,TOTAL
	call HEX32
	ld hl,setup_text
	call PRINT
	ld hl,SETUPTIME
	call HEX32
	ld hl,data_text
	call PRINT
	ld hl,DATATIME
	call HEX32
	ld hl,end_text
	call PRINT
	ld hl,ENDTIME
	call HEX32
	ld hl,block_text
	call PRINT
	ld hl,BLOCK
	ld de,NUMBER
	call ADD16COPY
	ld hl,NUMBER
	call HEX32
	ld hl,chunk_text
	call PRINT
	ld a,(CHUNK)
	ld (NUMBER),a
	xor a
	ld (NUMBER+1),a
	ld (NUMBER+2),a
	ld (NUMBER+3),a
	ld hl,NUMBER
	call HEX32
	ld hl,services_text
	call PRINT
	ld hl,SERVICES
	call HEX32
	ld hl,uncertainty_text
	call PRINT
	ld hl,PHASECOUNT
	call HEX32
	ld hl,chunks_text
	call PRINT
	ld hl,CHUNKS
	call HEX32
	ld hl,newline
	call PRINT
	; Each disjoint interval measured with whole seconds has <1s error.
	; Suppress speed unless the worst sum error is <=25% of true elapsed.
	ld hl,PHASECOUNT
	ld de,NUMBER
	call COPY4
	ld b,2
.scale:
	push bc
	ld hl,NUMBER
	ld b,4
	or a
.shift:
	rl (hl)
	inc hl
	djnz .shift
	pop bc
	jr c,.short
	djnz .scale
	ld hl,PHASECOUNT
	ld de,NUMBER
	call ADD4 ; 5*N guarantees N/(total-N) <=25%
	jr c,.short
	ld hl,NUMBER+3
	ld de,TOTAL+3
	ld b,4
.compare:
	ld a,(de)
	cp (hl)
	jr c,.short
	jr nz,.adequate
	dec hl
	dec de
	djnz .compare
.adequate:
	call DIVIDE_SPEED
	ld hl,speed_text
	call PRINT
	ld hl,QUOTIENT
	call HEX32
	ld hl,newline
	jp PRINT
.short:
	ld hl,short_text
	jp PRINT
DIVIDE_SPEED:
	ld hl,MOVED
	ld de,NUMBER
	call COPY4
	ld hl,DIVREM
	ld b,4
	xor a
.zero:
	ld (hl),a
	inc hl
	djnz .zero
	ld b,32
.bit:
	push bc
	ld hl,NUMBER
	ld b,4
	or a
.shift:
	rl (hl)
	inc hl
	djnz .shift
	ld hl,DIVREM
	ld b,4
.rem:
	rl (hl)
	inc hl
	djnz .rem
	ld hl,TOTAL
	ld de,DIVREM
	ld ix,QUOTIENT
	ld b,4
	or a
.sub:
	ld a,(de)
	sbc a,(hl)
	ld (ix+0),a
	inc de
	inc hl
	inc ix
	djnz .sub
	jr c,.next
	ld hl,QUOTIENT
	ld de,DIVREM
	call COPY4
	ld hl,NUMBER
	set 0,(hl)
.next:
	pop bc
	djnz .bit
	ld hl,NUMBER
	ld de,QUOTIENT
	jp COPY4
ADD16COPY:
	ld a,(hl)
	ld (de),a
	inc hl
	inc de
	ld a,(hl)
	ld (de),a
	inc de
	xor a
	ld (de),a
	inc de
	ld (de),a
	ret
const1: DB 1,0,0,0
const2: DB 2,0,0,0
const3: DB 3,0,0,0
const4: DB 4,0,0,0
const29: DB 29,0,0,0
const60: DB 60,0,0,0
const3600: DB 0x10,0x0E,0,0
const86400: DB 0x80,0x51,1,0
pass_text: DB "RESULT PASS code=0",13,10,0
fail_text: DB "RESULT FAIL code=",0
reason_text: DB " reason=",0
reason_syntax: DB "SYNTAX",13,10,0
reason_absent: DB "ABSENT_OR_MODE",13,10,0
reason_unsafe: DB "UNSAFE_NMI",13,10,0
reason_method: DB "S1_UNSUPPORTED_METHOD",13,10,0
reason_api: DB "DIAGNOSTIC_API_OR_UNSUPPORTED_METHOD",13,10,0
reason_audio: DB "SPIKE_AUDIO",13,10,0
reason_timeout: DB "TIMEOUT",13,10,0
reason_verify: DB "VERIFICATION",13,10,0
reason_cancel: DB "CANCEL",13,10,0
report_text: DB "METHOD=FIXED direction=",0
check_text: DB " check_crc=",0
bytes_text: DB " bytes=0x",0
total_text: DB " total_seconds=0x",0
setup_text: DB " setup_seconds=0x",0
data_text: DB " data_seconds=0x",0
end_text: DB " finalize_seconds=0x",0
block_text: DB " block=0x",0
chunk_text: DB " chunk=0x",0
chunks_text: DB " data_chunks_total=0x",0
services_text: DB " service_accesses_total=0x",0
newline: DB 13,10,0
spike_pending: DB "C00=REAL_PENDING reason=TRACES_AND_TIMING_REQUIRED",13,10,0
spike_text: DB "SPIKE_STATUS_V3 raw_le_words=",0
space_text: DB " ",0
uncertainty_text: DB " timing_error_bound_seconds=0x",0
speed_text: DB "bytes_per_second=0x",0
short_text: DB "SPEED=INSUFFICIENT_INTERVAL resolution_seconds=1",13,10,0
skip_text: DB "SKIP SLOW reason=S1_SRAM_FIXED_ONLY",13,10,"SKIP ALIAS reason=S5_PENDING",13,10,"SKIP STACK reason=UNSAFE_NMI",13,10,0
help_text:
    IFDEF UGTEST_S4
    DB "UGTEST PROTO|PCM|FX|MIX|MOD8 [/VOICES:N /SECONDS:N] [/REAL] (ULTRAGS firmware)",13,10
    ENDIF
    DB "UGTEST BUS /REAL [/MIRROR] | UGBENCH /BYTES:N /LOOPS:N /BLOCK:1..1024",13,10
	DB "/METHOD:ALL|FIXED /DIRECTION:BOTH|WRITE|READ /CHECK:NONE|CRC|BOTH /SOAK:seconds",13,10
	DB "/SLOT:0|1 /BASE:02A0 /CPU:21|3.5|UNKNOWN /SPIKE:1|2 /QUIET /?",13,10
	DB "/ASSERT:0..1000 /RESPONSE:0..1000 (microseconds; finite diagnostic delays)",13,10,0
	INCLUDE "ug_diag_wire.inc"
	INCLUDE "isa.asm"
	INCLUDE "ugcrc.asm"
    IFDEF UGTEST_S4
    MODULE S4TEST
    DEFINE APP_PROTO
    DEFINE APP_PCM
    DEFINE APP_S6TEST
    INCLUDE "ugmem.asm"
    ENDMODULE
    ASSERT $ < 0xB800
    ELSE
	ASSERT $ < TX
    ENDIF
	ASSERT TX+1024 <= RX
	ASSERT RX+1024 <= SNAP
	ASSERT CLI+160 <= V
	ASSERT V+144 <= UGMEM_BASE
	END ENTRY
