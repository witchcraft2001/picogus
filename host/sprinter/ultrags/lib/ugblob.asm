; SPDX-License-Identifier: GPL-2.0-or-later
; S4 BLOB applications. Disk/console calls are outside BEGIN..END.
; Buffers below C000h; size/offset arithmetic is unsigned 32 bit.
BUF EQU 0x5000
BACK EQU 0x5400
NUM32 EQU V+64
SIZE32 EQU V+68
POS32 EQU V+72
LEFT32 EQU V+76
BLOCK EQU V+80
OWN EQU V+82
FILEOPEN EQU V+83
FILEHANDLE EQU V+84
OVERWRITE EQU V+85
BLOBTYPE EQU V+86
MANIFEST EQU V+87
CRC32VAL EQU V+88
FILECRC EQU V+92
SESSION EQU V+96
DUMPOFF EQU V+104
DUMPLEN EQU V+108
HASLEN EQU V+112
SAVEDERR EQU V+113
NUMDIG EQU V+114
NUMBASE EQU V+115
IOPTR EQU V+116
IOLEFT EQU V+118
IOSIZE EQU V+120
ACTUALCRC EQU V+122
TIMEPREV EQU V+144
TIMEELAPSED EQU V+148
TIMEQUOT EQU V+152
TIMEMIN EQU V+156
TIMESEC EQU V+157
SAVEDSOURCE EQU V+158
FILEOUTPUT EQU V+159
SLOW EQU V+160
DATATRANS EQU V+161
    IFDEF APP_DUMP
WRITEPOS EQU V+162 ; before WRITE, independent of DSS-returned DE
FILEFN EQU V+166
FILEAF EQU V+167 ; F,A from the last file call (before cleanup)
    ENDIF
    IFDEF UGMEM_PROGRESS
ROUND_PHASE EQU V+162
    ENDIF

; Parse decimal or 0x with overflow detected on every multiply/add.
NUMBER32:
    ld a,10
    ld (NUMBASE),a
    ld a,(hl)
    cp '0'
    jr nz,PARSE32
    inc hl
    ld a,(hl)
    cp 'X'
    jr z,HEX32
    dec hl
    jr PARSE32
HEX32:
    inc hl
    ld a,16
    ld (NUMBASE),a
PARSE32:
    xor a
    ld (NUMDIG),a
    ld (NUM32),a
    ld (NUM32+1),a
    ld (NUM32+2),a
    ld (NUM32+3),a
.loop:
    ld a,(hl)
    or a
    jr z,.end
    sub '0'
    cp 10
    jr c,.digit
    sub 7
    cp 10
    jr c,.bad
.digit:
    ld e,a
    ld a,(NUMBASE)
    cp e
    jr c,.bad
    jr z,.bad
    push hl
    push de
    ld hl,(NUM32)
    ld de,(NUM32+2)
    call SHL32
    jr c,.overflow
    ld a,(NUMBASE)
    cp 16
    jr z,.hex
    push hl
    push de
    call SHL32
    jr c,.overflow2
    call SHL32
    jr c,.overflow2
    pop bc
    pop ix
    push de
    push ix
    pop de
    add hl,de
    pop de
    ex de,hl
    adc hl,bc
    ex de,hl
    jr c,.overflow
    jr .add
.hex:
    call SHL32
    jr c,.overflow
    call SHL32
    jr c,.overflow
    call SHL32
    jr c,.overflow
.add:
    pop bc
    ld b,0
    add hl,bc
    ex de,hl
    ld bc,0
    adc hl,bc
    ex de,hl
    jr c,.overflowdigit
    ld (NUM32),hl
    ld (NUM32+2),de
    pop hl
    inc hl
    ld a,(NUMDIG)
    inc a
    ld (NUMDIG),a
    jr .loop
.overflow2:
    pop de
    pop hl
.overflow:
    pop de
.overflowdigit:
    pop hl
.bad:
    scf
    ret
.end:
    ld a,(NUMDIG)
    or a
    jr z,.bad
    xor a
    ret
SHL32:
    add hl,hl
    rl e
    rl d
    ret
BLOB_OPTION:
    IFDEF APP_LOAD
    push hl
    ld de,crc_prefix
    call PREFIX
    jr c,.offset
    ld a,16
    ld (NUMBASE),a
    call PARSE32
    jr c,.bad
    ld a,(NUMDIG)
    cp 8
    jr nz,.bad
    ld hl,NUM32
    ld de,CRC32VAL
    ld bc,4
    ldir
    ld a,1
    ld (MANIFEST),a
    pop hl
    xor a
    ret
