; SPDX-License-Identifier: GPL-2.0-or-later
; Ultra GS S2 configuration. Real Z80/DSS; no automatic ISA scanning.
    ORG 0x8000
HEADER:
    DB "EXE",1
    DW 128,0,0,0,0,0,ENTRY,ENTRY,0xBFFE
    DS 128-($-HEADER),0
    INCLUDE "ugmem.inc"
CAT EQU 0xB800
RESP EQU 0xB900
CLI EQU 0xBA00
V EQU 0xBB00
SLOT EQU V
QUIET EQU V+1
SAVING EQU V+2
HELP EQU V+3
CMD EQU V+4
ARGC EQU V+5
ARGS EQU V+6
BASE EQU V+12
ALIAS EQU V+14
NEWBASE EQU V+16
NEWALIAS EQU V+18
ACTIVE EQU V+20
DESIRED EQU V+21
BOOT EQU V+22
TARGET EQU V+23
VALID EQU V+24
ERR EQU V+25
GSALIAS EQU V+26
SECSTART EQU V+27
RETRIES EQU V+44
PTR EQU V+30
SEL EQU V+32
VAL EQU V+33
TMP EQU V+35
REASON EQU V+39
FRAMELIVE EQU V+41
WAITMODE EQU V+42
REBOOTSEEN EQU V+43
ENTRY:
    ld b,(ix+0)
    ld a,b
    cp 160
    jp nc,INIT_BAD
    ld hl,CLI
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
    call INIT
    call PARSE
    jp c,SYNTAX
    ld a,(HELP)
    or a
    jr z,.run
    ld hl,help_text
    call PRINT
    jp PASS
.run:
    call VALIDATE_ARGS
    jp c,SYNTAX
    ld a,(CMD)
    cp 3
    jr nz,.discover
    ld a,(TARGET)
    or a
    jp z,UNKNOWN
    cp 9
    jp nc,UNKNOWN
.discover:
    call DISCOVER
    jp c,EXIT
    ld a,(CMD)
    cp 1
    jp z,INFO
    ld a,(VALID)
    or a
    jp z,PROTOCOL
    ld a,(CMD)
    cp 2
    jp z,LIST
    cp 3
    jp z,MODE
    cp 4
    jp z,PORTS
    cp 5
    jp z,GS
    cp 6
    jp z,VERIFY
    call SAVE
    jp c,EXIT
    jp PASS
INIT_BAD:
    call INIT
    jp SYNTAX
INIT:
    ld hl,V
    ld de,V+1
    ld bc,63
    ld (hl),0
    ldir
    ld hl,UGMEM_BASE
    ld de,UGMEM_BASE+1
    ld bc,399
    ld (hl),0
    ldir
    ld hl,0x2A0
    ld (BASE),hl
    ld hl,generic_reason
    ld (REASON),hl
    ret
; Tokenize whitespace; options may appear anywhere. Three positional words max.
PARSE:
    ld hl,CLI
.next:
    ld a,(hl)
    or a
    jr z,.end
    cp ' '
    jr z,.skip
    cp 9
    jr z,.skip
    push hl
.find:
    inc hl
    ld a,(hl)
    or a
    jr z,.found
    cp ' '
    jr z,.cut
    cp 9
    jr nz,.find
.cut:
    ld (hl),0
    inc hl
.found:
    ld (PTR),hl
    pop hl
    ld a,(hl)
    cp '/'
    jr nz,.arg
    call OPTION
    ret c
    jr .resume
.arg:
    ld a,(ARGC)
    cp 3
    jp nc,.bad
    push hl
    add a,a
    ld e,a
    ld d,0
    ld hl,ARGS
    add hl,de
    pop de
    ld (hl),e
    inc hl
    ld (hl),d
    ld hl,ARGC
    inc (hl)
.resume:
    ld hl,(PTR)
    jr .next
.skip:
    inc hl
    jr .next
