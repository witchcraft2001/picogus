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
DIAG EQU V+47
MAGIC EQU V+48
PROTO EQU V+49
BOARD EQU V+50
CATERROR EQU V+51
GOT EQU V+52
EXPECT EQU V+53
STAGE EQU V+54
SAVESEEN EQU V+55
STARTED EQU V+56
OLD_ACTIVE EQU V+57
CATREAD EQU V+58
RESPLEN EQU V+59
INFOBYTES EQU V+60
WAITSECS EQU V+61
SESSION_PROBE EQU V+62
OLD_SESSION_VALID EQU V+63
FWSTR EQU V+64
CATCRC EQU V+128
OLD_SESSION EQU V+136
OLD_BOOT EQU V+132
INFOQUERIES EQU V+144
PORTREAD EQU V+146
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
    jr nc,.found
    push af
    ld a,(CMD)
    cp 1
    call z,REPORT_COMMON
    pop af
    jp EXIT
.found:
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
    ld bc,159
    ld (hl),0
    ldir
    ld hl,CAT
    ld de,CAT+1
    ld bc,511
    ld (hl),0
    ldir
    ld hl,UGMEM_BASE
    ld de,UGMEM_BASE+1
    ld bc,399
    ld (hl),0
    ldir
    ld a,0xFF
    ld (MAGIC),a
    ld (PROTO),a
    ld (BOARD),a
    ld (ACTIVE),a
    ld (DESIRED),a
    ld (BOOT),a
    ld hl,0x2A0
    ld (BASE),hl
    ld hl,generic_reason
    ld (REASON),hl
    ld a,10
    ld (WAITSECS),a
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
    jr nz,.command
    ld a,1 ; no command means INFO
    ld (CMD),a
    jr .options
.command:
    ld hl,(ARGS)
    ld de,commands
    call LOOKUP
    jr nc,.known
    ld hl,(ARGS)
    ld de,modes
    call LOOKUP
    jp c,.bad
    ld a,(ARGC)
    cp 1
    jp nz,.bad
    ld hl,(ARGS)
    ld (ARGS+2),hl
    ld a,3
    ld (CMD),a
    jr .options
.known:
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
.options:
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
    cp 4
    jr nz,.slotword
    ld (DIAG),a
    or a
    ret
.slotword:
    cp 5
    jr z,.slotnext
    ld (SAVING),a
    or a
    ret
.slotnext:
    ld hl,(PTR)
.skipspace:
    ld a,(hl)
    cp ' '
    jr z,.spaces
    cp 9
    jr nz,.slotdigit
.spaces:
    inc hl
    jr .skipspace
.slotdigit:
    sub '0'
    cp 2
    jr nc,.badslot
    ld (SLOT),a
    inc hl
    ld a,(hl)
    or a
    jr z,.slotend
    cp ' '
    jr z,.slotend
    cp 9
    jr nz,.badslot
.slotend:
    ld (PTR),hl
    or a
    ret
.badslot:
    scf
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
    ld a,(SLOT)
    ld (UGCTX.SLOT),a
    ld hl,(BASE)
    ld (UGCTX.BASE),hl
    pop af
    call UG_CFG_SELECT
    jr c,.failed
    ; Boot deadline remains global across all configuration registers.
    push bc
    push de
    push hl
    ld a,(WAITMODE)
    or a
    call nz,CHECK_WAIT
    pop hl
    pop de
    pop bc
    ret
.failed:
    cp UG_ERR_CANCELLED
    ld a,10
    scf
    ret z
    ld a,(UGCFG.OUTERFAIL)
    or a
    ld a,8
    scf
    ret nz
    ld hl,selector_text
    ld (REASON),hl
    ld a,(UGCFG.SEL)
    ld (EXPECT),a
    ld a,(UGCFG.OBS)
    ld (GOT),a
    ld a,8
    scf
    ret
READ8:
    push hl
    call SELECT
    pop hl
    ret c
    jp UG_CFG_DATA8
READ16:
    call SELECT
    ret c
    call OPEN
    ld hl,(0xC1D1)
    call CLOSE
    or a
    ret
WRITE8: ; A=selector, E=value; never replay a data write
    push hl
    call SELECT
    pop hl
    ret c
    call OPEN
    ld a,e
    ld (0xC1D2),a
    call CLOSE
    or a
    ret
WRITE16:
    call SELECT
    ret c
    call OPEN
    ld (0xC1D1),de
    call CLOSE
    jp RESULT
RESULT:
    ld a,0x78
    call READ8
    ret c
    or a
    ret z
    ld a,9
    scf
    ret
