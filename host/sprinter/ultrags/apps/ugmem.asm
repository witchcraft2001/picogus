; SPDX-License-Identifier: GPL-2.0-or-later
; S3 memory tools. Real DSS/Z80, conservative eight-byte frame windows.
    DEFINE UG_DSS_TIMED
    IFNDEF APP_PROTO
    ORG 0x8000
HEADER:
    DB "EXE",1
    DW 128,0,0,0,0,0,ENTRY,ENTRY,0xBFFE
    DS 128-($-HEADER),0
    ENDIF
    INCLUDE "ugmem.inc"
RESP EQU 0xB900
CLI EQU 0xBA00
V EQU 0xBB00
SLOT EQU V
QUIET EQU V+1
HELP EQU V+2
CMD EQU V+3
ARGC EQU V+4
ARGS EQU V+6
BASE EQU V+12
ERR EQU V+14
PTR EQU V+16
REASON EQU V+18
HANDLE EQU V+20
MODE EQU V+22
EXPECT EQU V+23
REQ EQU 0x5880 ; 128-byte private request, disjoint from app variables
BOOT EQU V+29
DECVAL EQU V+32
DECPTR EQU V+36
DIGIT EQU V+38
LEADING EQU V+39
VERIFY EQU V+40
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
    IFDEF APP_BENCH
    ld a,(BMETHOD)
    cp 3
    jr nz,.bench_safe
    ld hl,unsafe_text
    ld (REASON),hl
    jp PROTOCOL
.bench_safe:
    ENDIF
    call DISCOVER
    jp c,EXIT
    call UG_LIB_INIT
    ld a,(VERIFY)
    call UG_FRAME_CRC
    ld a,(SLOT)
    ld hl,(BASE)
    call UG_OPEN
    jp c,PROTOCOL
    ; INFO/CAPS are checked before any destructive operation.
    ld a,0
    ld bc,0
    ld e,36
    call RPC
    jp c,RPC_ERROR
    ld hl,RESP
    ld de,info_magic
    ld b,7
.magic:
    ld a,(de)
    cp (hl)
    jp nz,PROTOCOL
    inc hl
    inc de
    djnz .magic
    ; Bind all file/temporary-object operations to the discovered session.
    ld hl,RESP+12
    ld de,SESSION
    ld bc,8
    ldir
    ld a,(RESP+7)
    ld (BOOT),a
    ld hl,session_text
    call SHOW
    ld hl,RESP+12
    ld b,8
    call HEX_BYTES
    call NL
    ld a,1
    ld bc,0
    ld e,32
    call RPC
    jp c,RPC_ERROR
    ld a,(RESP)
    and 128
    jp z,PROTOCOL
    IFDEF APP_AUDIO
    jp AUDIO_RUN
    ENDIF
    IFDEF APP_LOAD
    jp LOAD_FILE
    ELSE
    IFDEF APP_DUMP
    jp DUMP_FILE
    ENDIF
    ENDIF
    IFDEF APP_BENCH
    jp BENCH_RUN
    ENDIF
    ld a,(CMD)
    IFDEF APP_S6TEST
    cp 8
    jp nc,S6TEST_RUN
    ENDIF
    cp 1
    jp z,INFO
    cp 2
    jp z,LIST
    cp 3
    jp z,TEST
    cp 4
    jp z,RESET
    cp 5
    jp z,FREE
    IFDEF APP_LOAD
    jp LOAD_FILE
    ELSE
    IFDEF APP_DUMP
    jp DUMP_FILE
    ELSE
    IFDEF APP_PROTO
    jp PROTO_SUITE
    ELSE
    jp ROUNDTRIP
    ENDIF
    ENDIF
    ENDIF
INIT_BAD:
    call INIT
    jp SYNTAX