.end:
    ld a,(HELP)
    or a
    ret nz
    ld a,(ARGC)
    or a
    jp z,.bad
    ld hl,(ARGS)
    ld de,commands
    call LOOKUP
    jp c,.bad
    ld (CMD),a
    ld b,1
    cp 3
    jr z,.two
    cp 5
    jr z,.two
    cp 4
    jr nz,.count
    inc b
.two:
    inc b
.count:
    ld a,(ARGC)
    cp b
    jp nz,.bad
    ld a,(SAVING)
    or a
    ret z
    ld a,(CMD)
    cp 3
    ret z
    cp 4
    ret z
.bad:
    scf
    ret
 ; Validate values before discovery: malformed input must never map ISA.
VALIDATE_ARGS:
    ld a,(CMD)
    cp 3
    jp z,MODE_ARG
    cp 4
    jp z,PORTS_ARGS
    cp 5
    jp z,GS_ARG
    or a
    ret
MODE_ARG:
    ld hl,(ARGS+2)
    ld de,modes
    call LOOKUP
    jr nc,.found
    ; Both decimal and 0x-prefixed IDs are bytes, without truncation.
    ld hl,(ARGS+2)
    call MODE_NUMBER
    ret c
    ld a,e
.found:
    or a
    ld (TARGET),a
    or a
    ret
PORTS_ARGS:
    ld hl,(ARGS+2)
    call HEX
    ret c
    ld (NEWBASE),de
    ex de,hl
    call VALID_BASE
    ret c
    ld hl,(ARGS+4)
    ld de,off_text
    call EQUAL
    ld de,0xFFFF
    jr z,.alias
    ld hl,(ARGS+4)
    call HEX
    ret c
    push de
    ex de,hl
    call VALID_BASE
    pop de
    ret c
.alias:
    ld (NEWALIAS),de
    ld hl,(NEWBASE)
    or a
    sbc hl,de
    scf
    ret z
    or a
    ret
GS_ARG:
    ld hl,(ARGS+2)
    ld de,onoff
    call LOOKUP
    ret c
    dec a
    ld (TARGET),a
    or a
    ret
OPTION:
    push hl
    ld de,options
    call LOOKUP
    pop hl
    jr c,.prefix
    cp 1
    jr nz,.help
    ld (QUIET),a
    or a
    ret
.help:
    cp 2
    jr nz,.save
    ld (HELP),a
    or a
    ret
.save:
    ld (SAVING),a
    or a
    ret
.prefix:
    push hl
    ld de,slot_prefix
    call PREFIX
    jr c,.base
    ld a,(hl)
    sub '0'
    cp 2
    jp nc,.badpop
    ld (SLOT),a
    inc hl
    ld a,(hl)
    or a
    jp nz,.badpop
    pop hl
    ret
.base:
    pop hl
    ld de,base_prefix
    call PREFIX
    ret c
    call HEX
    ret c
    ld (BASE),de
    ex de,hl
    jp VALID_BASE
.badpop:
    pop hl
    scf
    ret
; Table contains NUL word then ID, terminated by empty word.
LOOKUP:
    ld a,(de)
    or a
    scf
    ret z
    push hl
    push de
    call EQUAL
    pop de
    pop hl
    jr z,.match
.skip:
    ld a,(de)
    inc de
    or a
    jr nz,.skip
    inc de
    jr LOOKUP
.match:
    ld a,(de)
    inc de
    or a
    jr nz,.match
    ld a,(de)
    or a
    ret
EQUAL:
    ld a,(de)
    cp (hl)
    ret nz
    inc de
    inc hl
    or a
    jr nz,EQUAL
    ret
PREFIX:
    ld a,(de)
    or a
    ret z
    cp (hl)
    jp nz,.bad
    inc de
    inc hl
    jr PREFIX
.bad:
    scf
    ret
HEX:
    ld de,0
    ld b,0
.loop:
    ld a,(hl)
    or a
    jr z,.end
    sub '0'
    cp 10
    jr c,.digit
    sub 7
    cp 10
    jp c,.bad
    cp 16
    jp nc,.bad
.digit:
    inc b
    push af
    ld a,b
    cp 5
    jr nc,.overflow
    pop af
    ex de,hl
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl
    or l
    ld l,a
    ex de,hl
    inc hl
    jr .loop