.offset:
    pop hl
    jr .reject
    ENDIF
    IFDEF APP_DUMP
    push hl
    ld de,offset_prefix
    call PREFIX
    jr c,.length
    call NUMBER32
    jr c,.bad
    ld de,DUMPOFF
    jr .copy
.length:
    pop hl
    push hl
    ld de,length_prefix
    call PREFIX
    jr c,.bad
    call NUMBER32
    jr c,.bad
    ld a,1
    ld (HASLEN),a
    ld de,DUMPLEN
.copy:
    ld hl,NUM32
    ld bc,4
    ldir
    pop hl
    xor a
    ret
.bad:
    pop hl
    ELSE
    IFDEF APP_LOAD
.bad:
    pop hl
    ENDIF
    ENDIF
.reject:
    scf
    ret
BLOB_SETUP:
    ld a,1
    ld bc,0
    ld e,44
    call RPC
    jp c,RPC_ERROR
    ld a,(RESP)
    and 2
    jp z,PROTOCOL
    ld a,(SLOW)
    or a
    jr nz,.slow
    ld a,(RESP)
    and 4
    jr z,.slow
    xor a
    ld (DATATRANS),a
    ld hl,bulk_text
    jr .showtransport
.slow:
    ld a,1
    ld (DATATRANS),a
    ld hl,path_text
.showtransport:
    call SHOW
    call NL
    IFDEF UG_EXPERIMENT_WINDOW
    ld hl,experiment_text
    call SHOW
    ld hl,UG_EXPERIMENT_WINDOW
    call DEC16
    ld hl,experiment_turbo_text
    call SHOW
    IFDEF UG_EXPERIMENT_TURBO_WRITE
    ld a,'1'
    ELSE
    ld a,'0'
    ENDIF
    call OUTCHAR
    ld hl,experiment_read_text
    call SHOW
    call NL
    ENDIF
    ; Setup must not silently adopt a rebooted card after ENTRY printed the
    ; original session. Check before opening a file or allocating an object.
    call SESSION_CHECK
    jp c,RPC_ERROR
    ret
; Keep DSS-returned AF/DE, preserve IX/IY for all file calls except seek.
FILECALL:
    IFDEF APP_DUMP
    push af
    ld a,c
    ld (FILEFN),a
    pop af
    ENDIF
    push ix
    push iy
    rst 0x10
    pop iy
    pop ix
    IFDEF APP_DUMP
FILE_RECORD:
    push hl
    push af
    pop hl
    ld (FILEAF),hl
    pop hl
    ENDIF
    ret
CLOSE_FILE:
    ; Track the handle even for UGDUMP's existence probe. Retry a failed
    ; close once, but preserve the first error: output may not be flushed.
    ld a,(FILEHANDLE)
    ld c,0x12
    call FILECALL
    jr nc,.closed
    push af
    ld a,(FILEHANDLE)
    ld c,0x12
    call FILECALL
    jr c,.failed
    xor a
    ld (FILEOPEN),a
.failed:
    pop af
    scf
    ret
.closed:
    xor a
    ld (FILEOPEN),a
    ret
FILE_ERROR:
    IFDEF APP_DUMP
    ld hl,file_diag_text
    call SHOW
    ld a,(FILEFN)
    call HEX8
    ld hl,file_a_text
    call SHOW
    ld a,(FILEAF+1)
    call HEX8
    ld hl,file_f_text
    call SHOW
    ld a,(FILEAF)
    call HEX8
    call NL
    ENDIF
    ld hl,file_reason
    ld (REASON),hl
    ld a,5
    jp EXIT
SEEK:
    IFDEF APP_DUMP
    ld a,0x15
    ld (FILEFN),a
    ENDIF
    push ix
    push iy
    ld a,(FILEHANDLE)
    ld ix,0
    ld hl,0
    ld c,0x15
    rst 0x10
    ld (NUM32),ix
    ld (NUM32+2),hl
    pop iy
    pop ix
    IFDEF APP_DUMP
    jp FILE_RECORD
    ENDIF
    ret
OPEN_INPUT:
    ld hl,(ARGS)
    ld a,1
    ld c,0x11
    call FILECALL
    jp c,FILE_ERROR
    ld (FILEHANDLE),a
    ld a,1
    ld (FILEOPEN),a
    ld b,2
    call SEEK
    jp c,FILE_ERROR
    ld hl,NUM32
    ld de,SIZE32
    ld bc,4
    ldir
    ld b,0
    call SEEK
    jp c,FILE_ERROR
    ret
