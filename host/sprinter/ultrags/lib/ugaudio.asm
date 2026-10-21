; SPDX-License-Identifier: GPL-2.0-or-later
; PCM/FX CLI and coherent monitor. No DSS call inside an ISA window/grant.
AV EQU 0x5A00
AFLAGS EQU AV
AFX EQU AV+1
AVOICE EQU AV+54 ; u16 preferred physical voice, FFFF=automatic
APRI EQU AV+3
AGAIN EQU AV+4
APAN EQU AV+5
AID EQU AV+6
AMASK EQU AV+8
ACHANNELS EQU AV+10
ACOUNT EQU AV+12 ; u32, zero means unlimited monitor
AHZ EQU AV+16
AINTERVAL EQU AV+18
ALAST EQU AV+20 ; last printed output_frames modulo 2^32
APROGRESS EQU AV+24
AWATCH EQU AV+28
AOLD EQU AV+30
AFXERRORS EQU AV+48 ; PSRAM error counter before the accepted FX start
AOPTS EQU AV+52 ; explicit VOICE/PRIORITY/GAIN/PAN options
AF00 EQU AV+53 ; explicit PLAY_MOD policy, zero selects default IGNORE
ACAPS EQU AV+64
ASNAP EQU 0x5B00
    IFDEF APP_PLAY
; Separate the count from the 4096-byte table so it fits exactly in page1
; below the file buffers. 0000..3FFF belongs to resident DSS, not the EXE.
AFXSTAT EQU AV+62
AFXRECORDS EQU 0x4000
AFXOLD EQU 0x5E00
    ELSE
AFXSTAT EQU 0x6000 ; u16 count + up to256 instance records
AFXRECORDS EQU AFXSTAT+2
AFXOLD EQU 0x7100 ; pre-PLAY instance IDs, max256
    ENDIF
APAGE EQU AV+56
AOLDCOUNT EQU AV+58
APAGEOP EQU AV+60
AMEM EQU 0x5C00
ASTATS EQU 0x5C20
AUDIO_INIT:
    call GS_INIT
    ld hl,AV
    ld de,AV+1
    ld bc,127
    ld (hl),0
    ldir
    ld hl,0xFFFF
    ld (AVOICE),hl
    ld a,128
    ld (APRI),a
    ld (APAN),a
    ld a,64
    ld (AGAIN),a
    ld a,5
    ld (AHZ),a
    IFDEF APP_PLAY
    call STREAM_INIT
    ENDIF
    ret
AUDIO_OPTION:
    push hl
    call GS_OPTION
    pop hl
    ret nc
    IFDEF APP_PLAY
    push hl
    ld de,audio_f00_options
    call LOOKUP
    pop hl
    jr c,.ordinary_option
    ld b,a
    ld a,(AF00)
    or a
    scf
    ret nz
    ld a,b
    ld (AF00),a
    xor a
    ret
.ordinary_option:
    push hl
    ld de,audio_options
    call LOOKUP
    pop hl
    jp c,.prefix
    ld hl,AFLAGS
    or (hl)
    ld (hl),a
    xor a
    ret
.prefix:
    ld de,audio_prefixes
    ld b,1
    ELSE
    ld de,audio_prefixes
    ld b,1
    ENDIF
.next:
    push hl
    push de
    push bc
    call PREFIX
    pop bc
    pop de
    jp nc,.number
    pop hl
.skip:
    ld a,(de)
    inc de
    or a
    jp nz,.skip
    inc b
    ld a,b
    IFDEF APP_PLAY
    cp 5
    ELSE
    cp 3
    ENDIF
    jp c,.next
    scf
    ret
.number:
    pop de
    push bc
    call NUMBER32
    pop bc
    ret c
    IFDEF APP_MON
    ld a,b
    cp 1
    jp nz,.hz
    ld hl,NUM32
    ld de,ACOUNT
    ld bc,4
    ldir
    ld a,(ACOUNT)
    ld b,a
    ld a,(ACOUNT+1)
    or b
    ld b,a
    ld a,(ACOUNT+2)
    or b
    ld b,a
    ld a,(ACOUNT+3)
    or b
    scf
    ret z
    xor a
    ret
.hz:
    ENDIF
    ld hl,(NUM32+2)
    ld de,(NUM32)
    ld a,h
    or l
    scf
    ret nz
    IFNDEF APP_MON
    ld a,b
    cp 1
    jr nz,.byte_option
    ld (AVOICE),de
    ld hl,AOPTS
    set 0,(hl)
    xor a
    ret
.byte_option:
    ENDIF
    ld a,d
    or a
    scf
    ret nz
    ld a,e
    IFDEF APP_MON
    or a
    scf
    ret z
    cp 11
    ccf
    ret c
    ld (AHZ),a
    xor a
    ret
    ELSE
    ld a,b
    ld c,1
.option_bit:
    dec a
    jr z,.mark_option
    sla c
    jr .option_bit
.mark_option:
    ld a,(AOPTS)
    or c
    ld (AOPTS),a
    ld hl,AVOICE
    ld a,b
    cp 1
    jp z,.store
    ld hl,APRI
    cp 2
    jp z,.store
    ld hl,AGAIN
    cp 3
    jp z,.gain
    ld hl,APAN
    cp 4
    scf
    ret nz
    jp .store
.gain:
    ld a,e
    cp 65
    ccf
    ret c
    jp .store
.store:
    ld (hl),e
    xor a
    ret
    ENDIF
