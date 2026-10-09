; SPDX-License-Identifier: GPL-2.0-or-later
; S5 BLOB benchmark. All clock/console calls occur with ISA closed.
BM EQU 0x5800
BLOOPS EQU BM
BLOOP EQU BM+2
BBLOCK EQU BM+4
BMETHOD EQU BM+6
BDIRECTION EQU BM+7
BCHECK EQU BM+8
BSOAK EQU BM+9
BM_CURRENT EQU BM+13
BC_CURRENT EQU BM+14
BD_CURRENT EQU BM+15
BTIMED EQU BM+16
BPHASE EQU BM+17
BPREV EQU BM+18
BTIMES EQU BM+22 ; setup/payload/end seconds u32
BCOUNTS EQU BM+34 ; command/response/data/status accesses u32
BSOAK_START EQU BM+50
BDELTA EQU BM+54
BWIDTH EQU BM+58
BSTAGNANT EQU BM+60
BLAST EQU BM+62
BSOAK_RAN EQU BM+66
BSOAK_ELAPSED EQU BM+67
BOVERFLOW EQU BM+71
BNONE_TIME EQU BM+72 ; u32 WRITE/READ totals for CHECK=BOTH
BNONE_OVERFLOW EQU BM+80 ; one flag per direction
BENCH_INIT:
    ld hl,BM
    ld de,BM+1
    ld bc,95
    ld (hl),0
    ldir
    ld hl,4
    ld (BLOOPS),hl
    ld hl,256
    ld (BBLOCK),hl
    ld hl,0
    ld (SIZE32),hl
    inc hl
    ld (SIZE32+2),hl
    ld a,4
    ld (BMETHOD),a
    ld a,2
    ld (BDIRECTION),a
    ld (BCHECK),a
    ret
BENCH_OPTION:
    push hl
    ld de,bench_words
    call LOOKUP
    pop hl
    jr c,.numbers
    dec a
    cp 5
    jr nc,.direction
    ld (BMETHOD),a
    xor a
    ret
.direction:
    sub 5
    cp 3
    jr nc,.check
    ld (BDIRECTION),a
    xor a
    ret
.check:
    sub 3
    ld (BCHECK),a
    xor a
    ret
.numbers:
    push hl
    ld de,bytes_prefix
    call PREFIX
    jr c,.loops
    call NUMBER32
    jr c,.bad
    ld hl,NUM32
    ld de,SIZE32
    ld bc,4
    ldir
    pop hl
    xor a
    ret
.loops:
    pop hl
    push hl
    ld de,loops_prefix
    call PREFIX
    jr c,.block
    call NUMBER32
    jr c,.bad
    call .word
    jr c,.bad
    ld (BLOOPS),de
    pop hl
    xor a
    ret
.block:
    pop hl
    push hl
    ld de,block_prefix
    call PREFIX
    jr c,.soak
    call NUMBER32
    jr c,.bad
    call .word
    jr c,.bad
    ex de,hl
    ld de,1025
    or a
    sbc hl,de
    jr nc,.bad
    ld hl,(NUM32)
    ld (BBLOCK),hl
    pop hl
    xor a
    ret
.soak:
    pop hl
    push hl
    ld de,soak_prefix
    call PREFIX
    jr c,.bad
    call NUMBER32
    jr c,.bad
    ld hl,NUM32
    ld de,BSOAK
    ld bc,4
    ldir
    pop hl
    xor a
    ret
.word:
    ld hl,(NUM32+2)
    ld a,h
    or l
    scf
    ret nz
    ld de,(NUM32)
    ld a,d
    or e
    scf
    ret z
    or a
    ret
.bad:
    pop hl
    scf
    ret
BENCH_RUN:
    ld a,(RESP)
    bit 1,a
    jp z,PROTOCOL
    bit 2,a
    jr nz,.caps_ok
    ld a,(BMETHOD)
    or a
    jr z,.caps_ok ; SLOW needs only GS_DATA
    cp 4
    jp nz,PROTOCOL
    xor a
    ld (BMETHOD),a ; ALL can still measure the available GS_DATA path
    ld hl,bulk_skip
    call SHOW
    call NL
.caps_ok:
    ; explicit unsafe STACK and unavailable ALIAS fail before allocation.
    ld a,(BMETHOD)
    cp 3
    jr nz,.alias
    ld a,(UG_NMI_PROFILE)
    cp 1
    jr z,.alias
    ld hl,unsafe_text
    ld (REASON),hl
    jp PROTOCOL