RESERVE:
    ld a,2
    ld bc,0
    ld e,20
    call RPC
    jp c,RPC_ERROR
    ld hl,(SIZE32)
    ld de,(SIZE32+2)
    ld a,h
    or l
    or d
    or e
    jp z,MEM_ERROR
    ; Round size upward to 16 without overflow.
    ld bc,15
    add hl,bc
    ex de,hl
    ld bc,0
    adc hl,bc
    ex de,hl
    jp c,MEM_ERROR
    ld a,l
    and 0xF0
    ld l,a
    ld (NUM32),hl
    ld (NUM32+2),de
    ld hl,RESP+8
    call SPACE_CHECK
    jp c,MEM_ERROR
    ld hl,RESP+12
    call SPACE_CHECK
    jp c,MEM_ERROR
    ld hl,(RESP+16)
    ld de,(RESP+18)
    or a
    sbc hl,de
    jp nc,MEM_ERROR
    call SESSION_CHECK
    jp c,RPC_ERROR
    xor a
    IFDEF APP_PCM
    ld a,(PCM_KIND)
    ENDIF
    ld (REQ),a
    ld hl,SIZE32
    ld de,REQ+1
    ld bc,4
    ldir
    ld a,16
    ld bc,5
    ld e,6
    call RPC
    jp c,ALLOC_ERROR
    ld hl,(RESP)
    ld a,h
    or l
    jp z,PROTOCOL
    ld (HANDLE),hl
    ld a,1
    ld (OWN),a
    ret
SPACE_CHECK:
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    push de
    ld e,(hl)
    inc hl
    ld d,(hl)
    ld hl,(NUM32+2)
    ex de,hl
    or a
    sbc hl,de
    pop hl
    ret c
    ret nz
    ld de,(NUM32)
    or a
    sbc hl,de
    ret
MEM_ERROR:
    ld a,4
    jp EXIT
ALLOC_ERROR:
    ld a,(UG_LAST_SOURCE)
    cp 1
    jr nz,.known
.unknown:
    ld a,(UG_LAST_ERROR)
    ld (SAVEDERR),a
    ld a,1
    ld (UGTM.NOESC),a
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    call SESSION_CHECK
    ld hl,alloc_unknown
    ld (REASON),hl
    ld a,(SAVEDERR)
    ld (UG_LAST_ERROR),a
    ld a,1
    ld (UG_LAST_SOURCE),a
.known:
    ld a,(UG_LAST_ERROR)
    jp RPC_ERROR
START_BLOCKS:
    ld hl,SIZE32
    ld de,LEFT32
    ld bc,4
    ldir
    xor a
    ld (POS32),a
    ld (POS32+1),a
    ld (POS32+2),a
    ld (POS32+3),a
    ld a,255
    ld (FILECRC),a
    ld (FILECRC+1),a
    ld (FILECRC+2),a
    ld (FILECRC+3),a
    ret
NEXT_BLOCK:
    IFDEF APP_LOAD
    call APP_TIME_NEXT
    ENDIF
    ; ESC and clock outside ISA and grants.
    push ix
    push iy
    ld c,0x31
    rst 0x10
    pop iy
    pop ix
    cp 27
    jp z,CANCEL_APP
    ld hl,(LEFT32+2)
    ld de,(LEFT32)
    ld a,h
    or l
    or d
    or e
    ret z
    ld a,h
    or l
    ld hl,1024
    jr nz,.chosen
    ex de,hl
    ld de,1024
    or a
    sbc hl,de
    jr nc,.full
    add hl,de
    jr .chosen
.full:
    ld hl,1024
.chosen:
    ld (BLOCK),hl
    ld hl,POS32
    ld de,UG_OFFSET
    ld bc,4
    ldir
    ld a,1
    or a
    ret
ADVANCE:
    ld hl,(POS32)
    ld de,(BLOCK)
    add hl,de
    ld (POS32),hl
    ld hl,(POS32+2)
    ld de,0
    adc hl,de
    ld (POS32+2),hl
    ld hl,(LEFT32)
    ld de,(BLOCK)
    or a
    sbc hl,de
    ld (LEFT32),hl
    ld hl,(LEFT32+2)
    ld de,0
    sbc hl,de
    ld (LEFT32+2),hl
    ret
TRANSPORT:
    ld a,(VERIFY)
    or a
    ld a,(DATATRANS)
    ret z
    or 0x80
    ret
WRITE_BLOCK:
    ld hl,(HANDLE)
    ld de,BUF
    ld bc,(BLOCK)
    call TRANSPORT
    call UG_WRITE
    ret nc
    jp TRANSFER_ERROR
READ_BLOCK:
    ld hl,(HANDLE)
    ld de,BACK
    ld bc,(BLOCK)
    call TRANSPORT
    call UG_READ
    ret nc
    jp TRANSFER_ERROR