AUDIO_PARSE:
    IFDEF APP_MON
    ld a,(ARGC)
    or a
    scf
    ret nz
    ld a,(VERIFY)
    ld b,a
    ld a,(SLOW)
    or b
    scf
    ret nz
    xor a
    ret
    ELSE
    IFDEF APP_PLAY
    ld a,(SOPTIONS)
    or a
    jr z,.stream_options_ok
    ld hl,(ARGS)
    ld de,stream_word
    call EQUAL
    jp nz,.bad
.stream_options_ok:
    ENDIF
    ld a,(BLOBTYPE)
    or a
    jp nz,.bad
    ld a,(ARGC)
    or a
    jp z,.bad
    ld hl,(ARGS)
    ld de,audio_commands
    call LOOKUP
    jp c,.file
    ld (CMD),a
    cp 11
    jr nz,.not_stream
    ld a,(AF00)
    or a
    jp nz,.bad
    ld a,(GSFLAG)
    or a
    jp nz,.bad
    jp STREAM_VALIDATE
.not_stream:
    ld a,(GSFLAG)
    or a
    jp nz,.bad
    ld a,(CMD)
    cp 5
    jp z,.fxfile
    cp 1
    jp z,.handle
    cp 6
    jp z,.fxhandle
    cp 7
    jp c,.foreground_control
    ; FXSTOP ALL or an explicit nonzero instance ID.
    ld a,(ARGC)
    cp 2
    jp nz,.bad
    ld hl,(ARGS+2)
    ld de,all_word
    push hl
    call EQUAL
    pop hl
    jp nz,.id
    ld a,(CMD)
    cp 7
    jp nz,.bad
    xor a
    ld (CMD),a ; special FXSTOP ALL uses CMD=10
    ld a,10
    ld (CMD),a
    jp .control_options
.id:
    call NUMBER
    ret c
    ld a,d
    or e
    jp z,.bad
    ld (AID),de
    jp .control_options
.foreground_control:
    ld a,(ARGC)
    cp 1
    jp z,.control_options
    cp 2
    jp nz,.bad
    ld hl,(ARGS+2)
    call NUMBER
    ret c
    ld (AID),de
.control_options:
    ld a,(AF00)
    or a
    jp nz,.bad
    ld a,(AOPTS)
    ld b,a
    ld a,(SLOW)
    or b
    ld b,a
    ld a,(MANIFEST)
    or b
    jp nz,.bad
    ld a,(AFLAGS)
    ld b,a
    ld a,(PCM_FIELDS)
    or b
    ld b,a
    ld a,(BLOBTYPE)
    or b
    jp nz,.bad
    xor a
    ret
.fxhandle:
    ld a,1
    ld (AFX),a
.handle:
    ld a,(ARGC)
    cp 2
    jp nz,.bad
    ld hl,(ARGS+2)
    call NUMBER
    ret c
    ld a,d
    or e
    jp z,.bad
    ld (HANDLE),de
    ld a,(SLOW)
    ld b,a
    ld a,(MANIFEST)
    or b
    jp nz,.bad
    ld a,(PCM_FIELDS)
    or a
    jp nz,.bad
    jp .play_options
.fxfile:
    ld a,1
    ld (AFX),a
    ld a,(ARGC)
    cp 2
    jp nz,.bad
    ld hl,(ARGS+2)
    ld (ARGS),hl
    jp .extension
.file:
    ld a,(ARGC)
    cp 1
    jp nz,.bad
.extension:
    ld hl,(ARGS)
    ld de,0
.scan:
    ld a,(hl)
    or a
    jp z,.ext
    cp '.'
    jp nz,.advance
    push hl
    pop de
.advance:
    inc hl
    jp .scan
.ext:
    ld a,d
    or e
    jp z,.bad
    ex de,hl
    inc hl
    ld de,audio_extensions
    call LOOKUP
    ret c
    ld (PCM_KIND),a
    call PCM_VALIDATE
    ret c
.play_options:
    ld a,(AF00)
    or a
    jr z,.policy_options_ok
    ld a,(CMD)
    cp 1 ; HANDLE type is checked by OBJECT_INFO before replacing anything.
    jr z,.policy_options_ok
    ld a,(PCM_KIND)
    cp 3
    jp nz,.bad
.policy_options_ok:
    ld a,(GSFLAG)
    or a
    jr z,.gs_validated
    ld a,(AF00)
    ld b,a
    ld a,(CMD)
    or b
    ld b,a
    ld a,(AOPTS)
    or b
    ld b,a
    ld a,(AFX)
    or b
    jp nz,.bad
    ld a,(PCM_KIND)
    cp 3
    jp nz,.bad
.gs_validated:
    ld a,(PCM_KIND)
    cp 3
    jr nz,.pcm_options
    ld a,(AFX)
    or a
    jp nz,.bad
    ld a,(AOPTS)
    or a
    jp nz,.bad
.pcm_options:
    ld a,(AFX)
    or a
    jp nz,.fxopts
    ld a,(AFLAGS)
    and 8
    jp nz,.bad
    ld hl,(AVOICE)
    inc hl
    ld a,h
    or l
    jp nz,.bad
    ld a,(AOPTS)
    and 3
    jp nz,.bad
    ld a,(APRI)
    cp 128
    jp nz,.bad
    xor a
    ret
.fxopts:
    ld a,(APRI)
    or a
    jp z,.bad
    cp 255
    jp z,.bad
    ld a,(AFLAGS)
    and 4
    jp nz,.bad