.overflow:
    pop af
.bad:
    scf
    ret
.end:
    ld a,b
    or a
    jp z,.bad
    or a
    ret
VALID_BASE:
    ld a,h
    cp 2
    jp c,.bad
    cp 4
    jp nc,.bad
    ld a,l
    and 31
    ret z
.bad:
    scf
    ret
MODE_NUMBER: ; HL=NUL decimal or 0x-prefixed hexadecimal, DE=u8
    ld a,(hl)
    cp '0'
    jr nz,.decimal
    inc hl
    ld a,(hl)
    cp 'X'
    jr nz,.unpeek
    inc hl
    call HEX
    ret c
    ld a,d
    or a
    ret z
    jr .bad
.unpeek:
    dec hl
.decimal:
    ld de,0
    ld b,0
.loop:
    ld a,(hl)
    or a
    jr z,.end
    sub '0'
    cp 10
    jr nc,.bad
    ld c,a
    inc b
    push hl
    ex de,hl
    add hl,hl
    ld d,h
    ld e,l
    add hl,hl
    add hl,hl
    add hl,de
    ld d,0
    ld e,c
    add hl,de
    ex de,hl
    pop hl
    ld a,d
    or a
    jr nz,.bad
    inc hl
    jr .loop
.end:
    ld a,b
    or a
    ret nz
.bad:
    scf
    ret
; ISA windows: all calls, printing, CRC and timeout polling occur outside.
OPEN:
    push af
    push bc
    push de
    push hl
    ld a,(SLOT)
    ld hl,(BASE)
    call UG_ISA_OPEN
    pop hl
    pop de
    pop bc
    pop af
    ret
CLOSE:
    push af
    push bc
    call UG_ISA_CLOSE
    pop bc
    pop af
    ret
SELECT:
    push af
    ld a,0xCC
    ld (0xC1D0),a
    pop af
    ld (0xC1D0),a
    ret
READ8:
    call OPEN
    call SELECT
    ld a,(0xC1D2)
    jp CLOSE
READ16:
    call OPEN
    call SELECT
    ld hl,(0xC1D1)
    jp CLOSE
WRITE8: ; A=selector, E=value
    call OPEN
    call SELECT
    ld a,e
    ld (0xC1D2),a
    jp CLOSE
WRITE16: ; A=selector, DE=value
    call OPEN
    call SELECT
    ld (0xC1D1),de
    call CLOSE
    jp RESULT
RESULT:
    ld a,0x78
    call READ8
    or a
    ret z
    ld a,9
    scf
    ret
DISCOVER:
    xor a
    call READ8
    cp 0xDD
    jr nz,.absent
    ld a,1
    call READ8
    cp 4
    jp nz,PROTOCOL_RET
    ld a,0xE3
    call OPEN
    call SELECT
    call CLOSE
    ld hl,CAT
    ld b,148
.read:
    call OPEN
    ld a,(0xC1D2)
    ld (hl),a
    inc hl
    call CLOSE
    djnz .read
    xor a
    ld (VALID),a
    call VALID_CATALOG
    jr c,.invalid
    ld a,1
    ld (VALID),a
.invalid:
    ld a,3
    call READ8
    ld (DESIRED),a
    ld a,0xE4
    call READ8
    ld (ACTIVE),a
    ld a,0xE5
    call READ8
    ld (BOOT),a
    cp 5
    jr nz,.catalog_status
    xor a
    ld (VALID),a
.catalog_status:
    ld a,(VALID)
    or a
    ret z
    ld a,0x76
    call READ16
    ld (BASE),hl
    ld a,0x77
    call READ16
    ld (ALIAS),hl
    ld a,0x79
    call READ8
    ld (GSALIAS),a
    or a
    ret
.absent:
    ld a,2
    scf
    ret
VALID_CATALOG:
    ld hl,CAT
    ld de,cat_header
    ld b,16