.alias:
    ld a,(BMETHOD)
    cp 2
    jr nz,.allocate
    ld hl,(UG_ALIASCFG)
    ld a,h
    and l
    inc a
    jr nz,.allocate
    ld hl,state_text
    ld (REASON),hl
    jp PROTOCOL
.allocate:
    call BLOB_SETUP
    call RESERVE
    call APP_TIME_CLOCK
    ld hl,NUM32
    ld de,BSOAK_START
    ld bc,4
    ldir
    ld hl,0
    ld (BSTAGNANT),hl
.repeat:
    xor a
    ld (BM_CURRENT),a
.method:
    ld a,(BMETHOD)
    cp 4
    jr z,.selected
    ld b,a
    ld a,(BM_CURRENT)
    cp b
    jp nz,.nextmethod
.selected:
    ld a,(BM_CURRENT)
    or a
    ld a,1
    jr z,.transport
    xor a
.transport:
    ld (DATATRANS),a
    ld a,(BM_CURRENT)
    or a
    jr z,.fixed
    dec a
.fixed:
    ld (UG_METHOD),a
    ld a,(BM_CURRENT)
    cp 2
    jr nz,.stack
    ld hl,(UG_ALIASCFG)
    ld a,h
    and l
    inc a
    jr nz,.stack
    ld hl,alias_skip
    call SHOW
    call NL
    jp .nextmethod
.stack:
    ld a,(BM_CURRENT)
    cp 3
    jr nz,.checks
    ld a,(UG_NMI_PROFILE)
    cp 1
    jr z,.checks
    ld hl,stack_skip
    call SHOW
    call NL
    jp .nextmethod
.checks:
    xor a
    ld (BC_CURRENT),a
.check:
    ld a,(BCHECK)
    cp 2
    jr z,.directions
    ld b,a
    ld a,(BC_CURRENT)
    cp b
    jr nz,.nextcheck
.directions:
    xor a
    ld (BD_CURRENT),a
.direction:
    ld a,(BDIRECTION)
    cp 2
    jr z,.row
    ld b,a
    ld a,(BD_CURRENT)
    cp b
    jr nz,.nextdir
.row:
    ld a,(BM_CURRENT)
    cp 3
    jr nz,.measure
    ld a,(BD_CURRENT)
    or a
    jr z,.measure
    ld hl,stack_read
    call SHOW
    call NL
    jr .nextdir
.measure:
    call BENCH_ROW
.nextdir:
    ld hl,BD_CURRENT
    inc (hl)
    ld a,(hl)
    cp 2
    jr c,.direction
.nextcheck:
    ld hl,BC_CURRENT
    inc (hl)
    ld a,(hl)
    cp 2
    jr c,.check
.nextmethod:
    ld hl,BM_CURRENT
    inc (hl)
    ld a,(hl)
    cp 4
    jp c,.method
    ld a,1
    ld (BSOAK_RAN),a
    ; SOAK repeats completed rows; finite stopped-clock watchdog.
    ld hl,(BSOAK)
    ld de,(BSOAK+2)
    ld a,h
    or l
    or d
    or e
    jp z,.done
    call APP_TIME_CLOCK
    ld hl,(NUM32)
    ld de,(BLAST)
    or a
    sbc hl,de
    jr nz,.moving
    ld hl,(BSTAGNANT)
    inc hl
    ld (BSTAGNANT),hl
    ld de,4096
    or a
    sbc hl,de
    jp nc,.timeout
    jr .elapsed
.moving:
    ld hl,0
    ld (BSTAGNANT),hl
.elapsed:
    ld hl,(NUM32)
    ld (BLAST),hl
    ld hl,BSOAK_START
    call BENCH_DELTA
    ; Accumulate successive modulo-midnight intervals. SOAK may last
    ; longer than one day, so comparing only against the initial clock
    ; would wrap its duration every midnight.
    ld hl,NUM32
    ld de,BSOAK_START
    ld bc,4
    ldir
    ld hl,(BSOAK_ELAPSED)
    ld de,(BDELTA)
    add hl,de
    ld (BSOAK_ELAPSED),hl
    ld hl,(BSOAK_ELAPSED+2)
    ld de,(BDELTA+2)
    adc hl,de
    ld (BSOAK_ELAPSED+2),hl
    jp c,.done
    ld hl,(BSOAK_ELAPSED)
    ld de,(BSOAK)
    or a
    sbc hl,de
    ld hl,(BSOAK_ELAPSED+2)
    ld de,(BSOAK+2)
    sbc hl,de
    jp c,.repeat
.done:
    call SEAL_BLOB
    jp PASS
.timeout:
    ld a,8
    jp EXIT
