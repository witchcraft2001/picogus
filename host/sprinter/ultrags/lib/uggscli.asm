; SPDX-License-Identifier: GPL-2.0-or-later
; Native GS registers only. Descriptor ABI stays nine bytes.
GSV EQU 0x5920
GSFLAG EQU GSV
GSSTATE EQU GSV+1 ; 1=LOAD, 2=D2 sent, 3=READY, 4=PLAY sent (never retry)
GSDESC EQU GSV+2
GSREPLY EQU GSV+11 ; four bytes
GSINDEX EQU GSV+15
GS_INIT:
    ld hl,GSV
    ld de,GSV+1
    ld bc,31
    ld (hl),0
    ldir
    ret
GS_OPTION:
    ld de,gs_option
    call EQUAL
    scf
    ret nz
    ld a,1
    ld (GSFLAG),a
    xor a
    ret
; A command, B=has_pre, C=pre, E=reply length; no post.
GS_CALL:
    ld (GSDESC),a
    ld a,b
    ld (GSDESC+1),a
    ld a,c
    ld (GSDESC+2),a
    xor a
    ld (GSDESC+3),a
    ld a,e
    ld (GSDESC+6),a
    ld hl,GSREPLY
    ld (GSDESC+7),hl
    ld hl,GSDESC
    jp UG_GS_COMMAND
GS_SIMPLE:
    ld bc,0
    ld e,0
    jp GS_CALL
GS_QUERY:
    ld bc,0
    ld e,1
    jp GS_CALL
GS_INFO:
    ld a,22
    ld bc,0
    ld e,10
    call RPC
    jp c,RPC_ERROR
    ret
GS_RPC_ERROR:
    ld a,(UG_LAST_ERROR)
    cp UG_ERR_CANCELLED
    jp z,CANCEL_APP
    cp UG_ERR_TIMEOUT
    jr nz,.other
    ld a,8
    jp EXIT
.other:
    jp RPC_ERROR
GS_CHECK:
    ld a,0xF0
    call GS_QUERY
    jp c,GS_RPC_ERROR
    ld a,(GSREPLY)
    or a
    ret z
    ld b,3
    call UG_SET_ERR
    jp GS_RPC_ERROR
    IFDEF APP_PLAY
GS_PLAY_FILE:
    call BLOB_SETUP
    call OPEN_INPUT
    call APP_TIME_INIT
    ; Validate the file before legacy replacement. No SEAL of pending objects.
    call PCM_PREFLIGHT
    call AUDIO_SNAPSHOT
    call AUDIO_SETTLE
    call AUDIO_REPLACE_CHECK
    call GS_INFO
    ld hl,(RESP+4)
    ld a,h
    or l
    jp nz,GS_BUSY
    ld hl,(RESP)
    ld de,(RESP+2)
    ld a,h
    or l
    or d
    or e
    jr z,.load
    ld a,(AFLAGS)
    and 4
    jp z,GS_BUSY
    ld hl,gs_replace_warning
    call SHOW
.load:
    xor a
    call GS_SIMPLE
    jp c,GS_RPC_ERROR
    ld a,0x30
    call GS_QUERY
    jp c,GS_UNKNOWN
    ld a,(GSREPLY)
    or a
    jp z,GS_REFUSED
    ld a,1
    ld (GSSTATE),a
    call GS_INFO
    ld hl,(RESP+4)
    ld (HANDLE),hl
    ld a,h
    or l
    jp z,PROTOCOL
    ld a,0xD1
    call GS_SIMPLE
    jp c,GS_RPC_ERROR
    ; FAST is the established BULK bridge; SLOW uses actual SD/WD.
    xor a
    ld (DATATRANS),a
    call START_BLOCKS
.upload:
    call NEXT_BLOCK
    jr z,.close
    ld a,0x13
    call IO_BLOCK
    call FOLD_FILE
    call SESSION_CHECK
    jp c,RPC_ERROR
    ld a,(SLOW)
    or a
    jr z,.fast
    ld hl,BUF
    ld bc,(BLOCK)