.header:
    ld a,(de)
    cp (hl)
    jp nz,.bad
    inc hl
    inc de
    djnz .header
    ld hl,CAT
    ld bc,144
    call UG_CRC32
    ld hl,CAT+144
    ld de,UGCRC.OUT
    ld b,4
.crc:
    ld a,(de)
    cp (hl)
    jp nz,.bad
    inc de
    inc hl
    djnz .crc
    ld ix,CAT+16
    ld c,1
.record:
    ld a,(ix+0)
    cp c
    jp nz,.bad
    ld a,(ix+1)
    and 0xFC
    jp nz,.bad
    ld a,(ix+2)
    or (ix+3)
    jp nz,.bad
    bit 0,(ix+1)
    jr nz,.present
    ld a,(ix+1)
    or a
    jp nz,.bad
    push ix
    pop hl
    ld de,4
    add hl,de
    ld b,12
.zero:
    ld a,(hl)
    or a
    jp nz,.bad
    inc hl
    djnz .zero
    jr .next
.present:
    ; Flash limit <2MiB, 1024-byte aligned start >=8000h, nonzero length.
    ld a,(ix+7)
    or (ix+11)
    jp nz,.bad
    ld a,(ix+4)
    or a
    jp nz,.bad
    ld a,(ix+5)
    and 3
    jp nz,.bad
    ld a,(ix+6)
    cp 0x20
    jp nc,.bad
    or a
    jr nz,.length
    ld a,(ix+5)
    cp 0x80
    jp c,.bad
.length:
    ld a,(ix+10)
    cp 0x20
    jp nc,.bad
    or a
    jr nz,.bounds
    ld a,(ix+9)
    or a
    jp z,.bad
    cp 1
    jr nz,.bounds
    ld a,(ix+8)
    cp 8
    jp c,.bad
.bounds:
    ; Full offset+length and pairwise interval checks below.
    push bc
    call RECORD_BOUNDS
    pop bc
    jp c,.bad
.next:
    ld de,16
    add ix,de
    inc c
    ld a,c
    cp 9
    jp nz,.record
    or a
    ret
.bad:
    scf
    ret
RECORD_BOUNDS:
    ; TMP=u32 end, check no overflow and end <=1FF000h.
    push ix
    pop hl
    ld de,4
    add hl,de
    ld de,TMP
    ld b,4
    push hl
.copy:
    ld a,(hl)
    ld (de),a
    inc hl
    inc de
    djnz .copy
    ld de,TMP
    ld b,4
    or a
.add:
    ld a,(de)
    adc a,(hl)
    ld (de),a
    inc de
    inc hl
    djnz .add
    pop hl
    jp c,.bad
    ld hl,TMP+3
    ld de,flash_end+3
    call CMP32
    jr c,.endok
    jp nz,.bad
.endok:
    ; Compare current interval against every prior present record.
    ld iy,CAT+16
.loop:
    push ix
    pop hl
    push iy
    pop de
    or a
    sbc hl,de
    ret z
    bit 0,(iy+1)
    jr z,.next
    ; TMP=current end. If prior start >= current end, disjoint.
    push iy
    pop hl
    ld de,7
    add hl,de
    ld de,TMP+3
    call CMP32
    jr nc,.next
    ; prior end in RESP, current start >= prior end => disjoint.
    ld b,4
    push iy
    pop hl
    ld de,4
    add hl,de
    ld de,RESP
.copy2:
    ld a,(hl)
    ld (de),a
    inc hl
    inc de
    djnz .copy2
    ld de,RESP
    ld b,4
    or a
.add2:
    ld a,(de)
    adc a,(hl)
    ld (de),a
    inc hl
    inc de
    djnz .add2
    push ix
    pop hl
    ld de,7
    add hl,de
    ld de,RESP+3
    call CMP32
    jp c,.bad
.next:
    ld de,16
    add iy,de
    jr .loop
.bad:
    scf
    ret
CMP32: ; HL/DE point to most significant byte, unsigned compare
    ld b,4
.loop:
    ld a,(de)
    ld c,a
    ld a,(hl)
    cp c
    ret nz
    dec hl
    dec de
    djnz .loop
    ret