DISCOVER:
    xor a
    ld (VALID),a
    ld (CATREAD),a
    ld (INFOBYTES),a
    ld (PORTREAD),a
    ld a,1
    ld (STAGE),a
    xor a
    call READ8
    jp c,.selectfail
    ld (MAGIC),a
    cp 0xDD
    jp nz,.absent
    ld a,1
    call READ8
    ret c
    ld (PROTO),a
    ld a,0xF0
    call READ8
    ret c
    ld (BOARD),a
    ld a,2
    call SELECT
    ret c
    ld hl,FWSTR
    ld b,63
.firmware:
    call UG_CFG_DATA8
    ld (hl),a
    or a
    jr z,.firmware_end
    cp 32
    jr c,.fw_bad
    cp 127
    jr c,.fw_next
.fw_bad:
    ld (hl),'?'
.fw_next:
    inc hl
    djnz .firmware
    ld (hl),0
.firmware_end:
    ld a,3
    call READ8
    ret c
    ld (DESIRED),a
    ld a,(PROTO)
    ld (GOT),a
    ld a,4
    ld (EXPECT),a
    ld a,(PROTO)
    cp 4
    jp nz,PROTOCOL_RET
    ld a,2
    ld (STAGE),a
    ld a,0xE3
    call SELECT
    ret c
    ld hl,CAT
    ld b,148
.read:
    call UG_CFG_DATA8
    ld (hl),a
    inc hl
    djnz .read
    ld a,1
    ld (CATREAD),a
    xor a
    ld (VALID),a
    call VALID_CATALOG
    push af
    ld hl,RESP
    ld de,RESP+1
    ld bc,41
    ld (hl),0
    ldir
    pop af
    jr c,.invalid
    ld a,1
    ld (VALID),a
.invalid:
    ld a,0xE4
    call READ8
    ret c
    ld (ACTIVE),a
    ld a,0xE5
    call READ8
    ret c
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
    ret c
    ld (BASE),hl
    ld a,0x77
    call READ16
    ret c
    ld (ALIAS),hl
    ld a,1
    ld (PORTREAD),a
    call CHECK_PORTS
    ret c
    ld a,0x79
    call READ8
    ret c
    ld (GSALIAS),a
    or a
    ret
.selectfail:
    cp 10
    scf
    ret z
    ; An all-FF bus during initial discovery retains NO_CARD exit code.
    ld a,(UGCFG.OBS)
    cp 0xFF
    ld a,8
    scf
    ret nz
    ld a,2
    scf
    ret
.absent:
    ld a,(MAGIC)
    ld (GOT),a
    ld a,0xDD
    ld (EXPECT),a
    ld a,2
    scf
    ret
CHECK_PORTS:
    ld hl,(BASE)
    call VALID_BASE
    jr c,.bad
    ld hl,(ALIAS)
    ld a,h
    and l
    cp 0xFF
    ret z
    call VALID_BASE
    jr c,.bad
    ld de,(BASE)
    or a
    sbc hl,de
    jr z,.bad
    xor a
    ret
.bad:
    ld hl,invalid_ports_text
    ld (REASON),hl
    ld a,9
    scf
    ret
VALID_CATALOG:
    ld hl,CAT
    ld bc,144
    call UG_CRC32
    ld hl,UGCRC.OUT
    ld de,CATCRC
    ld bc,4
    ldir
    ld a,1
    ld (CATERROR),a
    ld hl,CAT
    ld de,cat_header
    ld b,16
.header:
    ld a,(de)
    cp (hl)
    jp nz,.byte_bad
    inc hl
    inc de
    djnz .header
    ld hl,CAT
    ld bc,144
    call UG_CRC32
    ld a,2
    ld (CATERROR),a
    ld hl,CAT+144
    ld de,UGCRC.OUT
    ld b,4
.crc:
    ld a,(de)
    cp (hl)
    jp nz,.byte_bad
    inc de
    inc hl
    djnz .crc
    ld a,3
    ld (CATERROR),a
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
    xor a
    ld (CATERROR),a
    or a
    ret
.bad:
    xor a
    ld (EXPECT),a
    ld a,3 ; invalid record layout, raw records available in /DIAG
    ld (GOT),a
    scf
    ret
.byte_bad:
    ld (EXPECT),a
    ld a,(hl)
    ld (GOT),a
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
    call REPORT_COMMON
    ld a,(VALID)
    or a
    jr nz,.active
    ; Legacy firmware may lack all extension registers. A known active mode
    ; with a damaged catalogue is a failed check even in read-only INFO.
    ld a,(ACTIVE)
    cp 0xFF
    jp z,PASS
    jp PROTOCOL