BENCH_ROW:
    xor a
    ld (BTIMED),a
    ld (BOVERFLOW),a
    ld hl,BTIMES
    ld de,BTIMES+1
    ld bc,27
    ld (hl),0
    ldir
    ld hl,0
    ld (BLOOP),hl
.loop:
    call START_BLOCKS
.block:
    call NEXT_BLOCK
    jr z,.loopdone
    ; Transfer length independent of the conservative ISA chunk.
    ld hl,(BLOCK)
    ld de,(BBLOCK)
    or a
    sbc hl,de
    jr c,.length
    ld (BLOCK),de
.length:
    call PATTERN
    ld a,(BD_CURRENT)
    or a
    jr z,.timed
    ; Seed READ source outside timed pass, FIXED or selected ALIAS.
    xor a
    ld (VERIFY),a
    call WRITE_BLOCK
.timed:
    ld a,(BC_CURRENT)
    ld (VERIFY),a
    call UG_FRAME_CRC
    ld a,255
    ld (BPHASE),a
    ld a,1
    ld (BTIMED),a
    ld a,(BD_CURRENT)
    or a
    jr nz,.read
    call WRITE_BLOCK
    jr .postcheck
.read:
    call READ_BLOCK
.postcheck:
    xor a
    ld (BTIMED),a
    call UG_FRAME_CRC
    ld (VERIFY),a
    ; Independent comparison outside NONE's timed pass.
    ld a,(BD_CURRENT)
    or a
    jr nz,.compare
    ; STACK has no READ path. FIXED readback does not change write choice.
    ld a,(UG_METHOD)
    push af
    xor a
    ld (UG_METHOD),a
    call READ_BLOCK
    pop af
    ld (UG_METHOD),a
.compare:
    call COMPARE_BLOCK
    call ADVANCE
    jr .block
.loopdone:
    ld hl,(BLOOP)
    inc hl
    ld (BLOOP),hl
    ld de,(BLOOPS)
    or a
    sbc hl,de
    jp c,.loop
    ld a,(BSOAK_RAN)
    or a
    ret nz
    ld hl,row_text
    call SHOW
    ld a,(BM_CURRENT)
    ld hl,method_names
    call BENCH_WORD
    call SHOW
    ld hl,direction_text
    call SHOW
    ld a,(BD_CURRENT)
    ld hl,direction_names
    call BENCH_WORD
    call SHOW
    ld hl,check_text
    call SHOW
    ld a,(BC_CURRENT)
    ld hl,check_names
    call BENCH_WORD
    call SHOW
    ld hl,block_text
    call SHOW
    ld hl,(BBLOCK)
    call DEC16
    ld hl,chunk_text
    call SHOW
    ; Publish the actual ISA window ceiling of this method. GS_DATA opens
    ; a separate window per latch byte; ALIAS never crosses its 32 ports.
    ld hl,1
    ld a,(BM_CURRENT)
    or a
    jr z,.print_chunk
    ld hl,(UG_CHUNK)
    cp 2
    jr nz,.print_chunk
    ld de,33
    or a
    sbc hl,de
    ld hl,(UG_CHUNK)
    jr c,.print_chunk
    ld hl,32
.print_chunk:
    call DEC16
    ld hl,loops_text
    call SHOW
    ld hl,(BLOOPS)
    call DEC16
    ld hl,setup_text
    call SHOW
    ld hl,BTIMES
    call DEC32
    ld hl,payload_text
    call SHOW
    ld hl,BTIMES+4
    call DEC32
    ld hl,end_text
    call SHOW
    ld hl,BTIMES+8
    call DEC32
    ld hl,total_text
    call SHOW
    ld hl,(BTIMES)
    ld de,(BTIMES+4)
    add hl,de
    ld (NUM32),hl
    ld hl,(BTIMES+2)
    ld de,(BTIMES+6)
    adc hl,de
    ld (NUM32+2),hl
    jr nc,.sum_end
    ld hl,NUM32
    call BENCH_SATURATE
.sum_end:
    ld hl,(NUM32)
    ld de,(BTIMES+8)
    add hl,de
    ld (NUM32),hl
    ld hl,(NUM32+2)
    ld de,(BTIMES+10)
    adc hl,de
    ld (NUM32+2),hl
    jr nc,.sum_done
    ld hl,NUM32
    call BENCH_SATURATE
.sum_done:
    ld hl,NUM32
    call DEC32
    ld hl,counts_text
    call SHOW
    ld hl,BCOUNTS
    ld b,4