INFO:
    ld a,(VALID)
    or a
    jr z,.report
    call CHECK_ACTIVE
    jp c,EXIT
.report:
    ld a,(QUIET)
    or a
    jp nz,PASS
    ld hl,info_text
    call PRINT
    ld a,(DESIRED)
    call HEX8
    ld hl,active_text
    call PRINT
    ld a,(ACTIVE)
    call HEX8
    ld hl,boot_text
    call PRINT
    ld a,(BOOT)
    call HEX8
    ld hl,newline
    call PRINT
    ld a,(VALID)
    or a
    jr nz,.ports
    ld hl,invalid_text
    call PRINT
    jp PASS
.ports:
    ld hl,ports_text
    call PRINT
    ld hl,(BASE)
    call HEX16
    ld a,'-'
    call CHAR
    ld hl,(BASE)
    ld de,31
    add hl,de
    call HEX16
    ld hl,alias_text
    call PRINT
    ld hl,(ALIAS)
    ld a,h
    and l
    cp 0xFF
    jr nz,.alias_range
    ld hl,off_text
    call PRINT
    jr .gs
.alias_range:
    call HEX16
    ld a,'-'
    call CHAR
    ld hl,(ALIAS)
    ld de,31
    add hl,de
    call HEX16
.gs:
    ld hl,gs_text
    call PRINT
    ld a,(GSALIAS)
    or a
    ld hl,gs_off
    jr z,.gsprint
    ld hl,gs_on
.gsprint:
    call PRINT
    ld a,(ACTIVE)
    cp 8
    jr nz,.endinfo
    ld hl,build_text
    call PRINT
    ld hl,RESP+22
    ld b,16
.build:
    push bc
    push hl
    ld a,(hl)
    call CHAR
    pop hl
    pop bc
    inc hl
    djnz .build
.endinfo:
    ld hl,newline
    call PRINT
    jp PASS
LIST:
    ld a,(QUIET)
    or a
    jp nz,PASS
    ld ix,CAT+16
    ld b,8
.loop:
    push bc
    push ix
    ld a,(ix+1)
    ld (TMP),a
    ld a,(ix+0)
    call HEX8
    ld a,(TMP)
    ld hl,absent_text
    bit 0,a
    jr z,.print
    ld hl,present_text
    bit 1,a
    jr z,.print
    ld hl,verified_text
.print:
    call PRINT
    pop ix
    ld de,16
    add ix,de
    pop bc
    djnz .loop
    jp PASS
MODE:
    ld a,(TARGET)
    dec a
    ld l,a
    ld h,0
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl
    ld de,CAT+17
    add hl,de
    bit 0,(hl)
    jp z,ABSENT
    ld a,(ACTIVE)
    cp 8
    jr nz,.write
    ld hl,lost_text
    call PRINT
.write:
    ld a,(TARGET)
    ld e,a
    ld a,3
    call WRITE8
    call RESULT
    jp c,EXIT
    call MAYBE_SAVE
    jp c,EXIT
    ld a,0xE2
    ld e,0xFF
    call WRITE8
    call START_WAIT
    ld a,1
    ld (WAITMODE),a
.wait:
    call CHECK_WAIT
    jp c,EXIT
    ; Do not accept the old runtime (including its old fallback result).
    ; Observe loss of identification before accepting the next boot.
    xor a
    call READ8
    cp 0xDD
    jr z,.identified
    ld a,1
    ld (REBOOTSEEN),a
    jr .wait
.identified:
    ld a,(REBOOTSEEN)
    or a
    jr z,.wait
    call DISCOVER
    jr nc,.discovered
    cp 2
    jr z,.wait
    jp EXIT
.discovered:
    ld a,(VALID)
    or a
    jr nz,.catalog_ok
    ld a,(BOOT)
    cp 5
    jp z,FALLBACK
    jp PROTOCOL
.catalog_ok:
    ld a,(BOOT)
    or a
    jp nz,FALLBACK
    ld a,(TARGET)
    ld b,a
    ld a,(ACTIVE)
    cp b
    jr nz,.wait
    call CHECK_ACTIVE
    jp c,EXIT
    jp PASS
