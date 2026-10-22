; SPDX-License-Identifier: GPL-2.0-or-later
; Single-RPC PCM packets. All disk/keyboard calls occur between packets.
SV EQU 0x5D00
SBUFFER EQU SV ; u32 bytes
SPREFILL EQU SV+4
SLOWMARK EQU SV+8
SOPTIONS EQU SV+12
SOWN EQU SV+13
SSENT EQU SV+14
SSEQ EQU SV+16
SFREE EQU SV+20
SEND EQU SV+24 ; RIFF end, u32
SNEXT EQU SV+28 ; next chunk, u32
SDATA EQU SV+32 ; PCM file offset, u32
SLENGTH EQU SV+36 ; PCM bytes, u32
SFLAGS EQU SV+40
SSIZE EQU SV+44 ; current chunk bytes, u32
SREADLEFT EQU SV+48 ; unread host cache bytes, u16
SREADPTR EQU SV+50 ; next packet source, u16
SFRAME EQU SV+52 ; source frame bytes: 1/2/4
SBENCH EQU SV+53 ; bitmask: 1=DISK, 2=FEED, 4=PIPE, 7=ALL
SREPORT EQU SV+54
SSUPPLIED EQU SV+56 ; acknowledged PCM bytes, u32
SSTATE EQU SV+64 ; 70 bytes
; After WAV parsing STREAM needs neither the FX list nor BUF/BACK. Merge
; 4000h..57FFh for disk read-ahead; wire packets remain <=1024 bytes.
SDISKBUF EQU AFXRECORDS
SDISKSIZE EQU 6144
STREAM_INIT:
    ld hl,SV
    ld de,SV+1
    ld bc,143
    ld (hl),0
    ldir
    ld hl,SB
    ld de,SB+1
    ld bc,63
    ld (hl),0
    ldir
    ld a,8 ; 512 KiB = 00080000h
    ld (SBUFFER+2),a
    ret
STREAM_OPTION:
    push hl
    ld de,stream_bench_prefix
    call PREFIX
    jr c,.sizes
    ld de,stream_bench_values
    call LOOKUP
    pop de
    ret c
    ld hl,SBENCH
    ld b,a
    ld a,(hl)
    or a
    scf
    ret nz
    ld (hl),b
    ld hl,SOPTIONS
    set 3,(hl)
    xor a
    ret
.sizes:
    pop hl
    ld de,stream_prefixes
    ld b,0
.next:
    push hl
    push de
    push bc
    call PREFIX
    pop bc
    pop de
    jr nc,.number
    pop hl
.skip:
    ld a,(de)
    inc de
    or a
    jr nz,.skip
    inc b
    ld a,b
    cp 3
    jr c,.next
    scf
    ret
.number:
    pop de
    push bc
    call NUMBER32
    pop bc
    ret c
    ld c,b
    ld a,1
.mask:
    dec b
    jp m,.marked
    add a,a
    jr .mask
.marked:
    ld hl,SOPTIONS
    ld b,a
    and (hl)
    scf
    ret nz ; duplicate option
    ld a,b
    or (hl)
    ld (hl),a
    ld hl,(NUM32)
    ld de,(NUM32+2)
    ld b,10
.shift:
    call SHL32
    ret c
    djnz .shift
    push de
    push hl
    ld a,c
    add a,a
    add a,a
    ld l,a
    ld h,0
    ld de,SBUFFER
    add hl,de
    pop de
    ld (hl),e
    inc hl
    ld (hl),d
    inc hl
    pop de
    ld (hl),e
    inc hl
    ld (hl),d
    xor a
    ret
STREAM_VALIDATE:
    ld a,(ARGC)
    cp 2
    scf
    ret nz
    ld hl,(ARGS+2)
    ld (ARGS),hl
    ld a,(SLOW)
    ld b,a
    ld a,(MANIFEST)
    or b
    ld b,a
    ld a,(AFLAGS)
    or b
    ld b,a
    ld a,(AOPTS)
    and 3
    or b
    scf
    ret nz
    ld a,(SBENCH)
    or a
    jr z,.bench_ok
    ld a,(VERIFY)
    or a
    scf
    ret nz
.bench_ok:
    ; Extension, including RAW defaults, is validated before card accesses.
    ld hl,(ARGS)
    ld de,0
.scan:
    ld a,(hl)
    or a
    jr z,.extension
    cp '.'
    jr nz,.advance
    push hl
    pop de
.advance:
    inc hl
    jr .scan
.extension:
    ld a,d
    or e
    scf
    ret z
    ex de,hl
    inc hl
    ld de,audio_extensions
    call LOOKUP
    ret c
    cp 3
    ccf
    ret c
    ld (PCM_KIND),a
    cp 1
    jr nz,.wav
    ld a,(PCM_FIELDS)
    or a
    jr nz,.raw
    ld hl,44100
    ld (PCM_DESC),hl
    ld a,2
    ld (PCM_DESC+4),a
    ld (PCM_DESC+6),a
    ld a,16
    ld (PCM_DESC+5),a
    ld a,15
    ld (PCM_FIELDS),a