INIT:
    ld hl,V
    ld de,V+1
    ld bc,191
    ld (hl),0
    ldir
    call UG_LIB_INIT
    IFDEF APP_PCM
    call PCM_INIT
    ENDIF
    IFDEF APP_AUDIO
    call AUDIO_INIT
    ENDIF
    IFDEF APP_S6TEST
    call S6TEST_INIT
    ENDIF
    IFDEF APP_BENCH
    call BENCH_INIT
    ENDIF
    ld hl,0x2A0
    ld (BASE),hl
    ld hl,generic_reason
    ld (REASON),hl
    ld hl,0
    add hl,sp
    inc hl
    inc hl
    ld (V+128),hl
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
    cp 2
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
    IFDEF APP_BENCH
    ld a,(ARGC)
    or a
    jp nz,.bad
    xor a
    ret
    ENDIF
    IFDEF APP_AUDIO
    jp AUDIO_PARSE
    ENDIF
    ld a,(ARGC)
    or a
    jp z,.bad
    IFDEF APP_LOAD
    cp 1
    jp nz,.bad
    ld a,(BLOBTYPE)
    or a
    jp z,.bad
    IFDEF APP_PCM
    jp PCM_VALIDATE
    ENDIF
    xor a
    ret
    ELSE
    IFDEF APP_DUMP
    cp 2
    jp nz,.bad
    ld hl,(ARGS)
    call NUMBER
    ret c
    ld (HANDLE),de
    xor a
    ret
    ENDIF
    ENDIF
    ld hl,(ARGS)
    ld de,commands
    call LOOKUP
    jp c,.bad
    IFDEF APP_PROTO
    ; UGTEST's module shares the parser, but only suites are public here.
    ; Reject UGMEM verbs before DISCOVER/UG_OPEN or transport reset.
    cp 7
    jp c,.bad
    ENDIF
    ld (CMD),a
    ld b,1
    cp 8
    jr nc,.count
    cp 7
    jr z,.count
    cp 3
    jr c,.count
    inc b
.count:
    ld a,(ARGC)
    cp b
    jp nz,.bad
    ld a,(CMD)
    cp 3
    jr z,.test
    cp 4
    jr z,.reset
    cp 5
    jr z,.handle
    cp 6
    jr z,.size
    or a
    ret
.test:
    ld de,test_modes
    jr .mode
.reset:
    ld de,reset_modes
.mode:
    ld hl,(ARGS+2)
    call LOOKUP
    ret c
    dec a
    ld (MODE),a
    ret
.size:
    ld hl,(ARGS+2)
    call NUMBER32
    ret c
    ld hl,NUM32
    ld de,SIZE32
    ld bc,4
    ldir
    xor a
    ret
.handle:
    ld hl,(ARGS+2)
    call NUMBER
    ret c
    ld (HANDLE),de
    ret
.bad:
    scf
    ret
OPTION:
    IFDEF APP_S6TEST
    push hl
    ld de,s6_real_option
    call EQUAL
    pop hl
    ret z
    ENDIF
    IFDEF APP_PCM
    push hl
    call PCM_OPTION
    pop hl
    ret nc
    ENDIF
    IFDEF APP_AUDIO
    push hl
    call AUDIO_OPTION
    pop hl
    ret nc
    ENDIF
    IFDEF APP_BENCH
    push hl
    call BENCH_OPTION
    pop hl
    ret nc
    ENDIF
    push hl
    ld de,options
    call LOOKUP
    pop hl
    jr c,.prefix
    IFDEF APP_BENCH
    cp 3
    jr nc,.invalidbench
    ENDIF
    cp 1
    jr nz,.help
    ld (QUIET),a
    or a
    ret
.help:
    cp 2
    jr nz,.verify
    ld (HELP),a
    or a
    ret
.verify:
    cp 3
    jr nz,.slow
    ld a,1
    ld (VERIFY),a
    or a
    ret
.slow:
    cp 4
    jr nz,.overwrite
    ld a,1
    ld (SLOW),a
    or a
    ret
.overwrite:
    cp 5
    jr nz,.blob
    IFDEF APP_DUMP
    ld (OVERWRITE),a
    or a
    ret
    ELSE
    scf
    ret
    ENDIF
.blob:
    cp 6
    scf
    ret nz
    IFDEF APP_LOAD
    ld (BLOBTYPE),a
    or a
    ENDIF
    ret
    IFDEF APP_BENCH
.invalidbench:
    scf
    ret
    ENDIF
.prefix:
    push hl
    call BLOB_OPTION
    pop hl
    ret nc
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
NUMBER:
    ld a,(hl)
    cp '0'
    jr nz,.decimal
    inc hl
    ld a,(hl)
    cp 'X'
    jr nz,.unpeek
    inc hl
    jp HEX
.unpeek:
    dec hl
.decimal:
    ld de,0
    ld a,(hl)
    or a
    jr z,.bad