VERIFY:
    ld a,(BOOT)
    or a
    jp nz,FALLBACK
    ld a,(DESIRED)
    ld b,a
    ld a,(ACTIVE)
    cp b
    jp nz,VERIFY_FAIL
    call CHECK_ACTIVE
    jp c,EXIT
    jp PASS
PORTS:
    ld hl,(NEWBASE)
    ld de,(NEWALIAS)
    call APPLY_PAIR
    jr nc,.save
    ; BUSY or a rejected first write can leave the original pair intact.
    ; Confirm that before attempting rollback, and again after a refusal.
    call OLD_PAIR
    jp z,VERIFY_FAIL
    ; Restore old pair after any failure; never SAVE partial configuration.
    ld hl,(BASE)
    ld de,(ALIAS)
    call APPLY_PAIR
    jr nc,.restored
    call OLD_PAIR
    jp nz,PARTIAL
.restored:
    jp VERIFY_FAIL
.save:
    call MAYBE_SAVE
    jp c,EXIT
    jp PASS
OLD_PAIR:
    ld a,0x76
    call READ16
    ld de,(BASE)
    or a
    sbc hl,de
    ret nz
    ld a,0x77
    call READ16
    ld de,(ALIAS)
    or a
    sbc hl,de
    ret
APPLY_PAIR: ; HL base, DE alias. Disable alias before a swap; read back each write.
    push de
    push hl
    ld de,0xFFFF
    ld a,0x77
    call SET_PORT
    jr c,.fail
    pop de
    push de
    ld a,0x76
    call SET_PORT
    jr c,.fail
    pop hl
    pop de
    ld a,0x77
    jp SET_PORT
.fail:
    pop hl
    pop de
    scf
    ret
SET_PORT:
    ld (SEL),a
    ld (VAL),de
    call WRITE16
    ret c
    ld a,(SEL)
    call READ16
    ld de,(VAL)
    or a
    sbc hl,de
    ret z
    ld a,9
    scf
    ret
GS:
    ld a,(TARGET)
    or a
    jr z,.write
    ld hl,warning_text
    call PRINT
.write:
    ld a,(TARGET)
    ld e,a
    ld a,0x79
    call WRITE8
    call RESULT
    jp c,EXIT
    jp PASS
MAYBE_SAVE:
    ld a,(SAVING)
    or a
    ret z
SAVE:
    ld a,0xE1
    ld e,0xFF
    call WRITE8
    call START_WAIT
.loop:
    ld a,0x78
    call READ8
    or a
    ret z
    cp 5
    jp nz,.bad
    call CHECK_WAIT
    ret c
    jr .loop
.bad:
    ld a,9
    scf
    ret
START_WAIT:
    ld c,0x21
    rst 0x10
    ld a,b
    ld (SECSTART),a
    xor a
    ld (RETRIES),a
    ld (RETRIES+1),a
    ld (RETRIES+2),a
    ret
CHECK_WAIT:
    ld c,0x31
    rst 0x10
    cp 27
    jr z,.cancel
    ld c,0x21
    rst 0x10
    ld a,(SECSTART)
    ld c,a
    ld a,b
    sub c
    jr nc,.elapsed
    add a,60
.elapsed:
    cp 10
    jr nc,.timeout
    ; A stopped DSS clock still has a finite escape. This limit is large
    ; enough to let the real 10-second deadline run at both CPU speeds.
    ld hl,RETRIES
    inc (hl)
    jr nz,.counted
    inc hl
    inc (hl)
    jr nz,.counted
    inc hl
    inc (hl)
    ld a,(hl)
    cp 0x10
    jr nc,.timeout
.counted:
    or a
    ret
.cancel:
    ld a,10
    scf
    ret
.timeout:
    ld a,8
    scf
    ret
; Minimal INFO with FRAME_CRC. No speculative future capabilities.
CHECK_ACTIVE:
    ld a,(ACTIVE)
    cp 8
    jr z,.ultra
    or a
    ret