.raw:
    call PCM_VALIDATE
    ret c
    jr .sizes
.wav:
    ld a,(PCM_FIELDS)
    or a
    scf
    ret nz
.sizes:
    ld a,(SOPTIONS)
    bit 1,a
    jr nz,.low
    ld hl,SBUFFER
    ld de,SPREFILL
    call STREAM_HALF
.low:
    ld a,(SOPTIONS)
    bit 2,a
    jr nz,.bounds
    ld hl,SPREFILL
    ld de,SLOWMARK
    call STREAM_HALF
.bounds:
    ld hl,SPREFILL
    call STREAM_ZERO
    scf
    ret z
    ld hl,SPREFILL
    ld de,SBUFFER
    call STREAM_CMP
    ret c
    ld hl,SLOWMARK
    ld de,SPREFILL
    call STREAM_CMP
    ret c
    scf
    ret z
    xor a
    ret
STREAM_ZERO:
    ld a,(hl)
    inc hl
    or (hl)
    inc hl
    or (hl)
    inc hl
    or (hl)
    ret
STREAM_HALF:
    ld bc,4
    ldir
    dec de
    ex de,hl
    srl (hl)
    dec hl
    rr (hl)
    dec hl
    rr (hl)
    dec hl
    rr (hl)
    ret
; CF means left > right, Z means equal. Inputs point at u32 LE.
STREAM_CMP:
    ld bc,3
    add hl,bc
    ex de,hl
    add hl,bc
    ex de,hl
    ld b,4
.loop:
    ld a,(de)
    cp (hl)
    ret nz
    dec hl
    dec de
    djnz .loop
    ret
; Add source DE into destination HL, CF means u32 overflow.
STREAM_ADD:
    ld b,4
    or a
.loop:
    ld a,(de)
    adc a,(hl)
    ld (hl),a
    inc hl
    inc de
    djnz .loop
    ret
STREAM_SEEK:
    push ix
    push iy
    ld ix,(POS32)
    ld hl,(POS32+2)
    ld a,(FILEHANDLE)
    ld b,0
    ld c,0x15
    rst 0x10
    pop iy
    pop ix
    jp c,FILE_ERROR
    ret
STREAM_READ:
    ld (BLOCK),hl
    ld a,0x13
    jp IO_BLOCK
STREAM_WAV:
    ld hl,stream_twelve
    ld de,SIZE32
    call STREAM_CMP
    jp c,PCM_FORMAT_ERROR
    ld hl,12
    call STREAM_READ
    ld hl,BUF
    ld de,stream_riff
    ld b,4
    call STREAM_MATCH
    ld hl,BUF+8
    ld de,stream_wave
    ld b,4
    call STREAM_MATCH
    ld hl,BUF+4
    ld de,SEND
    ld bc,4
    ldir
    ld hl,SEND
    ld de,stream_eight
    call STREAM_ADD
    jp c,PCM_FORMAT_ERROR
    ld hl,SEND
    ld de,SIZE32
    call STREAM_CMP
    jp c,PCM_FORMAT_ERROR
    ld hl,12
    ld (POS32),hl
    ld hl,0
    ld (POS32+2),hl
.chunk:
    call AUDIO_KEY
    jp z,CANCEL_APP
    ld hl,POS32
    ld de,SEND
    call STREAM_CMP
    jp z,.done
    jp c,PCM_FORMAT_ERROR
    ld hl,POS32
    ld de,SNEXT
    ld bc,4
    ldir
    ld hl,SNEXT
    ld de,stream_eight
    call STREAM_ADD
    jp c,PCM_FORMAT_ERROR
    ld hl,SNEXT
    ld de,SEND
    call STREAM_CMP
    jp c,PCM_FORMAT_ERROR
    call STREAM_SEEK
    ld hl,8
    call STREAM_READ
    ld hl,BUF+4
    ld de,SSIZE
    ld bc,4
    ldir
    ld hl,SNEXT
    ld de,POS32 ; payload start = chunk header+8
    ld bc,4
    ldir
    ld hl,SNEXT
    ld de,SSIZE
    call STREAM_ADD
    jp c,PCM_FORMAT_ERROR
    ld a,(SSIZE)
    and 1
    jr z,.bound
    ld hl,SNEXT
    ld de,stream_one
    call STREAM_ADD
    jp c,PCM_FORMAT_ERROR
.bound:
    ld hl,SNEXT
    ld de,SEND
    call STREAM_CMP
    jp c,PCM_FORMAT_ERROR
    ld hl,BUF
    ld de,stream_fmt
    call STREAM_ID
    jr nz,.data
    ld a,(SFLAGS)
    and 1
    jp nz,PCM_FORMAT_ERROR
    ld hl,stream_sixteen
    ld de,SSIZE
    call STREAM_CMP
    jp c,PCM_FORMAT_ERROR
    ld hl,16
    call STREAM_READ
    call STREAM_WAV_FORMAT
    ld a,(SFLAGS)
    or 1
    ld (SFLAGS),a
    jr .next