TRANSFER_ERROR:
    ; Retain the actual failing stage: UG_WRITE/READ already cancelled and
    ; UGREQ.OP now describes cleanup, not necessarily a failed END.
    ld a,1
    ld (UGTM.NOESC),a
    ld a,(UG_LAST_ERROR)
    ld (SAVEDERR),a
    ld a,(UG_LAST_SOURCE)
    ld (SAVEDSOURCE),a
    ld hl,(UGREQ.LEN)
    push hl
    ld hl,transfer_stage_text
    call SHOW
    ld a,(UGXFER.STAGE)
    call HEX8
    ld hl,transfer_moved_text
    call SHOW
    ld hl,(UGXFER.SENT)
    call DEC16
    ld a,'/'
    call OUTCHAR
    ld hl,(UGXFER.N)
    call DEC16
    ld hl,transfer_offset_text
    call SHOW
    ld hl,UG_OFFSET
    ld b,4
    call HEX_BYTES
    call NL
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    call SESSION_CHECK
    jr c,.lost
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,18
    ld bc,2
    ld e,38
    call RPC
    ld hl,recovery_text
    call SHOW
    call NL
.lost:
    pop hl
    ld (UGREQ.LEN),hl
    ld a,(SAVEDSOURCE)
    ld (UG_LAST_SOURCE),a
    ld a,(SAVEDERR)
    ld (UG_LAST_ERROR),a
    jp RPC_ERROR
SESSION_CHECK:
    ld a,0
    ld bc,0
    ld e,40
    call RPC
    ret c
    ld hl,RESP+12
    ld de,SESSION
    ld b,8
.loop:
    ld a,(de)
    cp (hl)
    jr nz,.changed
    inc de
    inc hl
    djnz .loop
    xor a
    ret
.changed:
    xor a
    ld (OWN),a
    ld hl,blob_session_text
    ld (REASON),hl
    scf
    ret
blob_session_text: DB "SESSION_CHANGED",0
SEAL_BLOB:
    ld hl,(HANDLE)
    ld (REQ),hl
    xor a
    ld (REQ+2),a
    ld (REQ+3),a
    ld (REQ+4),a
    ld (REQ+5),a
    ld (REQ+6),a
    ld a,(VERIFY)
    or a
    jr z,.manifest
    ld hl,FILECRC
    ld de,UGCRC.ACC
    ld bc,4
    ldir
    call UG_CRC32_END
    ld a,(MANIFEST)
    or a
    jr z,.crc
    ld hl,CRC32VAL
    ld de,UGCRC.OUT
    ld b,4
.compare:
    ld a,(de)
    cp (hl)
    jp nz,VERIFY_ERROR
    inc hl
    inc de
    djnz .compare
.crc:
    ld hl,UGCRC.OUT
    jr .expected
.manifest:
    ld a,(MANIFEST)
    or a
    jr z,.rpc
    ld hl,CRC32VAL
.expected:
    ld de,REQ+3
    ld bc,4
    ldir
    ld a,1
    ld (REQ+2),a
.rpc:
    ld a,19
    ld bc,7
    ld e,4
    call RPC
    IFDEF APP_PCM
    IFDEF APP_LOAD
    jp c,PCM_SEAL_ERROR
    ELSE
    jp c,RPC_ERROR
    ENDIF
    ELSE
    jp c,RPC_ERROR
    ENDIF
    ld hl,RESP
    ld de,ACTUALCRC
    ld bc,4
    ldir
    ret
FOLD_FILE:
    ld a,(VERIFY)
    or a
    ret z
    ld hl,FILECRC
    ld de,UGCRC.ACC
    ld bc,4
    ldir
    ld hl,BUF
    jr FOLD_BUFFER
FOLD_DUMP:
    ld a,(VERIFY)
    or a
    ret z
    IFDEF APP_DUMP
    jp UG_CRC_COMBINE
    ELSE
    ret
    ENDIF
FOLD_BUFFER:
    ld bc,(BLOCK)
    call UG_CRC32_FOLD
    ld hl,UGCRC.ACC
    ld de,FILECRC
    ld bc,4
    ldir
    ret
IO_BLOCK:
    ; A=13h read BUF or 14h write BACK. Complete short operations.
    IFDEF APP_DUMP
    cp 0x14
    jp z,DISK_WRITE_BLOCK
    ENDIF
    ld (IOSIZE),a
    ld hl,BUF
    cp 0x13
    jr z,.buffer
    ld hl,BACK
.buffer:
    ld (IOPTR),hl
    ld hl,(BLOCK)
    ld (IOLEFT),hl
