; SPDX-License-Identifier: GPL-2.0-or-later
; Exclusive test-owned fixtures. No implicit F3/F4, no guest file dependency.
GTRESET EQU GSV+16
GTOWN EQU GSV+17
GTHANDLE EQU GSV+18
GTBYTE EQU GSV+20
GTROW EQU GSV+21
GTICK EQU GSV+22
GTPCM_HANDLE EQU GSV+23 ; ownership survives a lost PLAY_PCM acknowledgement
GTCLEAN_TICKS EQU GSV+25
GTPCM_STOP_SENT EQU GSV+26
GT_OPTION:
    ld de,gt_reset_option
    call EQUAL
    scf
    ret nz
    ld a,1
    ld (GTRESET),a
    xor a
    ret
GT_RUN:
    call BLOB_SETUP
    ld a,2
    ld bc,0
    ld e,20
    call RPC
    jp c,RPC_ERROR
    ld a,(GTRESET)
    or a
    jr nz,.busy
    ld hl,(RESP+16)
    ld a,h
    or l
    jr nz,.busy
    call S6TEST_SNAPSHOT
    jp c,RPC_ERROR
    ld a,(RESP+24)
    dec a
    cp 2
    jr c,.busy
    ld hl,(RESP+54)
    ld a,h
    or l
    jr z,.empty
.busy:
    ld a,(GTRESET)
    or a
    jp z,S6TEST_BUSY
    ld hl,warning_text
    call PRINT
    xor a
    ld (REQ),a
    ld hl,0x5253
    ld (REQ),hl
    ld hl,0x5547
    ld (REQ+2),hl
    xor a
    ld (REQ+4),a
    ld a,UG_OP_RESET_STORE
    ld bc,5
    ld e,8
    call RPC
    jp c,RPC_ERROR
    ; Explicit reset changes session: adopt it only for this requested action.
    ld a,0
    ld bc,0
    ld e,40
    call RPC
    jp c,RPC_ERROR
    ld hl,RESP+12
    ld de,SESSION
    ld bc,8
    ldir
.empty:
    ld a,1
    ld (GTOWN),a
    xor a
    call GS_SIMPLE
    jp c,GS_RPC_ERROR
    ld a,(CMD)
    cp 13
    jp z,GT_MOD4
    ld hl,gt_status
    call GT_BEGIN
    call UG_GS_POLL_CB
    jp c,GS_RPC_ERROR
    cp 0x7E
    jp nz,VERIFY_ERROR
    call GT_PASS
    ld hl,gt_sign
    call GT_BEGIN
; docs:gs-signed:begin
    ld a,UG_GS_GS_LOAD_FX_SIGNED ; загрузить FX с выбором формата
    ld b,1                   ; есть предварительный байт
    ld c,0                   ; формат S8: от -128 до 127
    ld e,1                   ; один байт ответа: номер GS-эффекта
    call GS_CALL
    jp c,GS_RPC_ERROR
    call GT_PENDING
    ld a,128                 ; байт 80h означает -128 в формате S8
    call GT_SD
    xor a
    call GT_SD
    ld a,127
    call GT_SD
    call GT_CLOSE
; docs:gs-signed:end
    IFDEF UG_GS_TURBO_SLOT
    ld hl,gt_fx_signed
    ld bc,3
    call GT_READBACK
    ENDIF
    ld hl,(GTHANDLE)
    ld (REQ),hl
    ld a,18
    ld bc,2
    ld e,38
    call RPC
    jp c,RPC_ERROR
    ld a,(RESP+36)
    cp 1 ; S8
    jp nz,VERIFY_ERROR
    call GT_PASS
    ld hl,gt_fine
    call GT_BEGIN
    xor a
    ld (GTBYTE),a
.fine:
    ld a,(GTBYTE)
    ld c,a
    ld b,1
    ld e,1
    ld a,0x42
    call GS_CALL
    jp c,GS_RPC_ERROR
    ld a,(GTBYTE)
    or a
    jr z,.old
    dec a
