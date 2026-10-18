; SPDX-License-Identifier: GPL-2.0-or-later
; Shared RAW/WAV upload metadata. File bytes remain unchanged in the store.
PCM_DESC EQU 0x5900
PCM_KIND EQU PCM_DESC+24
PCM_FIELDS EQU PCM_DESC+25
PCM_INIT:
    ld hl,PCM_DESC
    ld de,PCM_DESC+1
    ld bc,31
    ld (hl),0
    ldir
    ret
PCM_OPTION:
    push hl
    ld de,pcm_types
    call LOOKUP
    pop hl
    jr c,.numeric
    dec a
    ld (PCM_KIND),a
    ; BLOBTYPE is the explicit /TYPE option marker, not the object kind.
    ; ALLOC takes its kind from PCM_KIND, including BLOB=0.
    ld a,1
    ld (BLOBTYPE),a
    or a
    ret
.numeric:
    ld de,pcm_prefixes
    ld b,1
.next:
    push hl
    push de
    push bc
    call PREFIX
    pop bc
    pop de
    jr nc,.value
    pop hl
.skip:
    ld a,(de)
    inc de
    or a
    jr nz,.skip
    inc b
    ld a,b
    cp 5
    jr c,.next
    scf
    ret
.value:
    pop de ; original token is no longer needed
    ld a,b
    cp 4
    jr z,.fmt
    push bc
    call NUMBER
    pop bc
    ret c
    ld a,b
    cp 1
    jr nz,.bits
    ld (PCM_DESC),de
    ld a,1
    jr .field
.bits:
    ld a,d
    or a
    scf
    ret nz
    ld a,b
    cp 2
    jr nz,.channels
    ld a,e
    ld (PCM_DESC+5),a
    ld a,2
    jr .field
.channels:
    ld a,e
    ld (PCM_DESC+4),a
    ld a,4
    jr .field
.fmt:
    ld de,pcm_formats
    call LOOKUP
    ret c
    dec a
    ld (PCM_DESC+6),a
    ld a,8
.field:
    ld hl,PCM_FIELDS
    or (hl)
    ld (hl),a
    or a
    ret
PCM_VALIDATE:
    ld a,(PCM_KIND)
    cp 1
    jr z,.raw
    ld a,(PCM_FIELDS)
    or a
    ret z
.bad:
    scf
    ret
.raw:
    ld a,(PCM_FIELDS)
    cp 15
    jr nz,.bad
    ld hl,(PCM_DESC)
    ld de,8000
    or a
    sbc hl,de
    jr c,.bad
    ld de,40001
    or a
    sbc hl,de
    jr nc,.bad
    ld a,(PCM_DESC+4)
    dec a
    cp 2
    jr nc,.bad
    ld a,(PCM_DESC+5)
    cp 8
    jr z,.eight
    cp 16
    jr nz,.bad
    ld a,(PCM_DESC+6)
    cp 2
    jr nz,.bad
    xor a
    ret
.eight:
    ld a,(PCM_DESC+6)
    cp 2
    jr nc,.bad
    xor a
    ret
PCM_PREFLIGHT:
    ld a,(PCM_KIND)
    cp 1
    jr nz,.caps
    ; Reject nonintegral PCM frames before ALLOC.
    ld a,(PCM_DESC+5)
    rrca
    rrca
    rrca
    ld b,a
    ld a,(PCM_DESC+4)
    cp 1
    ld a,b
    jr z,.align
    add a,a
.align:
    dec a
    ld b,a
    ld a,(SIZE32)
    and b
    jp nz,PCM_FORMAT_ERROR
.caps:
    ld a,1
    ld bc,0
    ld e,32
    call RPC
    jp c,RPC_ERROR
    ld a,(PCM_KIND)
    or a
    ret z
    cp 2
    ld b,4
    jr z,.check
    cp 3
    ld b,8
    jr z,.check
    ld b,1
    ld a,(PCM_DESC+5)
    cp 8
    jr z,.check
    ld b,2
.check:
    ld a,(RESP+4)
    and b
    jp z,PCM_UNSUPPORTED
    ret