.data:
    ld hl,BUF
    ld de,stream_data
    call STREAM_ID
    jr nz,.next
    ld a,(SFLAGS)
    and 2
    jp nz,PCM_FORMAT_ERROR
    ld hl,SSIZE
    call STREAM_ZERO
    jp z,PCM_FORMAT_ERROR
    ld hl,POS32
    ld de,SDATA
    ld bc,4
    ldir
    ld hl,SSIZE
    ld de,SLENGTH
    ld bc,4
    ldir
    ld a,(SFLAGS)
    or 2
    ld (SFLAGS),a
.next:
    ld hl,SNEXT
    ld de,POS32
    ld bc,4
    ldir
    jp .chunk
.done:
    ld a,(SFLAGS)
    cp 3
    jp nz,PCM_FORMAT_ERROR
    call STREAM_FRAME
    ld hl,SLENGTH
    call STREAM_ALIGNED
    ld hl,SDATA
    ld de,POS32
    ld bc,4
    ldir
    jp STREAM_SEEK
STREAM_ID:
    ld b,4
.loop:
    ld a,(de)
    cp (hl)
    ret nz
    inc hl
    inc de
    djnz .loop
    ret
STREAM_MATCH:
.loop:
    ld a,(de)
    cp (hl)
    jp nz,PCM_FORMAT_ERROR
    inc hl
    inc de
    djnz .loop
    ret
STREAM_RUN:
    ld a,(ACAPS+1)
    and 8
    jp z,AUDIO_UNSUPPORTED
    call OPEN_INPUT
    ld a,(PCM_KIND)
    cp 2
    jr nz,.raw
    call STREAM_WAV
    jr .describe
.raw:
    call STREAM_FRAME
    ld hl,SIZE32
    call STREAM_ALIGNED
    ld hl,SIZE32
    ld de,SLENGTH
    ld bc,4
    ldir
.describe:
    call STREAM_DESCRIBE
    ld a,(SBENCH)
    or a
    jp nz,STREAM_BENCH
    call STREAM_CREATE
    ld a,1
    ld (SREPORT),a
    jp STREAM_PLAY
STREAM_CREATE:
    call SESSION_CHECK
    jp c,RPC_ERROR
    ld hl,PCM_DESC
    ld de,REQ
    ld bc,8
    ldir
    ld hl,SBUFFER
    ld bc,12
    ldir
    ld a,UG_OP_STREAM_CREATE
    ld bc,20
    ld e,2
    call RPC
    jp c,RPC_ERROR
    ld hl,(RESP)
    ld (HANDLE),hl
    ld a,1
    ld (SOWN),a
    ret
STREAM_PLAY:
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,(AGAIN)
    ld (REQ+2),a
    ld a,(APAN)
    ld (REQ+3),a
    ld a,UG_OP_STREAM_START
    ld bc,4
    ld e,2
    call RPC
    jp c,RPC_ERROR
    ld hl,(RESP)
    ld (AID),hl
    ld hl,SLENGTH
    ld de,LEFT32
    ld bc,4
    ldir
    ld hl,0
    ld (POS32),hl
    ld (POS32+2),hl
.poll:
    call AUDIO_KEY
    jp z,CANCEL_APP
    call STREAM_STATUS
    ld a,(RESP+2)
    cp 4
    jp z,AUDIO_ERROR
    ld hl,LEFT32
    call STREAM_ZERO
    jr z,.eof
    ld a,(RESP+3)
    bit 1,a
    jr z,.poll
    call SESSION_CHECK
    jp c,RPC_ERROR
.refill:
    call STREAM_NEXT_BLOCK
    jr z,.poll
    ld hl,(SFREE+2)
    ld a,h
    or l
    jr nz,.room
    ld hl,(SFREE)
    ld de,(BLOCK)
    or a
    sbc hl,de
    jr nc,.room
    add hl,de
    ld a,h
    or l
    jr z,.poll
    ld (BLOCK),hl
.room:
    call STREAM_FEED
    call ADVANCE
    ld hl,(SREADPTR)
    ld de,(BLOCK)
    add hl,de
    ld (SREADPTR),hl
    ld hl,(SREADLEFT)
    or a
    sbc hl,de
    ld (SREADLEFT),hl
    ld hl,SFREE
    ; Subtract BLOCK from the local free budget.
    ld bc,(BLOCK)
    ld a,(hl)
    sub c
    ld (hl),a
    inc hl
    ld a,(hl)
    sbc a,b
    ld (hl),a
    inc hl
    ld a,(hl)
    sbc a,0
    ld (hl),a
    inc hl
    ld a,(hl)
    sbc a,0
    ld (hl),a
    jp .refill
.eof:
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,UG_OP_STREAM_EOF
    ld bc,2
    ld e,0
    call RPC
    jp c,RPC_ERROR
.drain:
    call AUDIO_KEY
    jp z,CANCEL_APP
    call STREAM_STATUS
    ld a,(RESP+2)
    cp 4
    jp z,AUDIO_ERROR
    cp 3
    jr nz,.drain
    jp PASS