.loop:
    ld a,(hl)
    or a
    ret z
    sub '0'
    cp 10
    jr nc,.bad
    ld c,a
    push hl
    ex de,hl
    add hl,hl
    jr c,.overflow
    ld d,h
    ld e,l
    add hl,hl
    jr c,.overflow
    add hl,hl
    jr c,.overflow
    add hl,de
    jr c,.overflow
    ld d,0
    ld e,c
    add hl,de
    jr c,.overflow
    ex de,hl
    pop hl
    inc hl
    jr .loop
.overflow:
    pop hl
.bad:
    scf
    ret
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
DISCOVER:
    xor a
    call READ8
    cp 0xDD
    jr nz,.absent
    ld a,1
    call READ8
    cp 4
    jr nz,.protocol
    ld a,0xE4
    call READ8
    cp 8
    jr nz,.absent
    or a
    ret
.absent:
    ld a,2
    scf
    ret
.protocol:
    ld a,3
    scf
    ret
; A=opcode, BC=request length, E=expected result length.
RPC:
    push af
    ld a,e
    ld (EXPECT),a
    pop af
    ld hl,REQ
    ld de,RESP
    ld ix,128
    call UG_RPC
    ret c
    ld a,(EXPECT)
    cp c
    jr nz,.bad
    ld a,b
    or a
    ret z
.bad:
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    ld a,3
    ld (UG_LAST_ERROR),a
    ld a,1
    ld (UG_LAST_SOURCE),a
    ld a,3
    scf
    ret
    IFNDEF APP_PROTO
INFO:
    ld hl,boot_text
    call SHOW
    ld a,(BOOT)
    add a,'0'
    call OUTCHAR
    call NL
    ld a,2
    ld bc,0
    ld e,20
    call RPC
    jp c,RPC_ERROR
    ld hl,physical_text
    call SHOW
    ld hl,RESP
    call DEC32
    ld hl,pool_text
    call SHOW
    ld hl,RESP+4
    call DEC32
    ld hl,free_text
    call SHOW
    ld hl,RESP+8
    call DEC32
    ld hl,largest_text
    call SHOW
    ld hl,RESP+12
    call DEC32
    ld hl,objects_text
    call SHOW
    ld hl,(RESP+16)
    call DEC16
    ld hl,limit_text
    call SHOW
    ld hl,(RESP+18)
    call DEC16
    call NL
    jp PASS
TEST:
    ld a,(MODE)
    ld (REQ),a
    ld a,5
    ld bc,1
    ld e,14
    call RPC
    jr nc,.result
    cp UG_ERR_PSRAM
    jp nz,RPC_ERROR
    ld a,(UG_LAST_SOURCE)
    cp 2
    jp nz,RPC_ERROR
    ld a,(UGREQ.LEN)
    cp 14
    jp nz,PROTOCOL
.result:
    ld hl,tested_text
    call SHOW
    ld hl,RESP
    call DEC32
    ld hl,bad_text
    call SHOW
    ld hl,RESP+4
    ld b,4
    call HEX_BYTES
    ld hl,expected_text
    call SHOW
    ld a,(RESP+8)
    call HEX8
    ld hl,actual_text
    call SHOW
    ld a,(RESP+9)
    call HEX8
    ld hl,elapsed_text
    call SHOW
    ld hl,RESP+10
    call DEC32
    call NL
    ld a,(UGREQ.ST)
    or a
    jp nz,RPC_ERROR
    jp PASS
RESET:
    ld hl,warning_text
    call PRINT
    ld hl,0x5253
    ld (REQ),hl
    ld hl,0x5547
    ld (REQ+2),hl
    ld a,(MODE)
    ld (REQ+4),a
    ld a,6
    ld bc,5
    ld e,8
    call RPC
    jp c,RPC_ERROR
    ld hl,session_text
    call SHOW
    ld hl,RESP
    ld b,8
    call HEX_BYTES
    call NL
    jp PASS
FREE:
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,17
    ld bc,2
    ld e,0
    call RPC
    jp c,RPC_ERROR
    jp PASS
LIST:
    ld hl,0
    ld (HANDLE),hl
.loop:
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,21
    ld bc,2
    ld e,2
    call RPC
    jp c,RPC_ERROR
    ld hl,(RESP)
    ld a,h
    or l
    jp z,PASS
    ld de,(HANDLE)
    or a
    sbc hl,de
    jp c,PROTOCOL
    jp z,PROTOCOL
    ld hl,(RESP)
    ld (HANDLE),hl
    ld (REQ),hl
    ld a,18
    ld bc,2
    ld e,38
    call RPC
    jp c,RPC_ERROR
    ld hl,(RESP)
    ld de,(HANDLE)
    or a
    sbc hl,de
    jp nz,PROTOCOL
    ld hl,handle_text
    call SHOW
    ld hl,RESP
    ld b,2
    call HEX_BYTES
    ld hl,size_text
    call SHOW
    ld hl,RESP+6
    call DEC32
    ld hl,pins_text
    call SHOW
    ld hl,(RESP+4)
    call DEC16
    call NL
    jp .loop
    ELSE