.loop:
    ld a,(FILEHANDLE)
    ld hl,(IOPTR)
    ld de,(IOLEFT)
    ld a,(IOSIZE)
    ld c,a
    ld a,(FILEHANDLE)
    call FILECALL
    jp c,FILE_ERROR
    ld a,d
    or e
    jp z,FILE_ERROR
    ld hl,(IOLEFT)
    or a
    sbc hl,de
    jp c,FILE_ERROR
    ld (IOLEFT),hl
    push hl
    ld hl,(IOPTR)
    add hl,de
    ld (IOPTR),hl
    pop hl
    ld a,h
    or l
    jr nz,.loop
    ret
    IFDEF APP_DUMP
DISK_WRITE_BLOCK:
    ; DSS WRITE may flush FAT after its data path. That flush clobbers DE
    ; even on success (DSS/API/Write.asm -> WRITE_FAT_TABLE). Measure the
    ; committed position delta instead; never repeat an already written byte.
    ld hl,BACK
    ld (IOPTR),hl
    ld hl,(BLOCK)
    ld (IOLEFT),hl
.loop:
    ld b,1 ; query current position, signed offset = 0
    call SEEK
    jp c,FILE_ERROR
    ld hl,NUM32
    ld de,WRITEPOS
    ld bc,4
    ldir
    ld hl,(IOPTR)
    ld de,(IOLEFT)
    ld a,(FILEHANDLE)
    ld c,0x14
    call FILECALL
    jp c,FILE_ERROR
    ld b,1
    call SEEK
    jp c,FILE_ERROR
    ; Full 32-bit subtraction, including a 64 KiB crossing. Reject a
    ; backwards position, a zero advance, or more than requested.
    ld hl,(NUM32)
    ld de,(WRITEPOS)
    or a
    sbc hl,de
    push hl
    ld hl,(NUM32+2)
    ld de,(WRITEPOS+2)
    sbc hl,de
    pop de
    jp c,FILE_ERROR
    ld a,h
    or l
    jp nz,FILE_ERROR
    ld a,d
    or e
    jp z,FILE_ERROR
    ld hl,(IOLEFT)
    or a
    sbc hl,de
    jp c,FILE_ERROR
    ld (IOLEFT),hl
    push hl
    ld hl,(IOPTR)
    add hl,de
    ld (IOPTR),hl
    pop hl
    ld a,h
    or l
    jr nz,.loop
    ret
    ENDIF
COMPARE_BLOCK:
    ld hl,BUF
    ld de,BACK
    ld bc,(BLOCK)
.loop:
    ld a,(de)
    cp (hl)
    jp nz,VERIFY_ERROR
    inc hl
    inc de
    dec bc
    ld a,b
    or c
    jr nz,.loop
    ret
VERIFY_ERROR:
    ld hl,verify_reason
    ld (REASON),hl
    ld a,9
    jp EXIT
CANCEL_APP:
    ld a,10
    jp EXIT
PATTERN:
    ld hl,BUF
    ld de,(POS32)
    ld bc,(BLOCK)
.loop:
    ld a,(POS32+2)
    xor d
    xor e
    xor 0xA5
    ld (hl),a
    inc hl
    inc de
    dec bc
    ld a,b
    or c
    jr nz,.loop
    ret
    IFNDEF APP_PROTO
ROUNDTRIP:
    call BLOB_SETUP
    call RESERVE
    call START_BLOCKS
    IFDEF UGMEM_PROGRESS
    call APP_TIME_INIT
    xor a
    ld (ROUND_PHASE),a
    call ROUND_REPORT
    ENDIF
.write:
    call NEXT_BLOCK
    jr z,.seal
    call PATTERN
    call FOLD_FILE
    call WRITE_BLOCK
    call ADVANCE
    IFDEF UGMEM_PROGRESS
    call ROUND_PROGRESS
    ENDIF
    jr .write
.seal:
    IFDEF UGMEM_PROGRESS
    ld a,2
    ld (ROUND_PHASE),a
    call ROUND_REPORT
    ENDIF
    call SEAL_BLOB
    call START_BLOCKS
    IFDEF UGMEM_PROGRESS
    ld a,1
    ld (ROUND_PHASE),a
    call ROUND_REPORT
    ENDIF
.read:
    call NEXT_BLOCK
    jp z,PASS
    call PATTERN
    call READ_BLOCK
    call COMPARE_BLOCK
    call ADVANCE
    IFDEF UGMEM_PROGRESS
    call ROUND_PROGRESS
    ENDIF
    jr .read
    IFDEF UGMEM_PROGRESS
; Only after END and comparison, with ISA closed and no active grant.
; Report every 64 KiB plus the final tail, without extra card accesses.
ROUND_PROGRESS:
    ld hl,(LEFT32)
    ld de,(LEFT32+2)
    ld a,h
    or l
    or d
    or e
    jr z,ROUND_REPORT
    ld hl,(POS32)
    ld a,h
    or l
    ret nz