.old:
    ld hl,GSREPLY
    cp (hl)
    jp nz,VERIFY_ERROR
    ld hl,GTBYTE
    inc (hl)
    jr nz,.fine
    call GT_PASS
    ld hl,gt_post
    call GT_BEGIN
    ; Complete post arguments through the public nine-byte descriptor.
    ld a,0x49
    ld (GSDESC),a
    ld a,1
    ld (GSDESC+1),a
    ld a,3
    ld (GSDESC+2),a
    xor a
    ld (GSDESC+6),a
    ld hl,0
    ld (GTROW),hl
    ld hl,GTROW
    ld (GSDESC+4),hl
    ld a,2
    ld (GSDESC+3),a
    ld hl,GSDESC
    call UG_GS_COMMAND
    jp c,GS_RPC_ERROR
    ld a,0x48
    ld bc,0x0101
    ld e,0
    call GS_CALL ; incomplete start must be discarded by D0
    jp c,GS_RPC_ERROR
    xor a
    call GT_SD
    ld a,0xD0
    call GS_SIMPLE
    jp c,GS_RPC_ERROR
    call GS_CHECK
    call GT_PASS
    ld hl,gt_reinit
    call GT_BEGIN
    ld a,0x37
    call GS_SIMPLE
    jp c,GS_RPC_ERROR
    call GT_EMPTY
    call GT_PASS
    ld hl,gt_load_ignore
    call GT_BEGIN
    ld a,0x38
    call GS_QUERY
    jp c,GS_RPC_ERROR
    call GT_PENDING
    ld a,128
    call GT_SD
    xor a
    ld (GTBYTE),a
.ignore:
    ld a,(GTBYTE)
    cp 0xD2
    jr z,.skip
    cp 0xF3
    jr z,.skip
    cp 0xF4
    jr z,.skip
    call GS_SIMPLE
    jp c,GS_RPC_ERROR
.skip:
    ld hl,GTBYTE
    inc (hl)
    jr nz,.ignore
    call GS_INFO
    ld hl,(RESP+6)
    dec hl
    ld a,h
    or l
    jp nz,VERIFY_ERROR
    call GT_PASS
    ld hl,gt_ext
    call GT_BEGIN
    ld hl,(GTHANDLE)
    ld (REQ),hl
    ld hl,0
    ld (REQ+2),hl
    ld (REQ+4),hl
    ld (REQ+6),hl
    ld a,UG_OP_SEAL ; SEAL pending must fail STATE
    ld bc,7
    ld e,6
    call RPC
    cp UG_ERR_STATE
    jp nz,VERIFY_ERROR
    xor a
    ld (REQ),a
    ld hl,0x5253
    ld (REQ),hl
    ld hl,0x5547
    ld (REQ+2),hl
    ld a,UG_OP_RESET_STORE ; RESET_STORE must fail BUSY
    ld bc,5
    ld e,0
    call RPC
    cp UG_ERR_BUSY
    jp nz,VERIFY_ERROR
    ld a,UG_OP_MEM_TEST ; MEM_TEST must fail BUSY
    ld bc,1
    ld e,14
    call RPC
    cp UG_ERR_BUSY
    jp nz,VERIFY_ERROR
    call GT_PASS
    ld hl,gt_pause
    call GT_BEGIN
    call UG_WAIT_START
    ld a,120
    ld (UGTM.LIMIT),a
.pause:
    call UG_WAIT_NEXT
    jr nc,.pause
    cp UG_ERR_TIMEOUT
    jr z,.elapsed
    ld b,3
    call UG_SET_ERR
    jp GS_RPC_ERROR
.elapsed:
    ld a,(UGTM.ELAPSED)
    cp 121 ; >=120 real seconds despite whole-second quantization
    jp c,VERIFY_ERROR ; stopped-clock watchdog is failure
    call GS_INFO
    ld hl,(RESP+6)
    dec hl
    ld a,h
    or l
    jp nz,VERIFY_ERROR
    ld a,192
    call GT_SD
    call GT_CLOSE
    IFDEF UG_GS_TURBO_SLOT
    ld hl,gt_fx_pause
    ld bc,2
    call GT_READBACK
    ENDIF
    call GT_PASS
    call GT_FREE_LEGACY
    jp GT_MOD4