.good:
    xor a
    ret
.bad:
    scf
    ret
    ENDIF
AUDIO_RUN:
    ld hl,RESP
    ld de,ACAPS
    ld bc,44
    ldir
    ; Bound every page/cache destination before accepting capabilities.
    ld hl,(ACAPS+20)
    dec hl
    ld de,256
    or a
    sbc hl,de
    jp nc,PROTOCOL
    ld hl,(ACAPS+40)
    ld de,0x1014
    or a
    sbc hl,de
    jp nz,PROTOCOL
    ld hl,(ACAPS+42)
    ld de,64
    or a
    sbc hl,de
    jp nz,PROTOCOL
    ld a,(ACAPS+27)
    dec a
    jp nz,PROTOCOL
    ld a,(ACAPS)
    and 32
    jp z,AUDIO_UNSUPPORTED
    IFDEF APP_MON
    jp AUDIO_MONITOR
    ELSE
    ld a,(CMD)
    cp 11
    jp z,STREAM_RUN
    cp 2
    jp c,.launch
    cp 5
    jp c,.control
    cp 7
    jp nc,.control
.launch:
    ld a,(AFX)
    or a
    jp z,.precheck
    ld a,(ACAPS+1)
    and 1
    jp z,AUDIO_UNSUPPORTED
.precheck:
    ld a,(GSFLAG)
    or a
    jp nz,GS_PLAY_FILE
    ld a,(CMD)
    cp 1
    jp z,.object
    cp 6
    jp z,.object
    ld a,(PCM_KIND)
    cp 3
    call z,AUDIO_MOD_POLICY_CAPS
    call AUDIO_SNAPSHOT
    call AUDIO_SETTLE
    call AUDIO_REPLACE_CHECK
    ld a,(CMD)
    cp 1
    jp z,.object
    cp 6
    jp z,.object
    call UPLOAD_FILE
.object:
    call SESSION_CHECK
    jp c,AUDIO_SESSION_ERROR
    ld hl,(HANDLE)
    ld (REQ),hl
    ld a,18
    ld bc,2
    ld e,38
    call RPC
    jp c,RPC_ERROR
    ld a,(RESP+3)
    cp 1
    jp nz,PCM_FORMAT_ERROR
    ld a,(RESP+2)
    cp 3
    jr z,.mod_caps
    ld a,(AF00)
    or a
    jp nz,SYNTAX
    ld a,(RESP+2)
    dec a
    cp 2
    jp nc,PCM_FORMAT_ERROR
    ld b,4
    ld a,(RESP+2)
    cp 2
    jp z,.object_caps
    ld b,1
    ld a,(RESP+35)
    cp 8
    jp z,.object_caps
    ld b,2
.object_caps:
    ld a,(ACAPS+4)
    and b
    jp z,AUDIO_UNSUPPORTED
    ld a,(RESP+34)
    ld (ACHANNELS),a
    jr .caps_done
.mod_caps:
    call AUDIO_MOD_POLICY_CAPS
    ld a,(AFX)
    or a
    jp nz,AUDIO_UNSUPPORTED
    ld a,(AOPTS)
    or a
    jp nz,AUDIO_UNSUPPORTED
    ld a,(RESP+37)
    ld (ACHANNELS),a
    ld b,8
    cp 4
    jr z,.mod_format
    ld b,16
    cp 8
    jp nz,PCM_FORMAT_ERROR
.mod_format:
    ld a,(ACAPS+4)
    and b
    jp z,AUDIO_UNSUPPORTED
.caps_done:
    ld a,(AFX)
    or a
    jp z,.ready
    call AUDIO_PREFERRED_VOICE
.ready:
    ; FX_STATUS removes ended/faulted instances alike. Remember the sticky
    ; PSRAM counter before PLAY so WAIT cannot report a render fault as EOF.
    ld a,(AFX)
    or a
    jr z,.baseline_done
    ld a,(AFLAGS)
    and 1
    jr z,.baseline_done
    ld a,3
    ld bc,0
    ld e,64
    call RPC
    jp c,RPC_ERROR
    ld hl,RESP+40
    ld de,AFXERRORS
    ld bc,4
    ldir
.baseline_done:
    ; Recheck immediately before replacing, including a paused foreground.
    call AUDIO_SNAPSHOT
    call AUDIO_SETTLE
    call AUDIO_REPLACE_CHECK
    ld hl,(ASNAP+20)
    ld (AOLD),hl
    ld a,(AFX)
    or a
    jp z,.old_saved
    call AUDIO_FX_STATUS
    ld hl,(AFXSTAT)
    ld (AOLDCOUNT),hl
    ld a,h
    or l
    jr z,.old_saved
    ld b,l ; 256 records use DJNZ with B=0
    ld ix,AFXRECORDS
    ld hl,AFXOLD
.old_fx:
    ld a,(ix+0)
    ld (hl),a
    inc hl
    ld a,(ix+1)
    ld (hl),a
    inc hl
    ld de,16
    add ix,de
    djnz .old_fx
.old_saved:
    ld hl,(HANDLE)
    ld (REQ),hl
    ; AUDIO_REPLACE_CHECK and FX_STATUS use RESP, so the object-info kind
    ; is no longer live here. Preserve the validated MOD sentinel in the
    ; normalized channel count instead.
    ld a,(ACHANNELS)
    cp 8
    jr z,.play_mod
    cp 4
    jr z,.play_mod
    ld a,(AFX)
    or a
    jp nz,.fx
    ld hl,1
    ld a,(AFLAGS)
    and 2
    jp z,.repeats
    dec hl