.active:
    call CHECK_ACTIVE
    jp c,EXIT
    call REPORT_INFO
    jp PASS
REPORT_INFO:
    ld a,(QUIET)
    or a
    ret nz
    ld a,(ACTIVE)
    cp 8
    ret nz
    ld hl,ready_info_text
    call PRINT
    ld hl,RESP+22
    ld b,16
.build:
    ld a,(hl)
    cp 32
    jr c,.replace
    cp 127
    jr c,.char
.replace:
    ld a,'?'
.char:
    call CHAR
    inc hl
    djnz .build
    ld hl,newline
    jp PRINT
REPORT_COMMON:
    ld a,(QUIET)
    or a
    ret nz
    ld hl,slot_text
    call PRINT
    ld a,(SLOT)
    call HEX8
    ld hl,board_text
    call PRINT
    ld a,(BOARD)
    call HEX8
    ld hl,firmware_text
    call PRINT
    ld hl,FWSTR
    call PRINT
    ld hl,newline
    call PRINT
    ld hl,info_text
    call PRINT
    ld a,(PROTO)
    call HEX8
    ld hl,desired_text
    call PRINT
    ld a,(DESIRED)
    call PRINT_MODE
    ld hl,active_text
    call PRINT
    ld a,(ACTIVE)
    call PRINT_MODE
    ld hl,boot_text
    call PRINT
    ld a,(BOOT)
    call HEX8
    ld hl,newline
    call PRINT
    ld a,(VALID)
    or a
    jr nz,.ports
    ld a,(CATREAD)
    or a
    ret z
    ld hl,invalid_text
    call PRINT
    call CATALOG_REASON
    call PRINT
    ld hl,newline
    jp PRINT
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
    ld hl,newline
    jp PRINT
PRINT_MODE:
    push af
    call HEX8
    ld a,' '
    call CHAR
    pop af
    ld hl,modes
    ld b,a
.scan:
    ld a,(hl)
    or a
    jr z,.unknown
    push hl
.skip:
    ld a,(hl)
    inc hl
    or a
    jr nz,.skip
    ld a,(hl)
    inc hl
    cp b
    jr z,.found
    pop de
    jr .scan
.found:
    pop hl
    jp PRINT
.unknown:
    ld hl,unknown_text
    jp PRINT
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
    call PRINT_MODE
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
    ld a,(ACTIVE)
    ld (OLD_ACTIVE),a
    ld a,(BOOT)
    ld (OLD_BOOT),a
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
    ; A changed INFO session can prove a same-mode ULTRAGS reboot when
    ; the whole offline interval falls between two polls. Never consume
    ; another client's response to obtain it; probe only an idle transport.
    ld a,(ACTIVE)
    cp 8
    jr nz,.warn
    ld a,(TARGET)
    cp 8
    jr nz,.warn
    ld a,1
    ld (SESSION_PROBE),a
    call CHECK_ACTIVE
    push af
    call CLEAN_OWN_FRAME
    pop af
    jr nc,.probe_valid
    cp 10
    jp z,EXIT ; ESC during the optional old-session probe is cancellation
    jr .probe_done
.probe_valid:
    ld hl,RESP+14
    ld de,OLD_SESSION
    ld b,8
    ld c,0
.session_copy:
    ld a,(hl)
    ld (de),a
    or c
    ld c,a
    inc hl
    inc de
    djnz .session_copy
    ld a,c
    or a
    jr z,.probe_done
    ld a,1
    ld (OLD_SESSION_VALID),a
.probe_done:
    xor a
    ld (SESSION_PROBE),a
    ld hl,generic_reason
    ld (REASON),hl
.warn:
    ld a,(ACTIVE)
    cp 8
    jr nz,.write
    ld hl,lost_text
    call PRINT
.write:
    ld hl,selecting_text
    call PROGRESS
    ld a,3
    ld (STAGE),a
    ld a,(TARGET)
    ld e,a
    ld a,3
    call WRITE8
    jp c,EXIT
    call RESULT
    jp c,EXIT
    ld hl,reboot_text
    call PROGRESS
    ld a,0xE2
    ld e,0xFF
    call WRITE8
    jp c,EXIT
    ld hl,waiting_text
    call PROGRESS
    ld a,10
    ld (WAITSECS),a
    call START_WAIT
    ld a,1
    ld (WAITMODE),a