GT_MOD4:
    call S8TEST_BUILD
    ld hl,gt_signature
    ld de,S8MOD_DATA+1080
    ld bc,4
    ldir
    ; Four different first-row volumes (Cxx), four natural-order notes.
    ld hl,S8MOD_DATA+1086
    ld b,4
    ld c,8
.events:
    ld (hl),0x1C
    inc hl
    ld (hl),c
    ld a,c
    add a,8
    ld c,a
    ld de,3
    add hl,de
    djnz .events
    ld hl,S8MOD_DATA+3132
    ld de,S8MOD_DATA+2108
    ld bc,32
    ldir
; docs:gs-mod:begin
    ld a,UG_GS_GS_LOAD_MODULE ; начать загрузку MOD
    call GS_QUERY
    jp c,GS_RPC_ERROR
    call GT_PENDING
    ld a,UG_GS_GS_EXT_D1      ; исторический маркер начала данных
    call GS_SIMPLE
    jp c,GS_RPC_ERROR
    ld hl,S8MOD_DATA
    ld bc,2140               ; размер собственного MOD4 в байтах
.upload:
    push hl
    push bc
    ld a,(hl)
    call GT_SD
    pop bc
    pop hl
    inc hl
    dec bc
    ld a,b
    or c
    jr nz,.upload
    call GT_CLOSE
    IFDEF UG_GS_TURBO_SLOT
    ld hl,S8MOD_DATA
    ld bc,2140               ; размер собственного MOD4 в байтах
    call GT_READBACK
    ENDIF
    ld a,UG_GS_GS_PLAY_MODULE ; включить музыку
    ld b,1                   ; передать предварительный байт
    ld c,0                   ; 0 = текущий MOD
    ld e,1                   ; прочитать один байт ответа
    call GS_CALL
    jp c,GS_RPC_ERROR
; docs:gs-mod:end
    ld a,0xF5
    call GS_SIMPLE
    jp c,GS_RPC_ERROR
    call S6TEST_DRAIN
    ld hl,gt_channel
    call GT_BEGIN
    ld a,0x63
    call GT_FOUR
    ld hl,GSREPLY
    ld b,4
    ld c,36
.notes:
    ld a,(hl)
    and 127
    cp c
    jp nz,VERIFY_ERROR
    inc hl
    inc c
    djnz .notes
    ld a,0x64
    call GT_FOUR
    ld hl,GSREPLY
    ld b,4
    ld c,8
.volumes:
    ld a,(hl)
    and 127
    cp c
    jp nz,VERIFY_ERROR
    inc hl
    ld a,c
    add a,8
    ld c,a
    djnz .volumes
    ; A repeated query must mark all four values unchanged.
    ld a,0x64
    call GT_FOUR
    ld hl,GSREPLY
    ld b,4
.dirty:
    bit 7,(hl)
    jp z,VERIFY_ERROR
    inc hl
    djnz .dirty
    call GT_PASS
    ld hl,gt_busy
    call GT_BEGIN
    ld a,(RESP+38)
    ld (GTROW),a
    call S6TEST_DRAIN
    ld a,(RESP+39)
    ld (GTICK),a
    ld a,0x69
    call GS_SIMPLE
    jp c,GS_RPC_ERROR
    call S6TEST_DRAIN
    ld a,(GTICK)
    inc a
    ld hl,RESP+39
    cp (hl)
    jp nz,VERIFY_ERROR
    ld a,0xF6
    call GS_SIMPLE
    jp c,GS_RPC_ERROR
    call GT_PASS
    ld hl,gt_pcm_state
    call GT_BEGIN
    ; Keep a looping legacy FX while native PCM takes the foreground.
    ld a,0x38
    call GS_QUERY
    jp c,GS_RPC_ERROR
    ld a,64
    call GT_SD
    ld a,192
    call GT_SD
    call GT_CLOSE
    call GS_INFO
    ld hl,(RESP+2)
    ld (GTHANDLE),hl
    IFDEF UG_GS_TURBO_SLOT
    ld hl,gt_fx_pcm
    ld bc,2
    call GT_READBACK
    ENDIF