PCM_CONFIGURE:
    ld a,(PCM_KIND)
    cp 1
    ret nz
    ld hl,SIZE32
    ld de,PCM_DESC+12
    ld bc,4
    ldir
    ld hl,(HANDLE)
    ld (REQ),hl
    ld hl,PCM_DESC
    ld de,REQ+2
    ld bc,24
    ldir
    ld a,20
    ld bc,26
    ld e,0
    call RPC
    jp c,RPC_ERROR
    ret
    IFDEF APP_LOAD
PCM_SEAL_ERROR:
    ; A lost SEAL response does not imply a failed SEAL. Inspect the owned
    ; object in the original session before cleanup can free anything.
    ld a,(PCM_KIND)
    or a
    jp z,RPC_ERROR_RELOAD_SEAL
    ld a,(UG_LAST_SOURCE)
    cp 1
    jp nz,RPC_ERROR_RELOAD_SEAL
    ld a,(UG_LAST_ERROR)
    ld (SAVEDERR),a
    ld a,1
    ld (UGTM.NOESC),a
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    call SESSION_CHECK
    jr c,.unknown
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,18
    ld bc,2
    ld e,38
    call RPC
    jr c,.unknown
    ld a,(RESP+3)
    cp 1
    jr nz,.unknown
    xor a
    ld (OWN),a
    ld hl,handle_text
    call SHOW
    ld hl,HANDLE
    ld b,2
    call HEX_BYTES
    call NL
    ld hl,pcm_seal_ready_text
    jr .failed
.unknown:
    ld hl,pcm_seal_unknown_text
.failed:
    ld (REASON),hl
    ld a,(SAVEDERR)
    ld (UG_LAST_ERROR),a
    ld a,1
    ld (UG_LAST_SOURCE),a
RPC_ERROR_RELOAD_SEAL:
    ld a,(UG_LAST_ERROR)
    jp RPC_ERROR
pcm_seal_ready_text: DB "SEAL_RESULT_READY_NOT_RETRIED",0
pcm_seal_unknown_text: DB "SEAL_RESULT_UNKNOWN_NOT_RETRIED",0
PCM_SHOW_TYPE:
    ld a,(PCM_KIND)
    ld hl,type_text
    or a
    jp z,SHOW
    ld hl,pcm_raw_text
    cp 1
    jr z,.type
    ld hl,pcm_wav_text
    cp 3
    jr nz,.type
    ld hl,pcm_mod_text
    call SHOW
    ret
.type:
    call SHOW
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,18
    ld bc,2
    ld e,38
    call RPC
    jp c,RPC_ERROR
    ld hl,pcm_rate_text
    call SHOW
    ld hl,RESP+26
    call DEC32
    ld hl,pcm_channels_text
    call SHOW
    ld a,(RESP+34)
    ld l,a
    ld h,0
    call DEC16
    ld hl,pcm_bits_text
    call SHOW
    ld a,(RESP+35)
    ld l,a
    ld h,0
    call DEC16
    ld hl,pcm_fmt_text
    call SHOW
    ld a,(RESP+36)
    ld l,a
    ld h,0
    call DEC16
    ret
pcm_rate_text: DB " state=READY rate=",0
pcm_channels_text: DB " channels=",0
pcm_bits_text: DB " bits=",0
pcm_fmt_text: DB " format=",0
    ENDIF
PCM_FORMAT_ERROR:
    ld hl,pcm_format_text
    ld (REASON),hl
    ld a,6
    jp EXIT
PCM_UNSUPPORTED:
    ld hl,pcm_unsupported_text
    ld (REASON),hl
    jp PROTOCOL
pcm_types: DB "/TYPE:BLOB",0,1,"/TYPE:RAW",0,2,"/TYPE:WAV",0,3,"/TYPE:MOD",0,4,0
pcm_prefixes: DB "/RATE:",0,"/BITS:",0,"/CH:",0,"/FMT:",0
pcm_formats: DB "U8",0,1,"S8",0,2,"S16LE",0,3,0
pcm_raw_text: DB " type=RAW",0
pcm_wav_text: DB " type=WAV",0
pcm_mod_text: DB " type=MOD4",0
pcm_format_text: DB "FORMAT",0
pcm_unsupported_text: DB "UNSUPPORTED_FORMAT_OR_FEATURE",0
    ASSERT BUF+1024 <= BACK
    ASSERT BACK+1024 <= REQ
    ASSERT REQ+128 <= PCM_DESC
    ASSERT PCM_DESC+32 <= 0x5A00