.repeats:
    ld (REQ+2),hl
    ld a,(AGAIN)
    ld (REQ+4),a
    ld a,(APAN)
    ld (REQ+5),a
    ld a,48
    ld bc,6
    ld e,2
    call RPC
    jp .ack
.fx:
    ld hl,(AVOICE)
    ld (REQ+2),hl
    ld a,(APRI)
    ld (REQ+4),a
    ld a,(AGAIN)
    ld (REQ+5),a
    ld a,(APAN)
    ld (REQ+6),a
    ld a,(AFLAGS)
    and 2
    ld b,a
    ld a,(AFLAGS)
    and 8
    rrca
    rrca
    rrca
    or b
    ld (REQ+7),a
    ld a,54
    ld bc,8
    ld e,4
    call RPC
    jr .ack
.play_mod:
    ld a,(AFLAGS)
    and 2
    rrca
    ld b,a
    ld a,(AF00)
    or a
    jr nz,.policy_selected
    ld a,UG_MOD_IGNORE_F00
.policy_selected:
    or b
    ld (REQ+2),a
    ld a,49
    ld bc,3
    ld e,2
    call RPC
.ack:
    jp c,AUDIO_PLAY_ERROR
    ld hl,(RESP)
    ld a,h
    or l
    jp z,PROTOCOL
    ld (AID),hl
    ld hl,(RESP+2)
    ld (AMASK),hl
    ld hl,handle_text
    call SHOW
    ld hl,HANDLE
    ld b,2
    call HEX_BYTES
    ld hl,audio_play_text
    ld a,(AFX)
    or a
    jp z,.idtext
    ld hl,audio_fx_text
.idtext:
    call SHOW
    ld hl,AID
    ld b,2
    call HEX_BYTES
    ld a,(AFX)
    or a
    jp z,.printed
    ld hl,audio_mask_text
    call SHOW
    ld hl,AMASK
    ld b,2
    call HEX_BYTES
.printed:
    call NL
    ld a,(ACHANNELS)
    cp 4
    jr c,.policy_printed
    ld hl,audio_f00_ignore_text
    ld a,(AF00)
    cp UG_MOD_PAUSE_F00
    jr nz,.policy_text
    ld hl,audio_f00_pause_text
.policy_text:
    call SHOW
    call NL
.policy_printed:
    ld a,(AFLAGS)
    and 1
    jp z,PASS
    jp AUDIO_WAIT
.control:
    ld a,(CMD)
    cp 10
    jp z,.all
    cp 7
    jp nc,.fxcontrol
    sub 2
    ld (REQ+2),a
    ld hl,(AID)
    ld (REQ),hl
    ld a,50
    jp .controlrpc
.fxcontrol:
    sub 7
    ld (REQ+2),a
    ld hl,(AID)
    ld (REQ),hl
    ld a,57
.controlrpc:
    ld bc,3
    ld e,0
    call RPC
    jp c,AUDIO_PLAY_ERROR
    jp PASS
.all:
    ld hl,0
    ld (REQ),hl
    ld a,55
    ld bc,2
    ld e,0
    call RPC
    jp c,AUDIO_PLAY_ERROR
    jp PASS
    ENDIF
AUDIO_SNAPSHOT:
    ld a,80
    ld bc,0
    ld e,64
    call RPC
    jp c,RPC_ERROR
    ld hl,RESP
    ld de,ASNAP
    ld bc,64
    ldir
    ld hl,ASNAP+4
    ld de,SESSION
    ld b,8
.session:
    ld a,(de)
    cp (hl)
    jp nz,AUDIO_SESSION_ERROR
    inc hl
    inc de
    djnz .session
    ret
AUDIO_FX_STATUS:
    xor a
    ld (APAGE),a
    ld (APAGE+1),a
.page:
    ld a,81
    call AUDIO_PAGE
    ld hl,(RESP+16)
    ld (AFXSTAT),hl
    ld hl,(APAGE)
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl
    ld de,AFXRECORDS
    add hl,de
    ex de,hl
    ld hl,(RESP+14)
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl
    ld b,h
    ld c,l
    ld hl,RESP+20
    ld a,b
    or c
    jr z,.copied
    ldir
.copied:
    ld hl,(APAGE)
    ld de,(RESP+14)
    add hl,de
    ld (APAGE),hl
    ld de,(RESP+16)
    or a
    sbc hl,de
    jr c,.page
    ret
; A=page opcode. Session/sequence come from the held summary. Validate the
; complete header and exact payload length before copying any record.
AUDIO_PAGE:
    ld (APAGEOP),a
    ld hl,ASNAP+4
    ld de,REQ
    ld bc,8
    ldir
    ld hl,ASNAP
    ld bc,4
    ldir
    ld hl,(APAGE)
    ld (REQ+12),hl
    ld hl,6
    ld (REQ+14),hl
    ld hl,REQ
    ld de,RESP
    ld ix,128
    ld bc,16
    ld a,(APAGEOP)
    call UG_RPC
    jp c,RPC_ERROR
    ld a,b
    or a
    jp nz,PROTOCOL
    ld a,c
    cp 20
    jp c,PROTOCOL
    ld (AV+61),a
    ld hl,REQ
    ld de,RESP
    ld b,14