; docs:gs-fx-play:begin
    ld a,UG_GS_GS_LOOP_START ; начало петли
    ld b,1                   ; есть предварительный байт
    ld c,0                   ; значение предварительного байта
    ld e,0                   ; ответных байтов нет
    call GS_CALL
    jp c,GS_RPC_ERROR
    xor a
    call GT_SD
    xor a
    call GT_SD
    ld a,UG_GS_GS_LOOP_END   ; конец петли (не включается)
    ld b,1
    ld c,2                   ; младший байт: конец петли = 2
    ld e,0                   ; ответных байтов нет
    call GS_CALL
    jp c,GS_RPC_ERROR
    xor a
    call GT_SD
    xor a
    call GT_SD
    ld a,UG_GS_GS_FX_CH0     ; включить текущий FX на выходе GS0
    ld b,1                   ; есть предварительный байт
    ld c,0                   ; значение предварительного байта
    ld e,0                   ; ответных байтов нет
    call GS_CALL
    jp c,GS_RPC_ERROR
; docs:gs-fx-play:end
    ld hl,(GTHANDLE)
    ld (REQ),hl
    ld hl,0
    ld (REQ+2),hl
    ld a,8
    ld (REQ+4),a
    ld a,128
    ld (REQ+5),a
    ld hl,(GTHANDLE)
    ld (GTPCM_HANDLE),hl
    ld a,UG_OP_PLAY_PCM
    ld bc,6
    ld e,2
    call RPC
    jp c,RPC_ERROR
    ld hl,(RESP)
    ld (GTHANDLE),hl ; now the PCM instance ID
    call S6TEST_DRAIN
    ld a,(RESP+25)
    cp 1
    jp nz,VERIFY_ERROR
    ld hl,(RESP+54)
    dec hl
    ld a,h
    or l
    jp nz,VERIFY_ERROR
    ld a,1
    call .pcm_control
    call S6TEST_DRAIN
    ld a,(RESP+24)
    cp 2
    jp nz,VERIFY_ERROR
    ld hl,(RESP+54)
    dec hl
    ld a,h
    or l
    jp nz,VERIFY_ERROR
    xor a
    call .pcm_control
    call S6TEST_DRAIN
    ld hl,(RESP+54)
    dec hl
    ld a,h
    or l
    jp nz,VERIFY_ERROR
    call GS_CHECK
    call GT_PASS
    jp PASS
.pcm_control:
    ld (REQ+2),a
    ld hl,(GTHANDLE)
    ld (REQ),hl
    ld a,UG_OP_CONTROL
    ld bc,3
    ld e,0
    call RPC
    jp c,RPC_ERROR
    ret
GT_FOUR:
    ld bc,0
    ld e,4
    call GS_CALL
    jp c,GS_RPC_ERROR
    ret
    IFDEF UG_GS_TURBO_SLOT
; Compare every uploaded byte through the native read API (Turbo OFF).
; Expected bytes remain in application RAM/code; never touch DSS resident RAM.
GT_READBACK:
    push hl
    ld hl,(REASON)
    ex (sp),hl
    push hl
    push bc
    ld hl,gt_readback_text
    call GT_BEGIN
    ld hl,0
    ld (UG_OFFSET),hl
    ld (UG_OFFSET+2),hl
    pop bc
    pop hl
.block:
    push bc
    push hl
    ld a,b
    or a
    jr z,.short
    ld bc,256
.short:
    push bc
    ld hl,(GTHANDLE)
    ld de,BACK
    xor a
    call UG_READ
    jp c,GS_RPC_ERROR
    pop bc
    pop hl
    push bc
    ld de,BACK
.compare:
    ld a,(de)
    cp (hl)
    jp nz,VERIFY_ERROR
    inc hl
    inc de
    dec bc
    ld a,b
    or c
    jr nz,.compare
    pop de
    pop bc
    push hl
    ld hl,(UG_OFFSET)
    add hl,de
    ld (UG_OFFSET),hl
    ld h,b
    ld l,c
    or a
    sbc hl,de
    ld b,h
    ld c,l
    pop hl
    ld a,b
    or c
    jr nz,.block
    call GT_PASS
    pop hl
    ld (REASON),hl
    ret
gt_readback_text: DB "FULL_READBACK",0
gt_fx_signed: DB 128,0,127
gt_fx_pause: DB 128,192
gt_fx_pcm: DB 64,192
    ENDIF