.ultra:
    ld a,(WAITMODE)
    or a
    jr nz,.ready
    call START_WAIT
.ready:
    call CHECK_WAIT
    ret c
    ld e,1
    call REG_READ
    bit 0,a
    jr z,.ready
    ld a,1
    ld (FRAMELIVE),a
    ld e,3
    ld a,0x80
    call REG_WRITE
    xor a
    call REG_WRITE
    ; CRC of request 80 00, computed using the shared assembly CRC routine.
    ld hl,request_info
    ld bc,2
    call UG_CRC32
    ld hl,UGCRC.OUT
    ld b,4
.send:
    ld a,(hl)
    call REG_WRITE
    inc hl
    djnz .send
.reply:
    call CHECK_WAIT
    ret c
    ld e,1
    call REG_READ
    bit 2,a
    jr z,.reply
    ld hl,RESP
    ld b,42
    ld e,3
.read:
    call REG_READ
    ld (hl),a
    inc hl
    djnz .read
    ld a,(RESP)
    or a
    jp nz,.bad
    ld a,(RESP+1)
    cp 36
    jp nz,.bad
    ; Authenticate the complete frame before interpreting API/boot_state.
    ld hl,RESP
    ld bc,38
    call UG_CRC32
    ld hl,RESP+38
    ld de,UGCRC.OUT
    ld b,4
.crc:
    ld a,(de)
    cp (hl)
    jp nz,.bad
    inc hl
    inc de
    djnz .crc
    ld a,(RESP+6)
    cp 1
    jr nz,.api
    ld a,(RESP+7)
    or a
    jr nz,.api
    ld hl,RESP+2
    ld de,info_magic
    ld b,7
.magic:
    ld a,(de)
    cp (hl)
    jp nz,.bad
    inc hl
    inc de
    djnz .magic
    ld a,(RESP+9)
    cp 2
    jp z,.ready
    cp 1
    jr z,.memory
    cp 3
    jr z,.audio
    or a
    jp nz,.bad
    or a
    ret
.api:
    ld a,3
    scf
    ret
.memory:
    ld a,4
    scf
    ret
.audio:
    ld a,7
    scf
    ret
.bad:
    ld a,9
    scf
    ret
REG_READ:
    push hl
    ld hl,(BASE)
    ld d,0
    add hl,de
    set 6,h
    set 7,h
    call OPEN
    ld a,(hl)
    call CLOSE
    pop hl
    ret
REG_WRITE:
    push hl
    push af
    ld hl,(BASE)
    ld d,0
    add hl,de
    set 6,h
    set 7,h
    call OPEN
    pop af
    ld (hl),a
    call CLOSE
    pop hl
    ret
UNKNOWN:
    ld hl,unknown_text
    jr FAIL_REASON
ABSENT:
    ld hl,absent_reason
    jr FAIL_REASON
PARTIAL:
    ld hl,partial_text
    jr FAIL_REASON
FALLBACK:
    ld hl,fallback_text
FAIL_REASON:
    ld (REASON),hl
VERIFY_FAIL:
    ld a,9
    jp EXIT
SYNTAX:
    ld a,1
    jp EXIT
PROTOCOL:
    ld a,3
    jp EXIT
PROTOCOL_RET:
    ld a,3
    scf
    ret
PASS:
    xor a
EXIT:
    ld (ERR),a
    ; Preserve explicit failure reasons; give generic failures stable tokens.
    ld hl,(REASON)
    ld de,generic_reason
    or a
    sbc hl,de
    jr nz,.cleanup
    ld a,(ERR)
    ld hl,syntax_text
    cp 1
    jr z,.reason
    ld hl,no_card_text
    cp 2
    jr z,.reason
    ld hl,protocol_text
    cp 3
    jr z,.reason
    ld hl,timeout_text
    cp 8
    jr z,.reason
    ld hl,cancel_text
    cp 10
    jr nz,.cleanup
.reason:
    ld (REASON),hl
.cleanup:
    call CLOSE
    ld a,(FRAMELIVE)
    or a
    jr z,.result
    ld e,2
    ld a,0xA0
    call REG_WRITE