.header:
    ld a,(de)
    cp (hl)
    jp nz,PROTOCOL
    inc hl
    inc de
    djnz .header
    ld hl,(RESP+16)
    ld de,(ACAPS+20)
    or a
    sbc hl,de
    jp nc,.limit_equal
    jr .limit_ok
.limit_equal:
    jp nz,PROTOCOL
.limit_ok:
    ; The held summary fixes the FX total; the voice table always contains
    ; the complete CAPS capacity, including idle voices.
    ld a,(APAGEOP)
    cp 81
    ld hl,(ASNAP+54)
    jr z,.expected_total
    ld hl,(ACAPS+20)
.expected_total:
    ld de,(RESP+16)
    or a
    sbc hl,de
    jp nz,PROTOCOL
    ld hl,(RESP+14)
    ld a,h
    or a
    jp nz,PROTOCOL
    ld a,l
    cp 7
    jp nc,PROTOCOL
    ld b,a
    ld hl,(RESP+18)
    ld de,16
    ld a,(APAGEOP)
    cp 81
    jr z,.size
    ld de,20
    ld a,b
    cp 6
    jp nc,PROTOCOL
.size:
    or a
    sbc hl,de
    jp nz,PROTOCOL
    ld hl,20
    ld a,b
    or a
    jr z,.length
.record:
    add hl,de
    djnz .record
.length:
    ld a,(AV+61)
    cp l
    jp nz,PROTOCOL
    ld hl,(APAGE)
    ld de,(RESP+14)
    add hl,de
    jp c,PROTOCOL
    ld de,(RESP+16)
    or a
    sbc hl,de
    jp nc,.end
    ld hl,(RESP+14)
    ld a,h
    or l
    jp z,PROTOCOL
    ret
.end:
    jp nz,PROTOCOL
    ret
    IFDEF APP_PLAY
AUDIO_SETTLE:
    ; Previously accepted commands/snapshots may lag a quantum, up to 10 ms.
    ; Observe that interval before deciding that foreground is idle.
    ld a,(AFX)
    or a
    ret nz
    call AUDIO_WATCH_INIT
    ld hl,ASNAP+12
    ld de,ALAST
    ld bc,4
    ldir
.loop:
    call AUDIO_SNAPSHOT
    call AUDIO_WATCH
    ld hl,(ASNAP+12)
    ld de,(ALAST)
    or a
    sbc hl,de
    ld de,480
    or a
    sbc hl,de
    jr c,.loop
    ret
AUDIO_REPLACE_CHECK:
    ld a,(AFX)
    or a
    ret nz
    ld a,(ASNAP+24)
    dec a
    cp 2
    ret nc
    ld a,(AFLAGS)
    and 4
    ret nz
    ld hl,audio_replace_text
    ld (REASON),hl
    ld a,7
    jp EXIT
AUDIO_PREFERRED_VOICE:
    ld hl,(AVOICE)
    inc hl
    ld a,h
    or l
    ret z
    dec hl
    ld de,(ACAPS+20)
    or a
    sbc hl,de
    ret c
    jp AUDIO_UNSUPPORTED
AUDIO_PLAY_ERROR:
    ld a,(UG_LAST_SOURCE)
    cp 1
    jp nz,RPC_ERROR_RELOAD
    ld a,(UG_LAST_ERROR)
    ld (SAVEDERR),a
    ld a,1
    ld (UGTM.NOESC),a
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    call SESSION_CHECK
    jp c,.unknown
    ; Inspection only: no automatic PLAY/ALLOC repeat or speculative STOP.
    call AUDIO_SNAPSHOT
    call AUDIO_FX_STATUS
    IFDEF APP_MON
    call GS_MONITOR
    ENDIF
    call AUDIO_SHOW_SNAPSHOT
    ; Only a new token for this READY handle can reconcile a lost PLAY ACK.
    ld a,(CMD)
    cp 2
    jp c,.reconcile
    cp 5
    jp c,.unknown
    cp 7
    jp nc,.unknown
.reconcile:
    ld a,(AFX)
    or a
    jp nz,.find_fx
    ld hl,(ASNAP+28)
    ld de,(HANDLE)
    or a
    sbc hl,de
    jp nz,.unknown
    ld hl,(ASNAP+20)
    ld de,(AOLD)
    or a
    sbc hl,de
    jp z,.unknown
    ld hl,(ASNAP+20)
    ld a,h
    or l
    jp z,.unknown
    ld (RESP),hl
    xor a
    jp AUDIO_RUN.ack
.find_fx:
    ld hl,(AFXSTAT)
    ld a,h
    or l
    jp z,.unknown
    ld b,l
    ld ix,AFXRECORDS
.record:
    ld l,(ix+4)
    ld h,(ix+5)
    ld de,(HANDLE)
    or a
    sbc hl,de
    jp nz,.next_record
    ld e,(ix+0)
    ld d,(ix+1)
    ld a,d
    or e
    jp z,.next_record
    push bc
    ld hl,(AOLDCOUNT)
    ld a,h
    or l
    jr z,.fresh
    ld b,l
    ld hl,AFXOLD
.old_id:
    ld a,(hl)
    inc hl
    cp e
    jp nz,.old_high
    ld a,(hl)
    cp d
    jp z,.seen
.old_high:
    inc hl
    djnz .old_id
.fresh:
    pop bc
    ld (RESP),de
    ld l,(ix+2)
    ld h,(ix+3)
    ld (RESP+2),hl
    xor a
    jp AUDIO_RUN.ack