.count:
    push bc
    push hl
    call DEC32
    ld a,'/'
    call OUTCHAR
    pop hl
    ld de,4
    add hl,de
    pop bc
    djnz .count
    ld hl,accuracy_text
    call SHOW
    call NL
    call BENCH_CRC_COST
    ld a,(BOVERFLOW)
    or a
    jr z,.speed
    ld hl,overflow_text
    call SHOW
    jp NL
.speed:
    ; APP_SPEED reports a finite ratio, or INSUFFICIENT_INTERVAL for zero.
    ld hl,NUM32
    ld de,TIMEELAPSED
    ld bc,4
    ldir
    ld hl,(SIZE32)
    push hl
    ld hl,(SIZE32+2)
    push hl
    ld hl,BCOUNTS+8
    ld de,SIZE32
    ld bc,4
    ldir
    call APP_SPEED
    pop hl
    ld (SIZE32+2),hl
    pop hl
    ld (SIZE32),hl
    ret
BENCH_WORD:
    or a
    ret z
.loop:
    ld b,a
.find:
    ld a,(hl)
    inc hl
    or a
    jr nz,.find
    ld a,b
    dec a
    jr nz,.loop
    ret
; A phase hook saves all registers. DSS may clobber IX/IY.
BENCH_SETUP:
    push af
    xor a
    jr BENCH_MARK
BENCH_PAYLOAD:
    push af
    ld a,1
    jr BENCH_MARK
BENCH_END:
    push af
    ld a,2
    jr BENCH_MARK
BENCH_FINISH:
    push af
    ld a,3
BENCH_MARK:
    push bc
    push de
    push hl
    push ix
    push iy
    ld b,a
    ld a,(BTIMED)
    or a
    jr z,.out
    push bc
    call APP_TIME_CLOCK
    ld a,(BPHASE)
    cp 255
    jr z,.start
    ld hl,BPREV
    call BENCH_DELTA
    ld a,(BPHASE)
    add a,a
    add a,a
    ld e,a
    ld d,0
    ld hl,BTIMES
    add hl,de
    ld bc,(BDELTA)
    call BENCH_ADD
    inc hl
    inc hl
    ld bc,(BDELTA+2)
    ld a,(hl)
    add a,c
    ld (hl),a
    inc hl
    ld a,(hl)
    adc a,b
    ld (hl),a
    call c,BENCH_SATURATE_HIGH
.start:
    ld hl,NUM32
    ld de,BPREV
    ld bc,4
    ldir
    pop bc
    ld a,b
    cp 3
    jr z,.data
    ld (BPHASE),a
    jr .out
.data:
    ld hl,BCOUNTS+8
    ld bc,(BLOCK)
    call BENCH_ADD
.out:
    pop iy
    pop ix
    pop hl
    pop de
    pop bc
    pop af
    ret
; NUM32 minus clock pointed by HL, modulo midnight -> BDELTA.
BENCH_DELTA:
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    push de
    ld e,(hl)
    inc hl
    ld d,(hl)
    ld hl,(NUM32+2)
    or a
    sbc hl,de
    ex de,hl
    pop bc
    ld hl,(NUM32)
    or a
    sbc hl,bc
    ex de,hl
    ld bc,0
    sbc hl,bc
    ex de,hl
    jr nc,.save
    ld bc,0x5180
    add hl,bc
    ex de,hl
    ld bc,1
    adc hl,bc
    ex de,hl
.save:
    ld (BDELTA),hl
    ld (BDELTA+2),de
    ret
; Add BC to u32 at HL; returns HL at low word. Timing only, no bus calls.
BENCH_ADD:
    push hl
    ld a,(hl)
    add a,c
    ld (hl),a
    inc hl
    ld a,(hl)
    adc a,b
    ld (hl),a
    inc hl
    ld a,(hl)
    adc a,0
    ld (hl),a
    inc hl
    ld a,(hl)
    adc a,0
    ld (hl),a
    pop hl
    ret nc
    ; Saturate rather than wrap a long run's totals. Do not report a ratio
    ; from saturated data/time/access counts.
BENCH_SATURATE:
    push hl
    ld (hl),255
    inc hl
    ld (hl),255
    inc hl
    ld (hl),255
    inc hl
    ld (hl),255
    ld a,1
    ld (BOVERFLOW),a
    pop hl
    ret
BENCH_SATURATE_HIGH:
    dec hl
    dec hl
    dec hl
    jp BENCH_SATURATE
; Preserve NUM32 (the total) while publishing CRC minus NONE for this
; direction. A negative delta is possible within DSS clock uncertainty.
BENCH_CRC_COST:
    ld a,(BCHECK)
    cp 2
    ret nz
    ld a,(BD_CURRENT)
    ld e,a
    ld d,0
    ld hl,BNONE_OVERFLOW
    add hl,de
    ld a,(BC_CURRENT)
    or a
    jr nz,.checked
    ld a,(BOVERFLOW)
    ld (hl),a
    ld a,e
    add a,a
    add a,a
    ld e,a
    ld hl,BNONE_TIME
    add hl,de
    ex de,hl
    ld hl,NUM32
    ld bc,4
    ldir
    ret