GT_PENDING:
    call GS_INFO
    ld hl,(RESP+4)
    ld (GTHANDLE),hl
    ld a,h
    or l
    jp z,VERIFY_ERROR
    ret
GT_SD:
    call UG_GS_SD
    call nc,UG_GS_WD
    jp c,GS_RPC_ERROR
    ret
GT_CLOSE:
    ld a,0xD2
    call GS_QUERY
    jp c,GS_RPC_ERROR
    ld a,(GSREPLY)
    or a
    jp z,VERIFY_ERROR
    jp GS_CHECK
GT_EMPTY:
    ld a,2
    ld bc,0
    ld e,20
    call RPC
    jp c,RPC_ERROR
    ld hl,(RESP+16)
    ld a,h
    or l
    jp nz,VERIFY_ERROR
    ret
GT_FREE_LEGACY:
    ld a,0x37
    call GS_SIMPLE
    jp c,GS_RPC_ERROR
    ret
GT_CLEANUP:
    ld a,(GTOWN)
    or a
    ret z
    ld a,1
    ld (UGTM.NOESC),a
    call SESSION_CHECK
    ret c
    ; A failed/lost PLAY_PCM reply may still have started our foreground.
    ; Reconcile by session + object, never stop an unrelated play_id.
    ld a,32
    ld (GTCLEAN_TICKS),a
    xor a
    ld (GTPCM_STOP_SENT),a
.settle_pcm:
    ld a,UG_OP_SNAPSHOT
    ld bc,0
    ld e,64
    call RPC
    ret c
    ld a,(RESP+25)
    cp 1
    jr nz,.next_pcm
    ld hl,(GTPCM_HANDLE)
    ld a,h
    or l
    jr z,.next_pcm
    ld de,(RESP+28)
    or a
    sbc hl,de
    jr nz,.next_pcm
    ; CONTROL acknowledges enqueueing. A following SNAPSHOT may still show
    ; this same instance until core1 applies STOP. Submit STOP only once;
    ; a duplicate can return STATE after the first one has completed and
    ; would abort cleanup before freeing our legacy fixtures.
    ld a,(GTPCM_STOP_SENT)
    or a
    jr nz,.next_pcm
    inc a
    ld (GTPCM_STOP_SENT),a
    ld hl,(RESP+20)
    ld (REQ),hl
    xor a
    ld (REQ+2),a
    ld a,UG_OP_CONTROL
    ld bc,3
    ld e,0
    call RPC
    ret c
.next_pcm:
    ld hl,GTCLEAN_TICKS
    dec (hl)
    jr nz,.settle_pcm
    ; All legacy assets in this empty-at-entry store belong to the test.
    ld a,0xF6
    call GS_SIMPLE
    ret c
    ld a,UG_OP_LEGACY_INFO
    ld bc,0
    ld e,10
    call RPC
    ret c
    ld hl,(RESP+4)
    ld a,h
    or l
    jr z,.closed
    ld a,0xD2
    call GS_QUERY
    ret c
.closed:
    ld a,0x37
    call GS_SIMPLE
    ret
GT_BEGIN:
    ld (REASON),hl
    call SHOW
    call NL
    ret
GT_PASS:
    ld hl,gt_pass_text
    call SHOW
    call NL
    ret
gt_reset_option: DB "/RESET",0
gt_signature: DB "M.K."
gt_status: DB "STATUS_7E",0
gt_sign: DB "SIGN_ROM",0
gt_channel: DB "CHANNEL_ORDER",0
gt_pause: DB "LOAD_PAUSE_120S (waiting >=120 real seconds; ESC cancels)",0
gt_load_ignore: DB "LOAD_IGNORE",0
gt_reinit: DB "REINIT_FREES_FX",0
gt_fine: DB "FINETUNE",0
gt_busy: DB "BUSY_MANUAL",0
gt_post: DB "POST_D0_ABORT",0
gt_ext: DB "EXT_DURING_LOAD",0
gt_pcm_state: DB "LEGACY_FX_PCM_STATE",0
gt_pass_text: DB "  PASS",0
    INCLUDE "uggscli.asm"