INFO:
TEST:
RESET:
FREE:
LIST:
    jp SYNTAX
    ENDIF
RPC_ERROR:
    ld b,a
    ld a,(UG_LAST_SOURCE)
    cp 1
    jr z,.host
    ld a,b
    cp 11
    jr nz,.audio
    ld hl,format_error_text
    ld (REASON),hl
    ld a,6
    jp EXIT
.audio:
    cp UG_ERR_NO_VOICE
    jr nz,.crcstatus
    ld hl,no_voice_text
    ld (REASON),hl
    ld a,7
    jp EXIT
.crcstatus:
    cp 4
    jr nz,.busy
    ld a,9
    jp EXIT
.busy:
    cp 5
    jr nz,.memory
    ld hl,busy_text
    ld (REASON),hl
    ld a,4
    jp EXIT
.memory:
    cp 9
    jr z,.mem
    cp 10
    jr z,.mem
    cp 17
    jr z,.mem
    cp 19
    jr z,.mem
    cp 7
    jr z,.mem
    cp 18
    jr z,.mem
    ld a,3
    jp EXIT
.mem:
    ld a,4
    jp EXIT
.host:
    ld a,b
    cp 13
    jr nz,.crc
    ld a,8
    jp EXIT
.crc:
    cp 4
    jr nz,.cancel
    ld a,9
    jp EXIT
.cancel:
    cp 21
    jp nz,PROTOCOL
    ld a,10
    jp EXIT
PROTOCOL:
    ld a,3
    jp EXIT
SYNTAX:
    ld a,1
    jp EXIT
PASS:
    xor a
EXIT:
    ld (ERR),a
    IFDEF APP_AUDIO
    call AUDIO_CLEANUP
    ENDIF
    IFDEF APP_S6TEST
    call S6TEST_CLEANUP
    ENDIF
    call BLOB_CLEANUP
    call UG_CLOSE
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
    ld sp,(V+128)
    ld a,(ERR)
    ld b,a
    ld c,0x41
    rst 0x10
; Preserve registers across arbitrary DSS handlers (including IX/IY).
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
SHOW:
    push af
    ld a,(QUIET)
    or a
    call z,PRINT
    pop af
    ret
OUTCHAR:
    push af
    ld a,(QUIET)
    or a
    jr nz,.skip
    pop af
    jp CHAR
.skip:
    pop af
    ret
NL:
    ld hl,newline
    jp SHOW
HEX_BYTES:
    ld c,b
    ld b,0
    add hl,bc
    ld b,c
.loop:
    dec hl
    ld a,(hl)
    call HEX8
    djnz .loop
    ret
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
    jr c,OUTCHAR
    add a,7
    jr OUTCHAR
DEC16:
    ld (DECVAL),hl
    ld hl,0
    ld (DECVAL+2),hl
    jr DECIMAL
DEC32:
    ld de,DECVAL
    ld bc,4
    ldir
DECIMAL:
    push ix
    xor a
    ld (LEADING),a
    ld ix,powers
.next:
    ld (DIGIT),a
.subtract:
    ld hl,(DECVAL)
    ld e,(ix+0)
    ld d,(ix+1)
    or a
    sbc hl,de
    push hl
    ld hl,(DECVAL+2)
    ld e,(ix+2)
    ld d,(ix+3)
    sbc hl,de
    jr c,.emit
    ld (DECVAL+2),hl
    pop hl
    ld (DECVAL),hl
    ld hl,DIGIT
    inc (hl)
    jr .subtract
.emit:
    pop hl
    ld a,(DIGIT)
    or a
    jr nz,.print
    ld a,(LEADING)
    or a
    jr nz,.print
    ld a,(ix+0)
    cp 1
    jr nz,.advance
.print:
    ld a,1
    ld (LEADING),a
    ld a,(DIGIT)
    add a,'0'
    call OUTCHAR
.advance:
    ld de,4
    add ix,de
    ld a,(ix+0)
    or (ix+1)
    or (ix+2)
    or (ix+3)
    jr z,.done
    xor a
    jr .next