; One key scan between complete packets. The resident loader's NEXT_BLOCK
; also samples/converts the DSS wall clock for upload progress on every KiB;
; STREAM has no such progress display and must not pay that cost.
STREAM_NEXT_BLOCK:
    call AUDIO_KEY
    jp z,CANCEL_APP
    ld hl,LEFT32
    call STREAM_ZERO
    ret z
    ld hl,SFREE
    call STREAM_ZERO
    ret z
    ld hl,(SREADLEFT)
    ld a,h
    or l
    jr nz,.packet
    ; Read ahead only between packets. A short final group is bounded by
    ; the WAV data length, so metadata following 'data' is never submitted.
    ld hl,(LEFT32+2)
    ld a,h
    or l
    ld de,SDISKSIZE
    jr nz,.read
    ld hl,(LEFT32)
    or a
    sbc hl,de
    jr nc,.read
    add hl,de
    ex de,hl
.read:
    ld (SREADLEFT),de
    ld hl,SDISKBUF
    ld (SREADPTR),hl
    call IO_READ_AT
    ld hl,(SREADLEFT)
.packet:
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
    ld a,1
    or a
    ret
STREAM_STATUS:
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,UG_OP_STREAM_STATE
    ld bc,2
    ld e,70
    call RPC
    jp c,RPC_ERROR
    ld hl,RESP+40
    ld de,SSEQ
    ld bc,4
    ldir
    ld hl,RESP+20
    ld de,SFREE
    ld bc,4
    ldir
    ret
STREAM_FEED:
    ld hl,(HANDLE)
    ld (REQ),hl
    ld hl,SSEQ
    ld de,REQ+2
    ld bc,4
    ldir
    ld hl,(BLOCK)
    ld (REQ+6),hl
    xor a
    ld (REQ+8),a
    ld (SSENT),a
    ld bc,9
    ld a,(VERIFY)
    or a
    jr z,.send
    ld hl,(SREADPTR)
    ld bc,(BLOCK)
    call UG_CRC32
    ld hl,UGCRC.OUT
    ld de,REQ+9
    ld bc,4
    ldir
    ld a,128
    ld (REQ+8),a
    ld bc,13
.send:
    ld a,1
    ld (UGTM.NOESC),a ; keyboard only after the complete packet
    ld a,UG_OP_STREAM_FEED
    ld e,12
    call RPC
    push af
    xor a
    ld (UGTM.NOESC),a
    pop af
    jr c,.recover
    ld hl,RESP
    jr .ack
.recover:
    ld a,(UG_LAST_SOURCE)
    cp 1
    jp nz,RPC_ERROR_RELOAD
    call SESSION_CHECK
    jp c,AUDIO_SESSION_ERROR
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,UG_OP_STREAM_STATE
    ld bc,2
    ld e,70
    call RPC
    jp c,RPC_ERROR
    ld hl,RESP+40 ; confirmed next sequence after lost ACK
.ack:
    push hl
    ld hl,(SSEQ)
    inc hl
    ld (SSEQ),hl
    ld a,h
    or l
    jr nz,.compare
    ld hl,(SSEQ+2)
    inc hl
    ld (SSEQ+2),hl
.compare:
    pop hl
    ld de,SSEQ
    ld b,4
.loop:
    ld a,(de)
    cp (hl)
    jp nz,PROTOCOL ; unconfirmed packet is never blindly retried
    inc hl
    inc de
    djnz .loop
    ld hl,SSUPPLIED
    ld de,BLOCK
    ; BLOCK is u16, so add it with explicit carry, not a u32 memory read.
    ld bc,(BLOCK)
    call STREAM_ADD_COUNT
    ld hl,SBPACKETS
    jp STREAM_INC32
; Called by the RPC wait loop only after observing WRITE_GRANT.
; No RPC BEGIN/END and no per-byte polls. No alternate stack or DSS calls.
STREAM_BULK:
    ld a,(SSENT)
    or a
    ret nz
    ld hl,0
    ld (UGXFER.SENT),hl
.loop:
    ld hl,(BLOCK)
    ld de,(UGXFER.SENT)
    or a
    sbc hl,de
    jr z,.done
    IFDEF UG_EXPERIMENT_TURBO_WRITE
    ; One granted packet per window: no four repeated mapper/Turbo round
    ; trips. Even hardware Turbo denial must stay within the 10 ms budget.
    ld bc,1024
    ELSE
    call UG_SAFE_CHUNK
    ENDIF
    or a
    sbc hl,bc
    jr nc,.chunk
    add hl,bc
    ld b,h
    ld c,l
.chunk:
    push bc
    call UG_WIN_OPEN
    jr c,.fail
    IFDEF UG_EXPERIMENT_TURBO_WRITE
    ld bc,UG_PORT_SYS_RAM
    ld a,3
    out (c),a
    ENDIF
    ld hl,(SREADPTR)
    ld de,(UGXFER.SENT)
    add hl,de
    pop bc
    push bc
    call UG_BULK_WRITE
    call UG_ISA_CLOSE
    pop bc
    ld hl,(UGXFER.SENT)
    add hl,bc
    ld (UGXFER.SENT),hl
    jr .loop
.fail:
    pop bc
    ret