.result:
    ld a,(ERR)
    or a
    jr nz,.fail
    ld hl,pass_text
    call PRINT
    jr .exit
.fail:
    ld hl,fail_text
    call PRINT
    ld a,(ERR)
    cp 10
    jr c,.digit
    ld a,'1'
    call CHAR
    xor a
.digit:
    add a,'0'
    call CHAR
    ld hl,reason_text
    call PRINT
    ld hl,(REASON)
    call PRINT
    ld hl,newline
    call PRINT
.exit:
    ld a,(ERR)
    ld b,a
    ld c,0x41
    rst 0x10
PRINT:
    ld c,0x5C
    rst 0x10
    ret
CHAR:
    ld c,0x5B
    rst 0x10
    ret
HEX16:
    push hl
    ld a,h
    call HEX8
    pop hl
    ld a,l
HEX8:
    push af
    rrca
    rrca
    rrca
    rrca
    call NIBBLE
    pop af
NIBBLE:
    and 15
    add a,'0'
    cp '9'+1
    jr c,CHAR
    add a,7
    jr CHAR
commands: DB "INFO",0,1,"LIST",0,2,"MODE",0,3,"PORTS",0,4,"GSALIAS",0,5,"VERIFY",0,6,"SAVE",0,7,0
options: DB "/QUIET",0,1,"/?",0,2,"/SAVE",0,3,0
modes: DB "GUS",0,1,"ADLIB",0,2,"MPU",0,3,"PSG",0,4,"SB",0,5,"USB",0,6,"NE2000",0,7,"ULTRAGS",0,8,0
onoff: DB "OFF",0,1,"ON",0,2,0
slot_prefix: DB "/SLOT:",0
base_prefix: DB "/BASE:",0
off_text: DB "OFF",0
cat_header: DB "UGCF",1,0,8,16,148,0,0,0,0,0,0,0
flash_end: DB 0,0xF0,0x1F,0
request_info: DB 0x80,0
info_magic: DB "UGS1",1,0,8
help_text: DB "UGCFG INFO|LIST|MODE name-or-id [/SAVE]|PORTS base alias-or-OFF [/SAVE]",13,10
    DB "GSALIAS ON|OFF|VERIFY|SAVE /SLOT:0|1 /BASE:hex /QUIET /?",13,10,0
info_text: DB "protocol=4 desired=",0
active_text: DB " active=",0
boot_text: DB " boot_result=",0
ports_text: DB "config=01D0-01D2 base=",0
alias_text: DB " bulk_alias=",0
gs_text: DB " GS_ALIASES=",0
gs_off: DB "OFF",0
gs_on: DB "ON (00B3,00BB)",0
build_text: DB " build=",0
invalid_text: DB "CATALOG_INVALID read-only recovery/legacy",13,10,0
unknown_text: DB "UNKNOWN",0
absent_reason: DB "ABSENT",0
absent_text: DB " ABSENT",13,10,0
present_text: DB " PRESENT NOT_CHECKED",13,10,0
verified_text: DB " PRESENT VERIFIED",13,10,0
warning_text: DB "WARNING GS aliases 00B3/00BB may conflict with other ISA devices; volatile",13,10,0
lost_text: DB "WARNING switching mode discards Ultra GS runtime objects",13,10,0
partial_text: DB "PARTIAL_CONFIGURATION",0
fallback_text: DB "BOOT_FALLBACK",0
generic_reason: DB "CONFIGURATION",0
syntax_text: DB "SYNTAX",0
no_card_text: DB "NO_CARD",0
protocol_text: DB "PROTOCOL_API",0
timeout_text: DB "TIMEOUT",0
cancel_text: DB "CANCEL",0
pass_text: DB "RESULT PASS code=0",13,10,0
fail_text: DB "RESULT FAIL code=",0
reason_text: DB " reason=",0
newline: DB 13,10,0
    INCLUDE "isa.asm"
    INCLUDE "ugcrc.asm"    ASSERT $ < 0xB800