.seen:
    pop bc
.next_record:
    ld de,16
    add ix,de
    djnz .record
.unknown:
    ld hl,audio_unknown_text
    ld (REASON),hl
    ld a,8
    jp EXIT
RPC_ERROR_RELOAD:
    ld a,(UG_LAST_ERROR)
    jp RPC_ERROR
AUDIO_WAIT:
    ; Refresh the clock baseline AFTER the PLAY ACK. The pre-PLAY snapshot
    ; can already be older than one quantum by the time its payload is read.
    ; Library polls must not consume ESC before our instance-specific STOP.
    ld a,1
    ld (UGTM.NOESC),a
    call AUDIO_SNAPSHOT
    call AUDIO_WATCH_INIT
    xor a
    ld (AV+40),a ; have we observed our accepted instance yet?
    ld hl,ASNAP+12
    ld de,AV+42
    ld bc,4
    ldir
.loop:
    call AUDIO_KEY
    jp z,.esc
    call AUDIO_SNAPSHOT
    ld a,(AFX)
    or a
    jp nz,.fx
    ld hl,(ASNAP+20)
    ld de,(AID)
    or a
    sbc hl,de
    jp nz,.missing
    ld a,1
    ld (AV+40),a
    ld a,(ASNAP+24)
    cp 4
    jp z,AUDIO_ERROR
    dec a
    cp 2
    jp nc,PASS
    jp .watch
.fx:
    call AUDIO_FX_STATUS
    ld hl,(AFXSTAT)
    ld a,h
    or l
    jp z,.missing
    ld b,l
    ld ix,AFXRECORDS
.find:
    ld l,(ix+0)
    ld h,(ix+1)
    ld de,(AID)
    or a
    sbc hl,de
    jp z,.observed
    ld de,16
    add ix,de
    djnz .find
.missing:
    ld a,(AV+40)
    or a
    jp nz,AUDIO_WAIT_DONE
    ld hl,(ASNAP+12)
    ld de,(AV+42)
    or a
    sbc hl,de
    ld de,480
    or a
    sbc hl,de
    jp nc,AUDIO_WAIT_DONE
    jp .watch
.observed:
    ld a,1
    ld (AV+40),a
.watch:
    call AUDIO_WATCH
    jp .loop
.esc:
    ld hl,(AID)
    ld (REQ),hl
    xor a
    ld (REQ+2),a
    ld a,(AFX)
    or a
    ld a,50
    jp z,.stop
    ld a,57
.stop:
    ld bc,3
    ld e,0
    call RPC
    jp nc,.cancel
    ; It may have reached EOF or been replaced between poll and ESC.
    ld a,(UG_LAST_SOURCE)
    cp 2
    jp nz,RPC_ERROR_RELOAD
    ld a,(UG_LAST_ERROR)
    cp 7
    jp z,.cancel
    cp 6
    jp nz,RPC_ERROR
.cancel:
    jp CANCEL_APP
AUDIO_WAIT_DONE:
    ld a,(AFX)
    or a
    jp z,PASS
    ld a,3
    ld bc,0
    ld e,64
    call RPC
    jp c,RPC_ERROR
    ld hl,RESP+40
    ld de,AFXERRORS
    ld b,4
.errors:
    ld a,(de)
    cp (hl)
    jp nz,AUDIO_ERROR
    inc hl
    inc de
    djnz .errors
    jp PASS
    ENDIF
AUDIO_KEY:
    push ix
    push iy
    ld c,0x31
    rst 0x10
    pop iy
    pop ix
    cp 27
    ret
AUDIO_WATCH_INIT:
    call APP_TIME_INIT
    ld hl,ASNAP+12
    ld de,APROGRESS
    ld bc,4
    ldir
    ld hl,0
    ld (AWATCH),hl
    ret
AUDIO_WATCH:
    ld hl,(ASNAP+12)
    ld de,(APROGRESS)
    or a
    sbc hl,de
    jp nz,.progress
    ld hl,(ASNAP+14)
    ld de,(APROGRESS+2)
    or a
    sbc hl,de
    jp nz,.progress
    call APP_TIME_NEXT
    ld hl,(TIMEELAPSED)
    ld de,3
    or a
    sbc hl,de
    jp nc,AUDIO_TIMEOUT
    ld hl,(AWATCH)
    inc hl
    ld (AWATCH),hl
    ld a,h
    cp 4
    jp nc,AUDIO_TIMEOUT
    ret
.progress:
    jp AUDIO_WATCH_INIT