.wait:
    call CHECK_WAIT
    jp c,EXIT
    ; Require observed reboot disappearance; an old selector mismatch alone
    ; is not proof (it may be a delayed select on the old running firmware).
    ld a,(REBOOTSEEN)
    or a
    jr nz,.identified
    xor a
    ld (UGCFG.SEL),a
    call UG_CFG_TRY
    ld a,(UGCFG.OBS)
    cp 0xFF
    jr z,.disappeared
    ; A fast reboot can finish between two polls. A changed active mode
    ; proves we left the old runtime even when no offline read was sampled.
    ld a,(OLD_ACTIVE)
    ld b,a
    ld a,(TARGET)
    cp b
    jr nz,.different_mode
    ld a,(OLD_SESSION_VALID)
    or a
    jr z,.boot_probe
    ld a,0xE4
    call READ8
    jp c,EXIT
    ld b,a
    ld a,(OLD_ACTIVE)
    cp b
    jr nz,.identified
    call CHECK_ACTIVE
    jp c,EXIT
    ld hl,RESP+14
    ld de,OLD_SESSION
    ld b,8
.session_compare:
    ld a,(de)
    cp (hl)
    jr nz,.identified
    inc de
    inc hl
    djnz .session_compare
    jp .wait
.different_mode:
    ld a,0xE4
    call READ8
    jp c,EXIT
    ld b,a
    ld a,(OLD_ACTIVE)
    cp b
    jr nz,.identified
.boot_probe:
    ld a,0xE5
    call READ8
    jp c,EXIT
    ld b,a
    ld a,(OLD_BOOT)
    cp b
    jp z,.wait
    jr .identified
.disappeared:
    ld a,1
    ld (REBOOTSEEN),a
    jr .wait
.identified:
    ; An offline card has no selector to confirm. Poll non-consuming CONTROL
    ; first, so the outer deadline/watchdog is not multiplied by nested waits.
    call OPEN
    ld a,(0xC1D0)
    call CLOSE
    cp 0xFF
    jp z,.wait
    call DISCOVER
    jr nc,.discovered
    cp 2
    jp z,.wait
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
    jp nz,.wait
    call CHECK_ACTIVE
    jp c,EXIT
    ld a,1
    ld (STARTED),a
    ld hl,started_text
    call PROGRESS
    call MAYBE_SAVE
    jp c,EXIT
    jp PASS
VERIFY:
    call CHECK_BOOT
    jp c,EXIT
    call CHECK_ACTIVE
    jp c,EXIT
    jp PASS
CHECK_BOOT:
    xor a
    ld (EXPECT),a
    ld a,(BOOT)
    ld (GOT),a
    or a
    ld hl,fallback_text
    jr nz,.fail
    ld a,(DESIRED)
    ld (EXPECT),a
    ld b,a
    ld a,(ACTIVE)
    ld (GOT),a
    cp b
    ret z
    ld hl,mode_mismatch_text
.fail:
    ld (REASON),hl
    ld a,9
    scf
    ret
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
    ld hl,(NEWBASE)
    ld (BASE),hl
    ld hl,(NEWALIAS)
    ld (ALIAS),hl
    call MAYBE_SAVE
    jp c,EXIT
    jp PASS
OLD_PAIR:
    ld a,0x76
    call READ16
    ret c
    ld de,(BASE)
    or a
    sbc hl,de
    ret nz
    ld a,0x77
    call READ16
    ret c
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
    ret c
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
    jp c,EXIT
    call RESULT
    jp c,EXIT
    jp PASS
MAYBE_SAVE:
    ld a,(SAVING)
    or a
    ret z
SAVE:
    xor a
    ld (WAITMODE),a
    ; Finish our INFO reply before testing transport idle / requesting Flash.
    call CHECK_BOOT
    ret c
    call CHECK_ACTIVE
    ret c
    ld hl,saving_text
    call PROGRESS
    ld a,5
    ld (STAGE),a
    ld hl,save_uncertain_text
    ld (REASON),hl
    xor a
    ld (EXPECT),a
    ld (SAVESEEN),a
    ; A previous maintenance operation must not supply BUSY->OK for our
    ; request. Refuse before issuing SAVE unless the config result is idle.
    ld a,0x78
    call READ8
    ret c
    ld (GOT),a
    or a
    jr z,.issue
    ld hl,save_not_started_text
    ld (REASON),hl
    cp 5
    ld a,8
    scf
    ret z
    ld a,9
    ret
.issue:
    ld a,0xE1
    ld e,0xFF
    call WRITE8
    ret c
    call START_WAIT
.loop:
    ld a,0x78
    call READ8
    jr c,.uncertain
    ld (GOT),a
    or a
    jr z,.complete
    cp 5
    jr nz,.bad
    ld a,1
    ld (SAVESEEN),a
    call CHECK_WAIT
    jr c,.uncertain
    jr .loop