.done:
    pop ix
    ret
powers:
    DD 1000000000,100000000,10000000,1000000,100000,10000,1000,100,10,1,0
commands: DB "INFO",0,1,"LIST",0,2,"TEST",0,3,"RESET",0,4,"FREE",0,5,"ROUNDTRIP",0,6,"PROTO",0,7
    IFDEF APP_S6TEST
    DB "PCM",0,8,"FX",0,9
    ENDIF
    DB 0
options: DB "/QUIET",0,1,"/?",0,2,"/VERIFY",0,3,"/SLOW",0,4,"/OVERWRITE",0,5,"/TYPE:BLOB",0,6,0
test_modes: DB "QUICK",0,1,"FULL",0,2,0
reset_modes: DB "WARM",0,1,"COLD",0,2,0
slot_prefix: DB "/SLOT:",0
base_prefix: DB "/BASE:",0
info_magic: DB "UGS1",1,0,8
    IFDEF APP_BENCH
help_text: DB "UGBENCH /BYTES:N /LOOPS:N /BLOCK:1..1024 /METHOD:ALL|SLOW|FIXED|ALIAS|STACK",13,10
    DB "/DIRECTION:BOTH|WRITE|READ /CHECK:NONE|CRC|BOTH /SOAK:seconds /SLOT:0|1 /BASE:hex /QUIET",13,10,0
    ELSE
    IFDEF APP_AUDIO
help_text: INCLUDE "ugaudio_help.inc"
    ELSE
    IFDEF APP_PROTO
help_text: DB "UGTEST PROTO|PCM|FX [/REAL] /SLOT:0|1 /BASE:hex /QUIET /?",13,10,0
    ELSE
help_text: DB "UGMEM INFO|LIST|TEST QUICK|FULL|RESET WARM|COLD|FREE handle",13,10
    DB "ROUNDTRIP bytes /SLOW /VERIFY /SLOT:0|1 /BASE:hex /QUIET /?",13,10
    DB "UGLOAD file /TYPE:RAW|WAV|BLOB /RATE:N /BITS:8|16 /CH:1|2 /FMT:U8|S8|S16LE",13,10
    DB "UGLOAD file /TYPE:BLOB [/CRC:hhhhhhhh] | UGDUMP handle file [/OFFSET:N /LENGTH:N /OVERWRITE]",13,10,0
    ENDIF
    ENDIF
    ENDIF
    IFDEF APP_S6TEST
s6_real_option: DB "/REAL",0
    ENDIF
format_error_text: DB "FORMAT",0
no_voice_text: DB "NO_VOICE",0
warning_text: DB "WARNING RESET destroys all loaded objects",13,10,0
unavailable_text: DB "ROUNDTRIP_UNAVAILABLE_UNTIL_S4",0
generic_reason: DB "MEMORY_OR_PROTOCOL",0
busy_text: DB "BUSY",0
session_text: DB "session=0x",0
boot_text: DB "boot_state=",0
physical_text: DB "physical=",0
pool_text: DB " pool=",0
free_text: DB " free=",0
largest_text: DB " largest=",0
objects_text: DB " objects=",0
limit_text: DB " limit=",0
tested_text: DB "tested=",0
bad_text: DB " first_bad=0x",0
expected_text: DB " expected=0x",0
actual_text: DB " actual=0x",0
elapsed_text: DB " elapsed_ms=",0
handle_text: DB "handle=0x",0
size_text: DB " size=",0
pins_text: DB " pins=",0
pass_text: DB "RESULT PASS code=0",13,10,0
fail_text: DB "RESULT FAIL code=",0
reason_text: DB " reason=",0
newline: DB 13,10,0
    INCLUDE "ugblob.asm"
    IFDEF APP_PCM
    INCLUDE "ugpcm.asm"
    ENDIF
    IFDEF APP_AUDIO
    INCLUDE "ugaudio.asm"
    ENDIF
    IFDEF APP_PROTO
    INCLUDE "ugtestproto.asm"
    IFDEF APP_S6TEST
    INCLUDE "ugtestpcm.asm"
    ENDIF
    ENDIF
    IFDEF APP_BENCH
    INCLUDE "ugbench_blob.asm"
    ENDIF
    INCLUDE "ugproto.asm"
    ASSERT $ < 0xB800

    ASSERT UGMEM_END+512 <= 0xBFFE