AUDIO_SHOW_SNAPSHOT:
    ld hl,audio_mode_text
    call SHOW
    ld hl,audio_kind_text
    call SHOW
    ld a,(ASNAP+25)
    ld l,a
    ld h,0
    call DEC16
    ld hl,audio_channels_text
    call SHOW
    ld hl,(ASNAP+26)
    call DEC16
    ld hl,audio_state_text
    call SHOW
    ld a,(ASNAP+24)
    ld l,a
    ld h,0
    call DEC16
    ld hl,audio_play_text
    call SHOW
    ld hl,ASNAP+20
    ld b,2
    call HEX_BYTES
    ld hl,handle_text
    call SHOW
    ld hl,ASNAP+28
    ld b,2
    call HEX_BYTES
    ld hl,audio_position_text
    call SHOW
    ld hl,ASNAP+32
    call DEC32
    ld hl,audio_frames_text
    call SHOW
    ld hl,ASNAP+12
    ld b,8
    call HEX_BYTES
    ld hl,audio_peak_text
    call SHOW
    ld hl,(ASNAP+42)
    call DEC16
    ld a,','
    call OUTCHAR
    ld hl,(ASNAP+44)
    call DEC16
    ld hl,audio_underrun_text
    call SHOW
    ld hl,ASNAP+46
    call DEC32
    ld hl,audio_error_text
    call SHOW
    ld a,(ASNAP+50)
    ld l,a
    ld h,0
    call DEC16
    ld hl,audio_transfer_text
    call SHOW
    ld hl,ASNAP+56
    ld b,4
    call HEX_BYTES
    ld hl,audio_transfer_progress_text
    call SHOW
    ld hl,(ASNAP+60)
    call DEC16
    ld a,'/'
    call OUTCHAR
    ld hl,(ASNAP+62)
    call DEC16
    jp NL
    IFDEF APP_MON
AUDIO_MONITOR:
    ld a,1
    ld (UGTM.NOESC),a
    ; floor(48000 / Hz), interval is measured by card output frames.
    ld hl,48000
    ld de,0
    ld a,(AHZ)
    ld c,a
    ld b,0
.divide:
    or a
    sbc hl,bc
    jp c,.divided
    inc de
    jp .divide
.divided:
    ld (AINTERVAL),de
    call AUDIO_SNAPSHOT
    call AUDIO_WATCH_INIT
.print:
    IFDEF APP_MON
    call GS_MONITOR
    ENDIF
    call AUDIO_SHOW_SNAPSHOT
    ld hl,audio_mod_text
    call SHOW
    ld hl,(ASNAP+36)
    call DEC16
    ld ix,ASNAP+38
    ld b,4
.mod:
    ld a,','
    call OUTCHAR
    ld l,(ix+0)
    ld h,0
    push bc
    call DEC16
    pop bc
    inc ix
    djnz .mod
    call NL
    ld hl,0
    ld (APAGE),hl
.voice_page:
    ld a,82
    call AUDIO_PAGE
    ld hl,(RESP+14)
    ld b,l
    ld a,b
    or a
    jr z,.voices_done
    ld ix,RESP+20
.channel:
    push bc
    ld hl,audio_voice_text
    call SHOW
    ld l,(ix+0)
    ld h,(ix+1)
    call DEC16
    ld hl,audio_note_text
    call SHOW
    ld l,(ix+16)
    ld h,0
    call DEC16
    ld hl,audio_volume_text
    call SHOW
    ld l,(ix+17)
    ld h,0
    call DEC16
    ld hl,audio_peak_text
    call SHOW
    ld l,(ix+12)
    ld h,(ix+13)
    call DEC16
    call NL
    ld de,20
    add ix,de
    pop bc
    djnz .channel
    ld hl,(APAGE)
    ld de,(RESP+14)
    add hl,de
    ld (APAGE),hl
    ld de,(RESP+16)
    or a
    sbc hl,de
    jr c,.voice_page
.voices_done:
    call AUDIO_FX_STATUS
    ld hl,(AFXSTAT)
    ld a,h
    or l
    jr z,.fx_done
    ld b,l
    ld ix,AFXRECORDS
.fx:
    push bc
    ld hl,audio_fx_text
    call SHOW
    push ix
    pop hl
    ld b,2
    call HEX_BYTES
    ld hl,handle_text
    call SHOW
    push ix
    pop hl
    ld de,4
    add hl,de
    ld b,2
    call HEX_BYTES
    ld hl,audio_mask_text
    call SHOW
    push ix
    pop hl
    inc hl
    inc hl
    ld b,2
    call HEX_BYTES
    ld hl,audio_state_text
    call SHOW
    ld l,(ix+6)
    ld h,0
    call DEC16
    ld hl,audio_channels_text
    call SHOW
    ld l,(ix+7)
    ld h,0
    call DEC16
    ld hl,audio_position_text
    call SHOW
    push ix
    pop hl
    ld de,8
    add hl,de
    ; DEC32 uses IX, so preserve the record pointer.
    push ix
    call DEC32
    pop ix
    call NL
    ld de,16
    add ix,de
    pop bc
    djnz .fx
.fx_done:
    ld a,2
    ld bc,0
    ld e,20
    call RPC
    jp c,RPC_ERROR
    ld hl,pool_text
    call SHOW
    ld hl,RESP+4
    call DEC32
    ld hl,largest_text
    call SHOW
    ld hl,RESP+12
    call DEC32
    ld hl,free_text
    call SHOW
    ld hl,RESP+8
    call DEC32
    ld hl,objects_text
    call SHOW
    ld hl,(RESP+16)
    call DEC16
    ld a,3
    ld bc,0
    ld e,64
    call RPC
    jp c,RPC_ERROR
    ld hl,audio_clip_text
    call SHOW
    ld hl,RESP+60
    call DEC32
    ld hl,audio_psram_text
    call SHOW
    ld hl,RESP+40
    call DEC32
    ld hl,audio_protocol_text
    call SHOW
    ld hl,RESP+28
    call DEC32
    call NL
    ld hl,(ACOUNT)
    ld de,(ACOUNT+2)
    ld a,h
    or l
    or d
    or e
    jp z,.time
    ld bc,1
    or a
    sbc hl,bc
    ld (ACOUNT),hl
    ex de,hl
    ld bc,0
    sbc hl,bc
    ld (ACOUNT+2),hl
    or a
    ld a,h
    or l
    ld hl,(ACOUNT)
    or h
    or l
    jp z,PASS