.complete:
    ld a,(SAVESEEN)
    or a
    jr z,.bad ; zero alone may be a stale result of a dropped SAVE write
    ld hl,saved_text
    call PROGRESS
    ld hl,generic_reason
    ld (REASON),hl
    xor a
    ret
.uncertain:
    push af
    ld hl,save_uncertain_text
    ld (REASON),hl
    pop af
    ret
.bad:
    ld a,9
    scf
    ret
START_WAIT:
    call CLOCK
    jr START_CLOCKED
CLOCK:
    push de
    push hl
    push ix
    push iy
    ld c,0x21
    rst 0x10
    pop iy
    pop ix
    pop hl
    pop de
    ret
START_CLOCKED:
    ld a,b
    ld (SECSTART),a
    xor a
    ld (RETRIES),a
    ld (RETRIES+1),a
    ld (RETRIES+2),a
    ld (INFOQUERIES),a
    ld (INFOQUERIES+1),a
    ret
CHECK_WAIT:
    call UG_CFG_PAUSE
    call KEY
    cp 27
    jr z,.cancel
    call CLOCK
    ld a,(SECSTART)
    ld c,a
    ld a,b
    sub c
    jr nc,.elapsed
    add a,60
.elapsed:
    ld c,a
    ld a,(WAITSECS)
    cp c
    jr z,.timeout
    jr c,.timeout
    ; >=158us closed-window delay per poll: 65536 polls cannot cut
    ; short a live ten-second clock, but bound a stopped clock as well.
    ld hl,RETRIES
    inc (hl)
    jr nz,.counted
    inc hl
    inc (hl)
    jr z,.timeout
    ; SAVE polls include six settling pauses plus six ISA windows. 8192
    ; iterations exceed ten seconds even at 21MHz; keep its fallback short.
    ld a,(STAGE)
    cp 5
    jr nz,.counted
    ld a,(hl)
    cp 0x20
    jr nc,.timeout
.counted:
    ld a,(SESSION_PROBE)
    or a
    jr z,.ok
    ld a,(RETRIES+1)
    cp 0x20
    jr nc,.timeout
.ok:
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
KEY:
    push bc
    push de
    push hl
    push ix
    push iy
    ld c,0x31
    rst 0x10
    pop iy
    pop ix
    pop hl
    pop de
    pop bc
    ret
CFG_POLL_DEADLINE:
    ld a,(WAITMODE)
    or a
    ret z
    call CHECK_WAIT
    ret nc
    cp 10
    ld a,UG_ERR_TIMEOUT
    scf
    ret nz
    ld a,UG_ERR_CANCELLED
    scf
    ret
; Minimal INFO with FRAME_CRC. No speculative future capabilities.
CHECK_ACTIVE:
    xor a
    ld (INFOBYTES),a
    ld a,(ACTIVE)
    cp 8
    jr z,.ultra
    or a
    ret
.ultra:
    ld a,1
    ld (EXPECT),a
    ld a,4
    ld (STAGE),a
    ld a,10
    ld (WAITSECS),a
    ld a,(SESSION_PROBE)
    or a
    jr z,.limit_set
    ld a,2
    ld (WAITSECS),a
.limit_set:
    ld a,(WAITMODE)
    or a
    jp nz,.ready
    call START_WAIT
.ready:
    call CHECK_WAIT
    ret c
    ld e,1
    call REG_READ
    ld (GOT),a
    and 7
    cp 1
    jr z,.transport_ready
    ld a,(SESSION_PROBE)
    or a
    jp z,.ready
    ld a,9
    scf
    ret
.transport_ready:
    ; A stopped DSS clock must also bound repeated valid INIT replies
    ; and unchanged-session probes. 4095 complete INFO exchanges contain
    ; >196000 protected bus accesses: never an early ten-second cutoff.
    ld hl,(INFOQUERIES)
    inc hl
    ld (INFOQUERIES),hl
    ld a,h
    cp 0x10
    jr c,.send_info
    ld a,8
    scf
    ret
.send_info:
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
    ld b,2
    ld e,3
.header:
    call REG_READ
    ld (hl),a
    inc hl
    djnz .header
    ld a,2
    ld (INFOBYTES),a
    ld a,128
    ld (EXPECT),a
    ld a,(RESP+1)
    ld (GOT),a
    cp 129
    jp nc,.length_bad ; owned malformed frame: cleanup resets transport
    ld (RESPLEN),a
    add a,4 ; payload + CRC trailer, always at least four bytes
    ld b,a