ROUND_REPORT:
    ld a,(QUIET)
    or a
    ret nz
    call APP_TIME_NEXT
    ld hl,round_write_text
    ld a,(ROUND_PHASE)
    or a
    jr z,.show
    ld hl,round_read_text
    cp 1
    jr z,.show
    ld hl,round_seal_text
.show:
    call SHOW
    ld hl,POS32
    call DEC32
    ld a,'/'
    call OUTCHAR
    ld hl,SIZE32
    call DEC32
    ld hl,round_time_text
    call SHOW
    ld hl,TIMEELAPSED
    call DEC32
    jp NL
round_write_text: DB "roundtrip WRITE completed=",0
round_read_text: DB "roundtrip READ completed=",0
round_seal_text: DB "roundtrip SEAL completed=",0
round_time_text: DB " elapsed_s=",0
    ENDIF
    ELSE
ROUNDTRIP:
    jp SYNTAX
    ENDIF
    IFDEF APP_LOAD
LOAD_FILE:
    call UPLOAD_FILE
    jp PASS
UPLOAD_FILE:
    call BLOB_SETUP
    call OPEN_INPUT
    call APP_TIME_INIT
    IFDEF APP_PCM
    call PCM_PREFLIGHT
    ENDIF
    call RESERVE
    call START_BLOCKS
.loop:
    call NEXT_BLOCK
    jr z,.seal
    ld a,0x13
    call IO_BLOCK
    call FOLD_FILE
    call SESSION_CHECK
    jp c,RPC_ERROR
    call WRITE_BLOCK
    call ADVANCE
    jr .loop
.seal:
    call SESSION_CHECK
    jp c,RPC_ERROR
    IFDEF APP_PCM
    call PCM_CONFIGURE
    ENDIF
    call SEAL_BLOB
    ; Once READY, errors/PLAY refusal never delete the published asset.
    IFDEF APP_PCM
    ld a,(PCM_KIND)
    or a
    jr z,.blob_owner
    xor a
    ld (OWN),a
.blob_owner:
    ENDIF
    ld a,(VERIFY)
    or a
    jr z,.done
    ld b,0
    call SEEK
    jp c,FILE_ERROR
    call START_BLOCKS
.verify:
    call NEXT_BLOCK
    jr z,.done
    ld a,0x13
    call IO_BLOCK
    call SESSION_CHECK
    jp c,RPC_ERROR
    call READ_BLOCK
    call COMPARE_BLOCK
    call ADVANCE
    jr .verify
.done:
    call APP_TIME_NEXT
    ld hl,handle_text
    call SHOW
    ld hl,HANDLE
    ld b,2
    call HEX_BYTES
    ld hl,size_text
    call SHOW
    ld hl,SIZE32
    call DEC32
    IFDEF APP_PCM
    call PCM_SHOW_TYPE
    ELSE
    ld hl,type_text
    call SHOW
    ENDIF
    ld hl,crc_text
    call SHOW
    ld hl,ACTUALCRC
    ld b,4
    call HEX_BYTES
    call NL
    call APP_SPEED
    call CLOSE_FILE
    jp c,FILE_ERROR
    ret
    ELSE
LOAD_FILE:
    jp SYNTAX
    ENDIF
    IFDEF APP_DUMP
DUMP_FILE:
    call BLOB_SETUP
    call APP_TIME_INIT
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,18
    ld bc,2
    ld e,38
    call RPC
    jp c,RPC_ERROR
    ld a,(RESP+3)
    cp 2
    jp z,PROTOCOL
    ; Default length=size-offset, still checked against uploaded.
    ld hl,(RESP+6)
    ld de,(DUMPOFF)
    or a
    sbc hl,de
    ld (SIZE32),hl
    ld hl,(RESP+8)
    ld de,(DUMPOFF+2)
    sbc hl,de
    jp c,MEM_ERROR
    ld (SIZE32+2),hl
    ld a,(HASLEN)
    or a
    jr z,.range
    ld hl,DUMPLEN
    ld de,SIZE32
    ld bc,4
    ldir
.range:
    ld hl,(SIZE32)
    ld de,(DUMPOFF)
    add hl,de
    ld (NUM32),hl
    ld hl,(SIZE32+2)
    ld de,(DUMPOFF+2)
    adc hl,de
    jp c,MEM_ERROR
    ld (NUM32+2),hl
    ld hl,RESP+10
    call SPACE_CHECK
    jp c,MEM_ERROR
    ; Existing output survives unless explicit OVERWRITE.
    ld hl,(ARGS+2)
    ld a,1
    ld c,0x11
    call FILECALL
    jr c,.missing
    ld (FILEHANDLE),a
    ld a,1
    ld (FILEOPEN),a
    call CLOSE_FILE
    jp c,FILE_ERROR
    ld a,(OVERWRITE)
    or a
    jp z,FILE_ERROR
    ld hl,(ARGS+2)
    ld c,0x0E ; DELETE required to truncate DSS CREATE_OVERWRITE.
    call FILECALL
    jp c,FILE_ERROR
    jr .create