.done:
    ld a,1
    ld (SSENT),a
    xor a
    ret
STREAM_CLEANUP:
    ld a,(CMD)
    cp 11
    ret nz
    ld a,(ERR)
    ld (SV+134),a
    ld hl,(REASON)
    ld (SV+136),hl
    call STREAM_CLEANUP_WORK
    ld a,(SV+134)
    or a
    ret z
    ld (ERR),a
    ld hl,(SV+136)
    ld (REASON),hl
    ret
STREAM_CLEANUP_WORK:
    ; Exit already saved ERR/REASON. Diagnostics use raw RPC returns and cannot
    ; jump to EXIT or prevent CLOSE after a lost state response.
    ld a,(UG_LAST_ERROR)
    push af
    ld a,(UG_LAST_SOURCE)
    push af
    ld a,1
    ld (UGTM.NOESC),a
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    ld a,(SBACTIVE)
    or a
    call nz,STREAM_BENCH_END
    call STREAM_EXIT_REPORT
    pop af
    ld (UG_LAST_SOURCE),a
    pop af
    ld (UG_LAST_ERROR),a
    ld a,(SOWN)
    or a
    ret z
    ld a,1
    ld (UGTM.NOESC),a
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    call SESSION_CHECK
    jr c,.failed
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,UG_OP_STREAM_CLOSE
    ld bc,2
    ld e,0
    call RPC
    jr c,.failed
    xor a
    ld (SOWN),a
    ret
.failed:
    ld a,(ERR)
    or a
    ret nz
    ld a,8
    ld (ERR),a
    ld hl,stream_cleanup_text
    ld (REASON),hl
    ret
; Descriptor validation shared by WAV and RAW. All products fit u32.
STREAM_FRAME:
    ld a,(PCM_DESC+5)
    cp 16
    ld a,(PCM_DESC+4)
    jr nz,.done
    add a,a
.done:
    ld (SFRAME),a
    ret
STREAM_ALIGNED:
    ld a,(SFRAME)
    dec a
    and (hl)
    jp nz,PCM_FORMAT_ERROR
    ret
STREAM_WAV_FORMAT:
    ld hl,(BUF)
    dec hl
    ld a,h
    or l
    jp nz,PCM_FORMAT_ERROR
    ld a,(BUF+3)
    ld b,a
    ld a,(BUF+15)
    or b
    ld b,a
    ld hl,(BUF+6)
    ld a,h
    or l
    or b
    jp nz,PCM_FORMAT_ERROR
    ld hl,BUF+4
    ld de,PCM_DESC
    ld bc,4
    ldir
    ld a,(BUF+2)
    ld (PCM_DESC+4),a
    ld a,(BUF+14)
    ld (PCM_DESC+5),a
    cp 16
    ld a,0
    jr nz,.fmt
    ld a,2
.fmt:
    ld (PCM_DESC+6),a
    ; PCM_VALIDATE requires the complete RAW CLI marker, restore WAV kind.
    ld a,1
    ld (PCM_KIND),a
    ld a,15
    ld (PCM_FIELDS),a
    call PCM_VALIDATE
    jp c,PCM_FORMAT_ERROR
    ld a,2
    ld (PCM_KIND),a
    xor a
    ld (PCM_FIELDS),a
    call STREAM_FRAME
    ld hl,(BUF+12)
    ld a,(SFRAME)
    ld e,a
    ld d,0
    or a
    sbc hl,de
    jp nz,PCM_FORMAT_ERROR
    call STREAM_BYTE_RATE
    ld hl,NUM32
    ld de,BUF+8
    call STREAM_CMP
    jp nz,PCM_FORMAT_ERROR
    ret
STREAM_BYTE_RATE:
    ld hl,(PCM_DESC)
    ld de,(PCM_DESC+2)
    ld a,(SFRAME)
.shift:
    srl a
    jr z,.done
    push af
    call SHL32
    pop af
    jr .shift
.done:
    ld (NUM32),hl
    ld (NUM32+2),de
    ret
STREAM_DESCRIBE:
    ld hl,stream_format_text
    call SHOW
    ld hl,PCM_DESC
    call DEC32
    ld hl,stream_ch_text
    call SHOW
    ld a,(PCM_DESC+4)
    ld l,a
    ld h,0
    call DEC16
    ld hl,stream_bits_text
    call SHOW
    ld a,(PCM_DESC+5)
    ld l,a
    ld h,0
    call DEC16
    ld hl,stream_fmt_text
    call SHOW
    ld a,(PCM_DESC+6)
    ld hl,stream_u8
    or a
    jr z,.format
    ld hl,stream_s8
    dec a
    jr z,.format
    ld hl,stream_s16
.format:
    call SHOW
    ld hl,stream_required_text
    call SHOW
    call STREAM_BYTE_RATE
    ld hl,NUM32
    call DEC32
    jp NL
STREAM_EXIT_REPORT:
    ld a,(SREPORT)
    or a
    ret z
    xor a
    ld (SREPORT),a
    ld a,(ERR)
    or a
    ld hl,stream_report
    jr z,.label
    ld hl,stream_cancel_report