.body:
    call REG_READ
    ld (hl),a
    inc hl
    djnz .body
    ld a,(RESPLEN)
    add a,6
    ld (INFOBYTES),a
    ; Authenticate the complete frame before interpreting API/boot_state.
    ld hl,RESP
    ld a,(RESPLEN)
    ld c,a
    ld b,0
    inc bc
    inc bc
    call UG_CRC32
    ld hl,RESP+2
    ld a,(RESPLEN)
    ld e,a
    ld d,0
    add hl,de
    ld de,UGCRC.OUT
    ld b,4
.crc:
    ld a,(de)
    ld (EXPECT),a
    ld a,(hl)
    ld (GOT),a
    ld a,(de)
    cp (hl)
    jp nz,.crc_bad
    inc hl
    inc de
    djnz .crc
    ; A corrupt length may have left part of our response unread. Keep
    ; ownership until the CRC authenticates the announced boundary.
    xor a
    ld (FRAMELIVE),a
    xor a
    ld (EXPECT),a
    ld a,(RESP)
    ld (GOT),a
    or a
    jp nz,.status_bad
    ld a,36
    ld (EXPECT),a
    ld a,(RESPLEN)
    ld (GOT),a
    cp 36
    jp nz,.length_bad
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
    ld (EXPECT),a
    ld a,(hl)
    ld (GOT),a
    ld a,(de)
    cp (hl)
    jp nz,.bad
    inc hl
    inc de
    djnz .magic
    ld a,(SESSION_PROBE)
    or a
    ret nz ; CRC/API/identity valid; init state need not be READY for a nonce
    xor a
    ld (EXPECT),a
    ld a,(RESP+9)
    ld (GOT),a
    cp 2
    jp z,.ready
    cp 1
    jr z,.memory
    cp 3
    jr z,.audio
    or a
    jp nz,.bad
    ; The final consuming byte releases REPLY. Confirm READY before SAVE.
    ld e,1
    call REG_READ
    ld (GOT),a
    and 7
    cp 1
    jp nz,.ready
    xor a
    ret
.api:
    ld hl,api_text
    ld (REASON),hl
    ld a,(RESP+6)
    ld (GOT),a
    cp 1
    ld a,1
    jr nz,.api_expected
    ld a,(RESP+7)
    ld (GOT),a
    xor a
.api_expected:
    ld (EXPECT),a
    ld a,3
    scf
    ret
.memory:
    xor a
    ld (EXPECT),a
    ld a,(RESP+9)
    ld (GOT),a
    ld hl,memory_text
    ld (REASON),hl
    ld a,4
    scf
    ret
.audio:
    xor a
    ld (EXPECT),a
    ld a,(RESP+9)
    ld (GOT),a
    ld hl,audio_text
    ld (REASON),hl
    ld a,7
    scf
    ret
.bad:
    ld hl,info_bad_text
.failure:
    ld (REASON),hl
    ld a,9
    scf
    ret
.crc_bad:
    ld hl,info_crc_text
    jr .failure
.length_bad:
    ld hl,info_length_text
    jr .failure
.status_bad:
    ld hl,info_status_text
    jr .failure
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
    xor a
    ld (EXPECT),a
    ld a,(BOOT)
    ld (GOT),a
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
    call CATALOG_REASON
    ld (REASON),hl
    ld a,3
    jp EXIT
CATALOG_REASON:
    ld a,(CATERROR)
    ld hl,catalog_header_text
    cp 1
    ret z
    ld hl,catalog_crc_text
    cp 2
    ret z
    ld hl,catalog_structure_text
    cp 3
    ret z
    ld hl,catalog_boot_text
    ret
PROTOCOL_RET:
    ld hl,protocol_text
    ld (REASON),hl
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
    call CLEAN_OWN_FRAME
    jp EXIT_RESULT
CLEAN_OWN_FRAME:
    ld a,(FRAMELIVE)
    or a
    ret z
    ld e,2
    ld a,0xA0
    call REG_WRITE
    xor a
    ld (FRAMELIVE),a
    ret
EXIT_RESULT:
.result:
    ld a,(DIAG)
    or a
    call nz,DIAGNOSTICS
    ld a,(ERR)
    or a
    jp z,.status
    ld a,(STARTED)
    or a
    jr z,.details
    ld hl,active_unsaved_text
    call PRINT
.details:
    ld a,(QUIET)
    or a
    jp nz,.status
    ld hl,error_text
    call PRINT
    ld hl,(REASON)
    call PRINT
    ld hl,newline
    call PRINT
    ld hl,(REASON)
    ld de,invalid_ports_text
    or a
    sbc hl,de
    jr nz,.catalogue
    ld hl,invalid_ports_values
    call PRINT
    ld hl,(BASE)
    call HEX16
    ld hl,alias_text
    call PRINT
    ld hl,(ALIAS)
    call HEX16
    ld hl,newline
    call PRINT
    jr .next