.byte:
    push hl
    push bc
    ld a,(hl)
    call UG_GS_SD
    call nc,UG_GS_WD
    pop bc
    pop hl
    jp c,GS_RPC_ERROR
    inc hl
    dec bc
    ld a,b
    or c
    jr nz,.byte
    jr .advance
.fast:
    call WRITE_BLOCK
.advance:
    call ADVANCE
    jr .upload
.close:
    ld a,2
    ld (GSSTATE),a
    ld a,0xD2
    call GS_QUERY
    jp c,GS_UNKNOWN
    ld a,(GSREPLY)
    or a
    jp z,GS_REFUSED
    ld a,3
    ld (GSSTATE),a
    call GS_CHECK
    ; Card CRC is compared to host CRC only with /VERIFY.
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,18
    ld bc,2
    ld e,38
    call RPC
    jp c,RPC_ERROR
    ld hl,RESP+14
    ld de,ACTUALCRC
    ld bc,4
    ldir
    ld a,(VERIFY)
    or a
    jr z,.play
    ld hl,FILECRC
    ld de,ACTUALCRC
    ld b,4
.crc:
    ld a,(hl)
    cpl
    ld c,a
    ld a,(de)
    cp c
    jp nz,VERIFY_ERROR
    inc hl
    inc de
    djnz .crc
    ld b,0
    call SEEK
    jp c,FILE_ERROR
    call START_BLOCKS
.verify:
    call NEXT_BLOCK
    jr z,.play
    ld a,0x13
    call IO_BLOCK
    call READ_BLOCK
    call COMPARE_BLOCK
    call ADVANCE
    jr .verify
.play:
    call CLOSE_FILE
    jp c,FILE_ERROR
    ; Recheck foreground immediately before historical PLAY.
    call AUDIO_SNAPSHOT
    call AUDIO_SETTLE
    call AUDIO_REPLACE_CHECK
    call SESSION_CHECK
    jp c,AUDIO_SESSION_ERROR
    call GS_INFO
    ld hl,(RESP)
    ld de,(HANDLE)
    or a
    sbc hl,de
    jr z,.selected
    ld hl,gs_changed_text
    ld (REASON),hl
    ld a,7
    jp EXIT
.selected:
    ld a,4
    ld (GSSTATE),a
    ld a,0x31
    ld bc,0x0100 ; pre=0 selects current legacy module
    ld e,1
    call GS_CALL
    jp c,GS_UNKNOWN
    ld a,(GSREPLY)
    cp 1
    jp nz,GS_REFUSED
    call GS_CHECK
    call AUDIO_SNAPSHOT
    call AUDIO_SETTLE
    call SESSION_CHECK
    jp c,AUDIO_SESSION_ERROR
    ld hl,(ASNAP+28)
    ld de,(HANDLE)
    or a
    sbc hl,de
    jp nz,GS_UNKNOWN
    ld hl,(ASNAP+20)
    ld (AID),hl
    ld a,h
    or l
    jp z,GS_UNKNOWN
    xor a
    ld (GSSTATE),a
    ld hl,gs_play_text
    call SHOW
    ld hl,HANDLE
    ld b,2
    call HEX_BYTES
    ld hl,gs_crc_text
    call SHOW
    ld hl,ACTUALCRC
    ld b,4
    call HEX_BYTES
    call NL
    ld a,(AFLAGS)
    and 1
    jp nz,AUDIO_WAIT
    jp PASS
GS_CLEANUP:
    ld a,(GSSTATE)
    or a
    ret z
    ; Never turn an uncertain D2/PLAY into another launch or a global reset.
    cp 4
    ret z
    ld a,1
    ld (UGTM.NOESC),a
    ld a,(UGXFER.DIR)
    or a
    call nz,UG_XFER_CANCEL
    call SESSION_CHECK
    ret c
    ld a,(GSSTATE)
    dec a
    jr nz,.inspect
    ld a,2
    ld (GSSTATE),a
    ld a,0xD2
    call GS_QUERY
    ret c