.missing:
    cp 3 ; DSS error 3 = file not found.
    jp nz,FILE_ERROR
.create:
    ld hl,(ARGS+2)
    ld a,0x20
    ld c,0x0A
    call FILECALL
    jp c,FILE_ERROR
    ld (FILEHANDLE),a
    ld a,1
    ld (FILEOPEN),a
    ld (FILEOUTPUT),a
    call START_BLOCKS
    xor a
    ld (FILECRC),a
    ld (FILECRC+1),a
    ld (FILECRC+2),a
    ld (FILECRC+3),a
    ld hl,DUMPOFF
    ld de,POS32
    ld bc,4
    ldir
.loop:
    call NEXT_BLOCK
    jr z,.done
    call SESSION_CHECK
    jp c,RPC_ERROR
    call READ_BLOCK
    ld a,0x14
    call IO_BLOCK
    call FOLD_DUMP
    call ADVANCE
    call APP_TIME_NEXT
    jr .loop
.done:
    ld a,(VERIFY)
    or a
    jr z,.fast
    ld hl,FILECRC
    ld de,UGCRC.OUT
    ld bc,4
    ldir
    ld hl,host_crc_text
    call SHOW
    ld hl,UGCRC.OUT
    ld b,4
    call HEX_BYTES
    jr .result
.fast:
    ld hl,host_crc_fast
    call SHOW
.result:
    call NL
    call APP_TIME_NEXT
    call APP_SPEED
    jp PASS
    ELSE
DUMP_FILE:
    jp SYNTAX
    ENDIF
BLOB_CLEANUP:
    ; A held ESC must not cancel the bounded INFO/FREE recovery itself.
    ld a,1
    ld (UGTM.NOESC),a
    ld a,(UGXFER.DIR)
    or a
    call nz,UG_XFER_CANCEL
    ld a,(FILEOPEN)
    or a
    jr z,.object
    call CLOSE_FILE
    jr nc,.closed
    ld a,(ERR)
    or a
    jr nz,.closed
    ld a,5
    ld (ERR),a
    ld hl,file_reason
    ld (REASON),hl
.closed:
    xor a
    ld (FILEOPEN),a
    IFDEF APP_DUMP
    ld a,(ERR)
    or a
    jr z,.object
    ld a,(FILEOUTPUT)
    or a
    jr z,.object
    ld hl,partial_text
    call PRINT
    ENDIF
.object:
    ld a,(OWN)
    or a
    ret z
    IFDEF APP_LOAD
    ld a,(ERR)
    or a
    ret z
    ENDIF
    call SESSION_CHECK
    ret c
    IFDEF APP_PCM
    IFDEF APP_LOAD
    ; Even a failed reconciliation must never turn a READY PCM into a
    ; temporary object. A later bounded cleanup probe may see SEAL finish.
    ld a,(PCM_KIND)
    or a
    jr z,.free
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,18
    ld bc,2
    ld e,38
    call RPC
    ret c
    ld a,(RESP+3)
    cp 1
    ret z
.free:
    ENDIF
    ENDIF
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,17
    ld bc,2
    ld e,0
    call RPC
    ret nc
    ld a,(ERR)
    or a
    ret nz
    ld a,4
    ld (ERR),a
    ret
 ; DSS clock sampling, modulo midnight, outside grants. u32 totals.
    IFNDEF APP_PROTO
APP_TIME_CLOCK:
    push ix
    push iy
    ld c,0x21
    rst 0x10
    pop iy
    pop ix
    ld a,l
    ld (TIMEMIN),a
    ld a,b
    ld (TIMESEC),a
    ld b,h
    ld hl,0
    ld de,0
.hours:
    ld a,b
    or a
    jr z,.minutes
    ld a,l
    add a,0x10
    ld l,a
    ld a,h
    adc a,0x0E
    ld h,a
    jr nc,.nocarry
    inc de
.nocarry:
    djnz .hours
.minutes:
    ld a,(TIMEMIN)
    ld b,a
.minloop:
    ld a,b
    or a
    jr z,.seconds
    ld a,l
    add a,60
    ld l,a
    ld a,h
    adc a,0
    ld h,a
    jr nc,.mincarry
    inc de