.catalogue:
    ld a,(ERR)
    cp 3
    jr nz,.values
    ld a,(CATERROR)
    cp 3
    jr nz,.values
    ld hl,record_expected_text
    call PRINT
    push ix
    pop hl
    ld b,16
    call DUMP
    ld hl,newline
    call PRINT
    jr .next
.values:
    ld hl,expected_text
    call PRINT
    ld a,(EXPECT)
    call HEX8
    ld hl,got_text
    call PRINT
    ld a,(GOT)
    call HEX8
.next:
    ld hl,next_text
    ld a,(ERR)
    cp 1
    jr nz,.next_print
    ld hl,next_syntax_text
.next_print:
    call PRINT
.status:
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
    call PRINT_REASON_TOKEN
    ld hl,newline
    call PRINT
.exit:
    ld a,(ERR)
    ld b,a
    ld c,0x41
    rst 0x10
PROGRESS:
    ld a,(QUIET)
    or a
    ret nz
    jp PRINT
PRINT:
    push af
    push bc
    push de
    push hl
    push ix
    push iy
    ld c,0x5C
    rst 0x10
    pop iy
    pop ix
    pop hl
    pop de
    pop bc
    pop af
    ret
CHAR:
    push af
    push bc
    push de
    push hl
    push ix
    push iy
    ld c,0x5B
    rst 0x10
    pop iy
    pop ix
    pop hl
    pop de
    pop bc
    pop af
    ret
PRINT_REASON_TOKEN:
    ld a,(hl)
    or a
    ret z
    cp ':'
    ret z
    cp ' '
    ret z
    call CHAR
    inc hl
    jr PRINT_REASON_TOKEN
DIAGNOSTICS:
    ld hl,diag_text
    call PRINT
    ld hl,STAGE
    ld b,3 ; stage, SAVE busy observed, startup verified
    call DUMP
    ld hl,diag_select
    call PRINT
    ld hl,UGCFG.SEL
    ld b,2
    call DUMP
    ld a,(UGCFG.STAGE)
    call HEX8
    ld hl,diag_id
    call PRINT
    ld hl,MAGIC
    ld b,4 ; magic/protocol/board/catalog failure kind
    call DUMP
    ld hl,diag_cat
    call PRINT
    ld a,(CATREAD)
    call HEX8
    ld a,' '
    call CHAR
    ld hl,CAT
    ld b,16
    call DUMP
    ld hl,diag_records
    call PRINT
    ld hl,CAT+16
    ld b,128
    call DUMP
    ld hl,diag_crc
    call PRINT
    ld hl,CAT+144
    ld b,4
    call DUMP
    ld hl,CATCRC
    ld b,4
    call DUMP
    ld hl,diag_info
    call PRINT
    ld a,(INFOBYTES)
    call HEX8
    ld a,' '
    call CHAR
    ld a,(INFOBYTES)
    or a
    jr z,.end
    ld b,a
    ld hl,RESP
    call DUMP
.end:
    ld hl,diag_ports
    call PRINT
    ld a,(PORTREAD)
    call HEX8
    ld a,(PORTREAD)
    or a
    jr z,.ports_end
    ld a,' '
    call CHAR
    ld hl,BASE
    ld b,4
    call DUMP
.ports_end:
    ld hl,newline
    jp PRINT
DUMP:
    ld a,(hl)
    call HEX8
    ld a,' '
    call CHAR
    inc hl
    djnz DUMP
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
    jp c,CHAR
    add a,7
    jp CHAR
commands: DB "INFO",0,1,"LIST",0,2,"MODE",0,3,"PORTS",0,4,"GSALIAS",0,5,"VERIFY",0,6,"SAVE",0,7,0
options: DB "/QUIET",0,1,"/?",0,2,"/SAVE",0,3,"/DIAG",0,4,"/SLOT",0,5,0
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
    DB "GSALIAS ON|OFF|VERIFY|SAVE /SLOT:0|1 /SLOT 0|1 /BASE:hex /QUIET /DIAG /?",13,10
    DB "UGCFG = INFO. UGCFG ULTRAGS = MODE ULTRAGS. Default slot: 0.",13,10
    DB "Examples: UGCFG ULTRAGS /SAVE; UGCFG VERIFY; UGCFG GUS /SAVE",13,10,0