.inspect:
    ld hl,(HANDLE)
    ld a,h
    or l
    ret z
    ld (REQ),hl
    ld a,17
    ld bc,2
    ld e,0
    call RPC ; FREE succeeds only for this unpinned published object
    xor a
    ld (GSSTATE),a
    ret
GS_REFUSED:
    ld a,(GSSTATE)
    cp 4
    jr nz,.error
    ; A received refusal is definite: the ready object can be freed.
    ld a,3
    ld (GSSTATE),a
.error:
    ; F0 is ack+ignore inside a failed LOAD, so read the native error latch.
    ; A zero preliminary handle can still own an open LOAD with no extent.
    call UG_WIN_OPEN
    jp c,GS_RPC_ERROR
    ld a,UG_REG_GS_ERROR
    call UG_REG_R
    push af
    call UG_ISA_CLOSE
    pop af
    ld b,3
    call UG_SET_ERR
    cp 0x10
    jr z,.reservation
    cp 0x11
    jp nz,GS_RPC_ERROR
.reservation:
    ld a,(GSSTATE)
    or a
    jr nz,.memory
    ld a,1
    ld (GSSTATE),a
.memory:
    ld a,4
    jp EXIT
GS_UNKNOWN:
    ld hl,gs_unknown_text
    ld (REASON),hl
    ld a,8
    jp EXIT
GS_BUSY:
    ld hl,gs_busy_text
    ld (REASON),hl
    ld a,7
    jp EXIT
    ENDIF
    IFDEF APP_MON
GS_MONITOR:
    ld a,(GSFLAG)
    or a
    ret z
    call GS_INFO
    ld hl,(RESP+4)
    ld a,h
    or l
    jr z,.ready
    ld hl,gs_load_text
    jp SHOW
.ready:
    ld hl,gs_monitor_text
    call SHOW
    ld a,0x60
    ld (GSINDEX),a
.next:
    ld a,(GSINDEX)
    ld e,1
    cp 0x63
    jr c,.read
    ld e,4
.read:
    push de
    call GS_CALL_NO_PRE
    pop bc
    jp c,GS_RPC_ERROR
    ld a,(GSINDEX)
    call HEX8
    ld a,'='
    call OUTCHAR
    ld hl,GSREPLY
    ld b,c
    call HEX_BYTES
    call NL
    ld hl,GSINDEX
    inc (hl)
    ld a,(hl)
    cp 0x65
    jr c,.next
    ret
GS_CALL_NO_PRE:
    ld bc,0
    jp GS_CALL
    ENDIF
gs_option: DB "/GS",0
    IFDEF APP_PLAY
gs_replace_warning: DB "WARNING GS 30 frees all legacy tracker/FX assets",13,10,0
gs_busy_text: DB "LEGACY_ASSETS_OR_LOAD_BUSY_USE_REPLACE",0
gs_unknown_text: DB "GS_D2_OR_PLAY_RESULT_UNKNOWN_NOT_RETRIED",0
gs_changed_text: DB "GS_MODULE_CHANGED_NOT_STARTED",0
gs_play_text: DB "GS PLAY repeat; MOD F00 follows 6A; handle=0x",0
gs_crc_text: DB " crc=0x",0
    ENDIF
    IFDEF APP_MON
gs_load_text: DB "GS LOAD active; 60..64 unavailable; LOAD preserved",13,10,0
gs_monitor_text: DB "GS sequential 60..64; CHANS 0,1,2,3; bit7=unchanged",13,10
    DB "63/64 clear their own dirty flags; music continues",13,10,0
    ENDIF
    IFDEF APP_PCM
    ASSERT PCM_DESC+32 <= GSV
    ENDIF
    ASSERT GSV+32 <= 0x5A00