.label:
    call SHOW
    call SESSION_CHECK
    jr c,.unknown
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,UG_OP_STREAM_STATE
    ld bc,2
    ld e,70
    call RPC
    jr c,.unknown
    ld hl,RESP+44
    call DEC32
    jr .bytes
.unknown:
    ld hl,stream_unknown
    call SHOW
.bytes:
    ld hl,stream_bytes
    call SHOW
    ld hl,SSUPPLIED
    call DEC32
    jp NL
; Count actual DSS READ invocations, including completed short reads.
STREAM_COUNT_READ:
    push af
    ld a,(SBACTIVE)
    or a
    jr z,.done
    ld a,c
    cp 0x13
    jr nz,.done
    push hl
    ld hl,SBREADS
    call STREAM_INC32
    pop hl
.done:
    pop af
    ret
STREAM_COUNT_READ_RESULT:
    ret c
    push af
    ld a,(SBACTIVE)
    or a
    jr z,.done
    ld a,(SBKIND)
    cp 1
    jr nz,.done
    push hl
    push bc
    ld b,d
    ld c,e
    ld hl,SBBYTES
    call STREAM_ADD_COUNT
    pop bc
    pop hl
.done:
    pop af
    ret
STREAM_INC32:
    inc (hl)
    ret nz
    inc hl
    inc (hl)
    ret nz
    inc hl
    inc (hl)
    ret nz
    inc hl
    inc (hl)
    ret
STREAM_ADD_COUNT:
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
    ret
; STREAM has exclusive use of the unused resident FX-enumeration workspace.
SB EQU AFXOLD
SBACTIVE EQU SB
SBVALID EQU SB+1
SBKIND EQU SB+2
SBREADS EQU SB+4
SBPACKETS EQU SB+8
SBBYTES EQU SB+12
SBSTART EQU SB+16 ; u64 output frames
SBDELTA EQU SB+24 ; u64, used as divisor
SBNUM EQU SB+32 ; u64 dividend/quotient
SBREM EQU SB+40 ; u64 remainder
SBPRODUCT EQU SB+48 ; u64 shifted multiplicand
SBHZ EQU SB+56 ; u32 multiplier
SBERROR EQU SB+60
STREAM_BENCH:
    ld hl,SB
    ld de,SB+1
    ld bc,63
    ld (hl),0
    ldir
    ld a,(SBENCH)
    bit 0,a
    call nz,STREAM_BENCH_DISK
    ld a,(SBENCH)
    bit 1,a
    call nz,STREAM_BENCH_FEED
    ; An unconfirmed CLOSE must not be hidden by CREATE for the next phase.
    ld a,(ERR)
    or a
    jp nz,EXIT
    xor a
    ld (UGTM.NOESC),a ; cleanup's protected wait ends before the next phase
    ld a,(SBENCH)
    bit 2,a
    call nz,STREAM_BENCH_PIPE
    ld a,(ERR)
    jp EXIT
; Each file phase starts at PCM data, even after DISK in /BENCH:ALL.
STREAM_BENCH_REWIND:
    ld hl,SDATA
    ld de,POS32
    ld bc,4
    ldir
    ld hl,0
    ld (SREADLEFT),hl
    jp STREAM_SEEK
; cap a u32 HL value to 1 MiB in LEFT32; all limits frame aligned.
STREAM_BENCH_LIMIT:
    ld de,LEFT32
    ld bc,4
    ldir
    ld hl,LEFT32
    ld de,stream_megabyte
    call STREAM_CMP
    ret nc
    ld hl,stream_megabyte
    ld de,LEFT32
    ld bc,4
    ldir
    ret
STREAM_BENCH_DISK:
    call STREAM_BENCH_REWIND
    ld a,1
    ld (SBKIND),a
    ld hl,SLENGTH
    call STREAM_BENCH_LIMIT
    call STREAM_BENCH_BEGIN
.loop:
    call AUDIO_KEY
    jp z,CANCEL_APP
    ld hl,LEFT32
    call STREAM_ZERO
    jp z,STREAM_BENCH_END
    ld hl,(LEFT32+2)
    ld a,h
    or l
    ld de,SDISKSIZE
    jr nz,.read
    ld hl,(LEFT32)
    or a
    sbc hl,de
    jr nc,.read
    add hl,de
    ex de,hl
.read:
    ld (BLOCK),de
    ld hl,SDISKBUF
    call IO_READ_AT
    call ADVANCE
    jr .loop
STREAM_BENCH_FEED:
    ld a,2
    jr STREAM_BENCH_SEND
STREAM_BENCH_PIPE:
    call STREAM_BENCH_REWIND
    ld a,3
STREAM_BENCH_SEND:
    ld (SBKIND),a
    call STREAM_CREATE
    ld hl,SBUFFER
    call STREAM_BENCH_LIMIT
    ld a,(SBKIND)
    cp 3
    jr nz,.synthetic
    ld hl,LEFT32
    ld de,SLENGTH
    call STREAM_CMP
    jr nc,.start
    ld hl,SLENGTH
    call STREAM_BENCH_LIMIT
    jr .start