slot_text: DB "ISA slot=",0
board_text: DB " board=",0
firmware_text: DB " firmware=",0
info_text: DB "protocol=",0
desired_text: DB " desired=",0
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
fallback_text: DB "BOOT_FALLBACK: requested image did not start; inspect LIST /DIAG",0
generic_reason: DB "CONFIGURATION",0
syntax_text: DB "SYNTAX",0
no_card_text: DB "NO_CARD",0
protocol_text: DB "COMMON_PROTOCOL: expected protocol 4; use a compatible bundle",0
timeout_text: DB "TIMEOUT: card did not become ready before deadline",0
cancel_text: DB "CANCEL",0
pass_text: DB "RESULT PASS code=0",13,10,0
fail_text: DB "RESULT FAIL code=",0
reason_text: DB " reason=",0
newline: DB 13,10,0
mode_mismatch_text: DB "MODE_MISMATCH: desired mode has not been verified active; run MODE first",0
invalid_ports_text: DB "CONFIG_PORTS: base/alias must be distinct aligned blocks 0200..03FF (FFFF disables alias)",0
invalid_ports_values: DB "Received base=",0
selector_text: DB "SELECTOR: register echo not confirmed; check slot and card",0
catalog_header_text: DB "CATALOG_HEADER: bad header/read; check INFO /DIAG and matching UF2",0
catalog_crc_text: DB "CATALOG_CRC: checksum mismatch; check transfer and installed bundle",0
catalog_structure_text: DB "CATALOG_STRUCTURE: invalid image records/bounds; install valid bundle",0
catalog_boot_text: DB "CATALOG_BOOT: bootloader rejected catalogue; inspect boot_result",0
api_text: DB "API_VERSION: expected 1.0; install matching firmware",0
memory_text: DB "MEMORY_INIT: PSRAM initialization failed; run UGMEM INFO",0
audio_text: DB "AUDIO_INIT: audio initialization failed",0
info_bad_text: DB "INFO_FRAME: invalid status/length/CRC/identity",0
info_crc_text: DB "INFO_CRC: response checksum mismatch",0
info_length_text: DB "INFO_LENGTH: response payload must contain 36 bytes (wire limit 128)",0
info_status_text: DB "INFO_STATUS: card rejected INFO; response has been consumed",0
ready_info_text: DB "api=1.0 boot_state=READY build=",0
selecting_text: DB "Selecting requested mode...",13,10,0
reboot_text: DB "Rebooting card once...",13,10,0
waiting_text: DB "Waiting for active mode and readiness...",13,10,0
started_text: DB "Startup verified: requested mode is active.",13,10,0
saving_text: DB "Saving startup settings...",13,10,0
saved_text: DB "Save confirmed: settings written and verified.",13,10,0
save_not_started_text: DB "SAVE_NOT_STARTED: previous configuration is busy/failed; inspect INFO /DIAG",0
save_uncertain_text: DB "SAVE_UNCONFIRMED: acceptance/completion not proven; Flash may have changed",0
active_unsaved_text: DB "Requested mode is already active; SAVE is not confirmed.",13,10,0
expected_text: DB "Expected=",0
error_text: DB "Error: ",0
record_expected_text: DB "Expected catalogue record: IDs 1..8, flags 0..3, aligned nonoverlapping images in 00008000..001FEFFF; received=",0
got_text: DB " received=",0
next_text: DB "; next: UGCFG INFO /DIAG (use the same /SLOT)",13,10,0
next_syntax_text: DB "; next: UGCFG /?",13,10,0
diag_text: DB "DIAG stage/save_seen/started=",0
diag_select: DB " selector/echo/step=",0
diag_id: DB 13,10,"magic/protocol/board/catalog_error=",0
diag_cat: DB 13,10,"catalog read/header=",0
diag_records: DB 13,10,"catalog records=",0
diag_crc: DB 13,10,"CRC stored/computed (LE)=",0
diag_info: DB 13,10,"INFO bytes/raw frame=",0
diag_ports: DB 13,10,"config read/base/alias (LE)=",0
    ASSERT CAT+148 <= RESP
    ASSERT RESP+134 <= CLI
    ASSERT V+160 <= UGMEM_BASE
    ASSERT FWSTR+64 <= CATCRC
    ASSERT CATCRC+4 <= OLD_BOOT
    ASSERT OLD_BOOT+1 <= OLD_SESSION
    ASSERT OLD_SESSION+8 <= V+160
    ASSERT OLD_SESSION+8 <= INFOQUERIES
    ASSERT INFOQUERIES+2 <= V+160
    DEFINE UG_CFG_POLL_HOOK CFG_POLL_DEADLINE
    INCLUDE "ugconfig.asm"
    INCLUDE "isa.asm"
    INCLUDE "ugcrc.asm"    ASSERT $ < 0xB800