.checked:
    ld a,(BOVERFLOW)
    or (hl)
    jr z,.delta
    ld hl,cost_unknown
    call SHOW
    jp NL
.delta:
    ld a,e
    add a,a
    add a,a
    ld e,a
    ld hl,BNONE_TIME
    add hl,de
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    push hl
    ld hl,(NUM32)
    push hl
    or a
    sbc hl,de
    ex de,hl
    pop hl
    push hl ; saved total low
    pop bc
    pop hl
    push bc
    ld c,(hl)
    inc hl
    ld b,(hl)
    ld hl,(NUM32+2)
    push hl ; saved total high
    sbc hl,bc
    jr nc,.positive
    ; Two's complement the signed difference for ASCII minus/magnitude.
    ex de,hl
    xor a
    sub l
    ld l,a
    ld a,0
    sbc a,h
    ld h,a
    ex de,hl
    ld a,0
    sbc a,l
    ld l,a
    ld a,0
    sbc a,h
    ld h,a
    ld a,'-'
    jr .print
.positive:
    xor a
.print:
    ld (NUM32),de
    ld (NUM32+2),hl
    push af
    ld hl,cost_text
    call SHOW
    pop af
    or a
    call nz,OUTCHAR
    ld hl,NUM32
    call DEC32
    call NL
    pop hl
    ld (NUM32+2),hl
    pop hl
    ld (NUM32),hl
    ret
BENCH_COMMAND_COUNT:
    push hl
    ld hl,BCOUNTS
    jr BENCH_COUNT
BENCH_RESPONSE_COUNT:
    push hl
    ld hl,BCOUNTS+4
BENCH_COUNT:
    push af
    ld a,(BTIMED)
    or a
    call nz,BENCH_ADD
    pop af
    pop hl
    ret
BENCH_STATUS_COUNT:
    push af
    cp 1
    jr z,.count
    cp 0x1b
    jr nz,.out
.count:
    push bc
    push hl
    ld a,(BTIMED)
    or a
    ld bc,1
    ld hl,BCOUNTS+12
    call nz,BENCH_ADD
    pop hl
    pop bc
.out:
    pop af
    ret
bench_words: DB "/METHOD:SLOW",0,1,"/METHOD:FIXED",0,2,"/METHOD:ALIAS",0,3,"/METHOD:STACK",0,4,"/METHOD:ALL",0,5
    DB "/DIRECTION:WRITE",0,6,"/DIRECTION:READ",0,7,"/DIRECTION:BOTH",0,8
    DB "/CHECK:NONE",0,9,"/CHECK:CRC",0,10,"/CHECK:BOTH",0,11,0
bytes_prefix: DB "/BYTES:",0
loops_prefix: DB "/LOOPS:",0
block_prefix: DB "/BLOCK:",0
soak_prefix: DB "/SOAK:",0
method_names: DB "SLOW",0,"FIXED",0,"ALIAS",0,"STACK",0
direction_names: DB "WRITE",0,"READ",0
check_names: DB "NONE",0,"CRC",0
unsafe_text: DB "UNSAFE_NMI",0
state_text: DB "STATE",0
alias_skip: DB "ALIAS SKIP NOT_CONFIGURED",0
stack_skip: DB "STACK SKIP UNSAFE_NMI",0
stack_read: DB "STACK READ NOT_APPLICABLE",0
row_text: DB "BENCH method=",0
direction_text: DB " direction=",0
check_text: DB " check=",0
block_text: DB " block=",0
chunk_text: DB " chunk=",0
loops_text: DB " loops=",0
setup_text: DB " setup_seconds=",0
payload_text: DB " payload_seconds=",0
end_text: DB " end_seconds=",0
total_text: DB " total_seconds=",0
counts_text: DB " command/response/data/status=",0
accuracy_text: DB " postcheck=MATCH resolution_seconds=1 phase_error_seconds<=2*blocks timing_source=DSS_CLOCK REAL_PENDING",0

bulk_skip: DB "BULK SKIP NOT_SUPPORTED",0
cost_text: DB "crc_cost_seconds=",0
cost_unknown: DB "crc_cost_seconds=UNAVAILABLE measurement_overflow=SATURATED",0
overflow_text: DB "measurement_overflow=SATURATED speed=UNAVAILABLE",0