.synthetic:
    ld hl,SDISKBUF
    ld de,SDISKBUF+1
    ld bc,1023
    ld (hl),128
    ldir
    ld hl,SDISKBUF
    ld (SREADPTR),hl
.start:
    call STREAM_STATUS
    call STREAM_BENCH_BEGIN
.loop:
    call AUDIO_KEY
    jp z,CANCEL_APP
    ld hl,LEFT32
    call STREAM_ZERO
    jr z,.done
    ld a,(SBKIND)
    cp 3
    jr nz,.synthetic_packet
    call STREAM_NEXT_BLOCK
    jr .send
.synthetic_packet:
    ld hl,(LEFT32+2)
    ld a,h
    or l
    ld hl,1024
    jr nz,.packet
    ld hl,(LEFT32)
    ld de,1024
    or a
    sbc hl,de
    jr nc,.full
    add hl,de
    jr .packet
.full:
    ld hl,1024
.packet:
    ld (BLOCK),hl
.send:
    call STREAM_FEED
    call ADVANCE
    ld a,(SBKIND)
    cp 3
    jr nz,.count
    ld hl,(SREADPTR)
    ld de,(BLOCK)
    add hl,de
    ld (SREADPTR),hl
    ld hl,(SREADLEFT)
    or a
    sbc hl,de
    ld (SREADLEFT),hl
.count:
    ld hl,SBBYTES
    ld bc,(BLOCK)
    call STREAM_ADD_COUNT
    jr .loop
.done:
    call STREAM_BENCH_END
    ; CLOSE before PASS (cleanup also closes on cancellation/fault).
    jp STREAM_CLEANUP
; Non-fatal snapshot: raw RPC, exact session check, no diagnostic EXIT paths.
STREAM_BENCH_SNAPSHOT:
    ld a,UG_OP_SNAPSHOT
    ld bc,0
    ld e,64
    call RPC
    ret c
    ld hl,RESP+4
    ld de,SESSION
    ld b,8
.loop:
    ld a,(de)
    cp (hl)
    scf
    ret nz
    inc hl
    inc de
    djnz .loop
    xor a
    ret
STREAM_BENCH_BEGIN:
    ld hl,SBREADS
    ld de,SBREADS+1
    ld bc,11
    ld (hl),0
    ldir
    ld a,1
    ld (SBACTIVE),a
    ld (SBVALID),a
    call STREAM_BENCH_SNAPSHOT
    jr c,.unknown
    ld hl,RESP+12
    ld de,SBSTART
    ld bc,8
    ldir
    ret
.unknown:
    xor a
    ld (SBVALID),a
    ret
STREAM_BENCH_END:
    xor a
    ld (SBACTIVE),a
    call STREAM_BENCH_SNAPSHOT
    jr c,.unknown
    ld hl,RESP+12
    ld de,SBSTART
    ld ix,SBDELTA
    ld b,8
    or a
.subtract:
    ld a,(de)
    ld c,a
    ld a,(hl)
    sbc a,c
    ld (ix+0),a
    inc ix
    inc hl
    inc de
    djnz .subtract
    jr nc,.print
.unknown:
    xor a
    ld (SBVALID),a
.print:
    ld hl,stream_bench_disk_text
    ld a,(SBKIND)
    cp 1
    jr z,.label
    ld hl,stream_bench_feed_text
    cp 2
    jr z,.label
    ld hl,stream_bench_pipe_text
.label:
    call SHOW
    ld hl,stream_bytes
    call SHOW
    ld hl,SBBYTES
    call DEC32
    ld hl,stream_delta_text
    call SHOW
    ld a,(SBVALID)
    or a
    jr z,.bad_delta
    ; The <=1 MiB operation must finish before 2^32 frames (~24h).
    ld hl,SBDELTA+4
    call STREAM_ZERO
    jr nz,.bad_delta
    ld hl,SBDELTA
    call DEC32
    jr .counts
.bad_delta:
    xor a
    ld (SBVALID),a
    ld hl,stream_unknown
    call SHOW
.counts:
    ld hl,stream_reads_text
    call SHOW
    ld hl,SBREADS
    call DEC32
    ld hl,stream_packets_text
    call SHOW
    ld hl,SBPACKETS
    call DEC32
    ld hl,stream_bps_text
    call SHOW
    ld a,(SBVALID)
    or a
    jr z,.insufficient
    ; Require at least 100 ms of card time. Compare delta*10 >= output_hz.
    ld hl,(ACAPS+8)
    ld de,(ACAPS+10)
    ld a,h
    or l
    or d
    or e
    jr z,.insufficient
    ; output_hz is 48000 in this API. Bound precision conservatively to
    ; >=output_hz frames/8 (125 ms), avoiding any optimistic rounding.
    srl d
    rr e
    rr h
    rr l
    srl d
    rr e
    rr h
    rr l
    srl d
    rr e
    rr h
    rr l
    ld (NUM32),hl
    ld (NUM32+2),de
    ld hl,NUM32
    ld de,SBDELTA
    call STREAM_CMP
    jr c,.insufficient
    call STREAM_BENCH_SPEED
    ld hl,SBNUM+4
    call STREAM_ZERO
    jr nz,.insufficient
    ld hl,SBNUM
    call DEC32
    jp NL