.time:
    ld hl,ASNAP+12
    ld de,ALAST
    ld bc,4
    ldir
.poll:
    call AUDIO_KEY
    jp z,PASS
    call AUDIO_SNAPSHOT
    call AUDIO_WATCH
    ld hl,(ASNAP+12)
    ld de,(ALAST)
    or a
    sbc hl,de
    push hl
    ld hl,(ASNAP+14)
    ld de,(ALAST+2)
    sbc hl,de
    pop de
    ld a,h
    or l
    jp nz,.print
    ex de,hl
    ld de,(AINTERVAL)
    or a
    sbc hl,de
    jp nc,.print
    jp .poll
    ENDIF
AUDIO_CLEANUP:
    IFDEF APP_PLAY
    call GS_CLEANUP
    call STREAM_CLEANUP
    ENDIF
    ret ; handles persist; WAIT/ESC stops only its own instance above
AUDIO_SESSION_ERROR:
    xor a
    ld (OWN),a
    ld hl,audio_session_text
    ld (REASON),hl
    jp PROTOCOL
AUDIO_UNSUPPORTED:
    ld hl,audio_unsupported_text
    ld (REASON),hl
    jp PROTOCOL
    IFDEF APP_PLAY
AUDIO_MOD_POLICY_CAPS:
    ld a,(ACAPS+1)
    and UG_MOD_F00_POLICY_FEATURE/256
    ret nz
    ld hl,audio_f00_firmware_text
    ld (REASON),hl
    jp PROTOCOL
    ENDIF
AUDIO_TIMEOUT:
    ld hl,audio_timeout_text
    ld (REASON),hl
    ld a,8
    jp EXIT
AUDIO_ERROR:
    ld hl,audio_error_reason
    ld (REASON),hl
    ld a,7
    jp EXIT
    IFDEF APP_PLAY
stream_word: DB "STREAM",0
    INCLUDE "ugstream.asm"
audio_commands: DB "STREAM",0,11,"HANDLE",0,1,"STOP",0,2,"PAUSE",0,3,"RESUME",0,4,"FX",0,5,"FXHANDLE",0,6,"FXSTOP",0,7,"FXPAUSE",0,8,"FXRESUME",0,9,0
audio_extensions: DB "RAW",0,1,"WAV",0,2,"MOD",0,3,0
audio_options: DB "/WAIT",0,1,"/LOOP",0,2,"/REPLACE",0,4,"/STEAL",0,8,0
audio_f00_options: DB "/F00:IGNORE",0,UG_MOD_IGNORE_F00,"/F00:PAUSE",0,UG_MOD_PAUSE_F00,0
audio_f00_ignore_text: DB "MOD F00=IGNORE",0
audio_f00_pause_text: DB "MOD F00=PAUSE",0
audio_f00_firmware_text: DB "MOD_F00_POLICY_REQUIRES_NEW_FIRMWARE",0
audio_prefixes: DB "/VOICE:",0,"/PRIORITY:",0,"/GAIN:",0,"/PAN:",0
all_word: DB "ALL",0
    ELSE
audio_prefixes: DB "/COUNT:",0,"/HZ:",0
    ENDIF
audio_play_text: DB " play_id=0x",0
audio_fx_text: DB " fx_id=0x",0
audio_mask_text: DB " voices=0x",0
audio_state_text: DB "state=",0
audio_position_text: DB " source_frame=",0
audio_frames_text: DB " output_frames=0x",0
audio_peak_text: DB " peaks=",0
audio_underrun_text: DB " underruns=",0
audio_error_text: DB " audio_error=",0
audio_transfer_text: DB " transfer=0x",0
audio_clip_text: DB " clips=",0
audio_channels_text: DB " channels=",0
audio_replace_text: DB "FOREGROUND_BUSY_USE_REPLACE",0
audio_unknown_text: DB "PLAY_RESULT_UNKNOWN_NOT_RETRIED",0
audio_unsupported_text: DB "UNSUPPORTED_S6_FEATURE",0
audio_session_text: DB "SESSION_CHANGED",0
audio_timeout_text: DB "OUTPUT_CLOCK_STOPPED",0
audio_error_reason: DB "AUDIO_PLAYBACK_ERROR",0
    ASSERT AV+108 <= ASNAP
    ASSERT ASNAP+64 <= AMEM
    ASSERT AFXRECORDS+256*16 <= AFXOLD
    ASSERT AFXOLD+512 < 0x8000
    IFDEF APP_PLAY
    ASSERT AFXRECORDS >= 0x4000
    ASSERT AFXRECORDS+256*16 <= BUF
    ASSERT AFXSTAT+2 <= ACAPS
    ASSERT SV+144 <= AFXOLD
    ASSERT AFXOLD+512 <= HEADER
    ENDIF
    ASSERT ASTATS+64 < 0x8000

audio_mode_text: DB "mode=8 ",0
audio_kind_text: DB "kind=",0
audio_transfer_progress_text: DB " progress=",0
audio_mod_text: DB "order,row,tick,speed,bpm=",0
audio_note_text: DB "note=",0
audio_volume_text: DB " volume=",0
audio_psram_text: DB " psram_errors=",0
audio_protocol_text: DB " protocol_errors=",0

audio_voice_text: DB "voice=",0

    INCLUDE "uggscli.asm"