.mincarry:
    djnz .minloop
.seconds:
    ld a,(TIMESEC)
    add a,l
    ld l,a
    ld a,h
    adc a,0
    ld h,a
    jr nc,.return
    inc de
.return:
    ld (NUM32),hl
    ld (NUM32+2),de
    ret
APP_TIME_INIT:
    call APP_TIME_CLOCK
    ld hl,NUM32
    ld de,TIMEPREV
    ld bc,4
    ldir
    ld hl,0
    ld (TIMEELAPSED),hl
    ld (TIMEELAPSED+2),hl
    ret
APP_TIME_NEXT:
    call APP_TIME_CLOCK
    ld hl,(NUM32)
    ld de,(TIMEPREV)
    or a
    sbc hl,de
    push hl
    ld hl,(NUM32+2)
    ld de,(TIMEPREV+2)
    sbc hl,de
    ex de,hl
    pop hl
    jr nc,.delta
    ld bc,0x5180
    add hl,bc
    ex de,hl
    ld bc,1
    adc hl,bc
    ex de,hl
.delta:
    ld bc,(TIMEELAPSED)
    add hl,bc
    ld (TIMEELAPSED),hl
    ex de,hl
    ld bc,(TIMEELAPSED+2)
    adc hl,bc
    ld (TIMEELAPSED+2),hl
    ld hl,NUM32
    ld de,TIMEPREV
    ld bc,4
    ldir
    ret
APP_SPEED:
    ld hl,time_text
    call SHOW
    ld hl,TIMEELAPSED
    call DEC32
    ld hl,(TIMEELAPSED)
    ld de,(TIMEELAPSED+2)
    ld a,h
    or l
    or d
    or e
    jr nz,.divide
    ld hl,speed_short
    call SHOW
    jp NL
.divide:
    ld hl,SIZE32
    ld de,TIMEQUOT
    ld bc,4
    ldir
    xor a
    ld (NUM32),a
    ld (NUM32+1),a
    ld (NUM32+2),a
    ld (NUM32+3),a
    ld b,32
.loop:
    ld hl,TIMEQUOT
    sla (hl)
    inc hl
    rl (hl)
    inc hl
    rl (hl)
    inc hl
    rl (hl)
    ld hl,NUM32
    rl (hl)
    inc hl
    rl (hl)
    inc hl
    rl (hl)
    inc hl
    rl (hl)
    ld hl,(NUM32)
    ld de,(TIMEELAPSED)
    or a
    sbc hl,de
    push hl
    ld hl,(NUM32+2)
    ld de,(TIMEELAPSED+2)
    sbc hl,de
    jr c,.skip
    ld (NUM32+2),hl
    pop hl
    ld (NUM32),hl
    ld hl,TIMEQUOT
    set 0,(hl)
    jr .next
.skip:
    pop hl
.next:
    djnz .loop
    ld hl,speed_text
    call SHOW
    ld hl,TIMEQUOT
    call DEC32
    jp NL
    ENDIF
crc_prefix: DB "/CRC:",0
offset_prefix: DB "/OFFSET:",0
length_prefix: DB "/LENGTH:",0
bulk_text: DB "transport=BULK",0
path_text: DB "transport=GS_DATA",0
file_reason: DB "FILE_IO",0
    IFDEF APP_DUMP
file_diag_text: DB "dss_fn=0x",0
file_a_text: DB " a=0x",0
file_f_text: DB " flags=0x",0
    ENDIF
verify_reason: DB "DATA_MISMATCH",0
partial_text: DB "INCOMPLETE output file retained",13,10,0
alloc_unknown: DB "ALLOC_RESULT_UNKNOWN",0
transfer_stage_text: DB "transfer_stage=0x",0
transfer_moved_text: DB " moved=",0
transfer_offset_text: DB " offset=0x",0
recovery_text: DB "Transfer recovery: INFO/OBJECT_INFO; operation not retried",0
    IFDEF UG_EXPERIMENT_WINDOW
experiment_text: DB "EXPERIMENTAL window_bytes=",0
experiment_turbo_text: DB " requested_write_turbo=",0
experiment_read_text: DB " read_turbo=0 REAL_PENDING",0
    ENDIF
crc_text: DB " crc=0x",0
host_crc_text: DB "host_crc=0x",0
host_crc_fast: DB "host_crc=NOT_COMPUTED",0
type_text: DB " type=BLOB",0
time_text: DB "host_seconds=",0
speed_text: DB " bytes_per_second=",0
speed_short: DB " SPEED=INSUFFICIENT_INTERVAL resolution_seconds=1",0

    IFDEF APP_DUMP
    INCLUDE "ugcrc_combine.asm"
    ENDIF