.insufficient:
    ld hl,stream_insufficient
    call SHOW
    jp NL
; bytes*output_hz / delta_frames, exact unsigned 64/64 long division.
; All work is after the end snapshot, with interrupts and normal mapping.
STREAM_BENCH_SPEED:
    ld hl,SBNUM
    ld de,SBNUM+1
    ld bc,31
    ld (hl),0
    ldir
    ld hl,SBBYTES
    ld de,SBPRODUCT
    ld bc,4
    ldir
    ld hl,ACAPS+8
    ld de,SBHZ
    ld bc,4
    ldir
    ld b,32
.multiply:
    push bc
    ld a,(SBHZ)
    and 1
    jr z,.shift
    ld hl,SBNUM
    ld de,SBPRODUCT
    call STREAM_ADD8
.shift:
    ld hl,SBPRODUCT
    call STREAM_SHIFT8
    ld hl,SBHZ+3
    srl (hl)
    dec hl
    rr (hl)
    dec hl
    rr (hl)
    dec hl
    rr (hl)
    pop bc
    djnz .multiply
    ld b,64
.divide:
    push bc
    ld hl,SBNUM
    call STREAM_SHIFT8
    ld hl,SBREM
    ; SHIFT8 clears carry; rotate here must retain dividend's top bit.
    ld b,8
.rotate:
    rl (hl)
    inc hl
    djnz .rotate
    ld hl,SBREM
    ld de,SBDELTA
    call STREAM_CMP8
    jr c,.next
    ld hl,SBREM
    ld de,SBDELTA
    ld b,8
    or a
.sub:
    ld a,(de)
    ld c,a
    ld a,(hl)
    sbc a,c
    ld (hl),a
    inc hl
    inc de
    djnz .sub
    ld hl,SBNUM
    set 0,(hl)
.next:
    pop bc
    djnz .divide
    ret
STREAM_SHIFT8:
    or a
    ld b,8
.loop:
    rl (hl)
    inc hl
    djnz .loop
    ret
STREAM_ADD8:
    or a
    ld b,8
.loop:
    ld a,(de)
    adc a,(hl)
    ld (hl),a
    inc hl
    inc de
    djnz .loop
    ret
STREAM_CMP8:
    ld bc,7
    add hl,bc
    ex de,hl
    add hl,bc
    ex de,hl
    ld b,8
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
stream_megabyte: DD 1048576
stream_format_text: DB "stream rate=",0
stream_ch_text: DB " channels=",0
stream_bits_text: DB " bits=",0
stream_fmt_text: DB " format=",0
stream_u8: DB "U8",0
stream_s8: DB "S8",0
stream_s16: DB "S16LE",0
stream_required_text: DB " required_Bps=",0
stream_bench_disk_text: DB "BENCH DISK",0
stream_bench_feed_text: DB "BENCH FEED",0
stream_bench_pipe_text: DB "BENCH PIPE",0
stream_delta_text: DB " delta_frames=",0
stream_reads_text: DB " READ_calls=",0
stream_packets_text: DB " packet_count=",0
stream_bps_text: DB " Bps=",0
stream_insufficient: DB "unknown INSUFFICIENT_INTERVAL",0
    ASSERT SB+64 <= HEADER

stream_cleanup_text: DB "STREAM_CLOSE_UNCONFIRMED",0
stream_prefixes: DB "/BUFFER:",0,"/PREFILL:",0,"/LOW:",0
stream_riff: DB "RIFF"
stream_wave: DB "WAVE"
stream_fmt: DB "fmt "
stream_data: DB "data"
stream_twelve: DD 12
stream_eight: DD 8
stream_one: DD 1
stream_sixteen: DD 16
stream_report: DB "stream EOF underruns=",0
stream_cancel_report: DB "stream exit underruns=",0
stream_unknown: DB "unknown",0
stream_bytes: DB " bytes=",0
stream_bench_prefix: DB "/BENCH:",0
stream_bench_values: DB "DISK",0,1,"FEED",0,2,"PIPE",0,4,"ALL",0,7,0
    ASSERT SV+144 <= HEADER
    ASSERT SDISKBUF == 0x4000 ; resident DSS ends here
    ASSERT SDISKBUF+SDISKSIZE == BACK+1024
    ASSERT SDISKBUF+SDISKSIZE <= REQ
    ASSERT SDISKBUF+SDISKSIZE <= PCM_DESC
    ASSERT SDISKBUF+SDISKSIZE <= AV
    ASSERT SDISKBUF+SDISKSIZE <= SV
    ASSERT SDISKBUF+SDISKSIZE <= V
    ASSERT SDISKBUF+SDISKSIZE <= HEADER
    ASSERT SDISKBUF+SDISKSIZE <= AFXOLD
    ASSERT AFXRECORDS+4096 <= AFXOLD
    ASSERT AFXOLD+512 <= HEADER
