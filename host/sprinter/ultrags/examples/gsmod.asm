; SPDX-License-Identifier: GPL-2.0-or-later
; MOD через команды General Sound: загрузить файл побайтно (30h ... D2h),
; включить (31h), приостановить (32h), продолжить (33h), освободить (37h).
; Перед работой программа сбрасывает карту: чужие объекты и звук не сохраняются.
    IFNDEF DOC_SLOT
    DEFINE DOC_SLOT 0
    ENDIF
    DEFINE UG_NO_DSS          ; библиотека UltraGS не вызывает DSS
CARD_IO_BASE EQU 0x02A0
    ORG 0x8000
header:
    DB "EXE",1
    DW 128,0,0,0,0,0,start,start,0xB800
    DS 128-($-header),0
start:
    ld (saved_sp),sp
    xor a
    ld (loading),a
    ld (loaded),a
    call open_card
    jr c,finish
    call play_lesson
finish:
    ld (result),a
    call cleanup
    jr nc,.closed
    ld (result),a
.closed:
    call UG_CLOSE
    ld a,(result)
    or a
    ld hl,ok_text
    jr z,.print
    ld hl,error_text
.print:
    ld c,0x5C
    rst 0x10
    ld sp,(saved_sp)
    ld a,(result)
    ld b,a
    ld c,0x41
    rst 0x10

open_card:
    call UG_LIB_INIT
    ld a,DOC_SLOT
    ld hl,CARD_IO_BASE
    call UG_OPEN
    ret c
    ld a,1
    call UG_FRAME_CRC
    ld a,UG_OP_INFO
    ld bc,0
    ld ix,UG_OP_INFO_RESP_LEN
    call rpc
    ret c
    ld hl,response
    ld de,signature
    ld b,8
    call compare
    ret c
    ld a,UG_OP_CAPS
    ld bc,0
    ld ix,UG_OP_CAPS_RESP_LEN
    call rpc
    ret c
    ld a,(response)
    bit 0,a                  ; features бит 0: музыкальные команды GS
    jr z,.unsupported
    jp reset_card            ; начать с чистой карты (глава 3)
.unsupported:
    ld a,UG_ERR_STATE
    scf
    ret

; Сброс карты, как в главе 2: отменить чужую передачу и RESET_STORE уровня 0.
; Программе, работающей только командами GS, то же даёт команда F3h.
reset_card:
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    ret c
    ld a,UG_OP_RESET_STORE
    ld hl,reset_request
    ld bc,UG_RESET_STORE_REQ_LEN
    ld ix,UG_OP_RESET_STORE_RESP_LEN
    call rpc
    ret c
    xor a
    ret
reset_request:
    DD UG_RESET_STORE_KEY
    DB 0

; docs:gs-sequence:begin
play_lesson:
    call gs_load             ; 30h, байты файла, D2h
    ret c
    call gs_play             ; 31h: модуль 1 с начала
    ret c
    ld a,1
    call wait_seconds
    ret c
    ld a,UG_GS_GS_PAUSE_MODULE ; 32h: пауза с сохранением позиции
    ld b,0
    ld e,0
    call gs_command
    ret c
    ld a,1
    call wait_seconds        ; секунда тишины
    ret c
    ld a,UG_GS_GS_RESUME_MODULE ; 33h: продолжить с того же места
    ld b,0
    ld e,0
    call gs_command
    ret c
    ld a,1
    jp wait_seconds
; docs:gs-sequence:end

; docs:gs-command:begin
; A = команда GS, B = 1 если есть предварительный байт, C = этот байт,
; E = сколько байт ответа прочитать в gs_reply. Библиотека выполняет
; весь обмен флагами CB/DB и закрывает окно ISA после каждого шага.
gs_command:
    ld (gs_desc),a           ; команда
    ld a,b
    ld (gs_desc+1),a         ; есть ли предварительный байт
    ld a,c
    ld (gs_desc+2),a         ; сам предварительный байт
    ld a,e
    ld (gs_desc+6),a         ; сколько байт ответа прочитать
    ld hl,gs_desc
    jp UG_GS_COMMAND

gs_desc:
    DB 0                     ; код команды GS
    DB 0                     ; has_pre: 0 или 1
    DB 0                     ; pre: байт, который уходит до команды
    DB 0                     ; post_count: байтов после команды нет
    DW 0                     ; адрес байтов после команды
    DB 0                     ; число байтов ответа
    DW gs_reply              ; куда положить ответ
; docs:gs-command:end

; docs:gs-load:begin
gs_load:
    ld a,UG_GS_GS_LOAD_MODULE ; 30h: начать загрузку модуля
    ld b,0
    ld e,1                   ; ответ: номер модуля GS (1)
    call gs_command
    ret c
    ld a,1
    ld (loading),a           ; с этого момента карта ждёт байты файла
    ld hl,music_data
    ld bc,MUSIC_BYTES
.byte:
    ld a,(hl)
    push hl
    push bc
    call UG_GS_SD            ; записать байт в DATA
    jr c,.failed
    call UG_GS_WD            ; дождаться, пока карта его заберёт
.failed:
    pop bc
    pop hl
    ret c
    inc hl
    dec bc
    ld a,b
    or c
    jr nz,.byte
gs_close:
    ld a,UG_GS_GS_LOAD_CLOSE ; D2h: файл передан целиком
    ld b,0
    ld e,1                   ; ответ: номер модуля, 0 при ошибке
    call gs_command
    ret c
    xor a
    ld (loading),a
    ld a,(gs_reply)
    or a
    jr z,.rejected
    ld (loaded),a
    xor a
    ret
.rejected:
    ld a,UG_ERR_FORMAT       ; карта не приняла файл как MOD
    scf
    ret

gs_play:
    ld a,UG_GS_GS_PLAY_MODULE ; 31h
    ld b,1
    ld c,1                   ; предварительный байт: модуль 1
    ld e,1                   ; ответ: 1 = заиграл
    call gs_command
    ret c
    ld a,(gs_reply)
    dec a
    ret z
    ld a,UG_ERR_STATE
    scf
    ret
; docs:gs-load:end

wait_seconds:
    ld (target),a
    ld c,0x21
    rst 0x10
    ld a,b
    ld (second),a
    xor a
    ld (elapsed),a
    ld hl,4096
    ld (budget),hl
.poll:
    ld c,0x31
    rst 0x10
    cp 27
    jr z,.cancel
    ld c,0x21
    rst 0x10
    ld a,(second)
    ld c,a
    ld a,b
    ld (second),a
    sub c
    jr nc,.delta
    add a,60
.delta:
    ld hl,elapsed
    add a,(hl)
    ld (hl),a
    ld hl,target
    cp (hl)
    jr nc,.done
    call snapshot            ; заодно следим за ошибками звука
    ret c
    ld a,(response+50)       ; код последней ошибки звуковой части
    or a
    scf
    ret nz
    ld hl,(budget)
    dec hl
    ld (budget),hl
    ld a,h
    or l
    jr nz,.poll
    ld a,UG_ERR_TIMEOUT
    scf
    ret
.cancel:
    ld a,UG_ERR_CANCELLED
    scf
    ret
.done:
    xor a
    ret

; docs:gs-cleanup:begin
; Общий выход. Незаконченную загрузку сначала закрывают D2h: в состоянии
; LOAD карта игнорирует другие команды. 37h удаляет модуль и эффекты,
; загруженные командами GS, и останавливает их звук.
cleanup:
    ld a,(loading)
    or a
    call nz,gs_close
    ld a,(loaded)
    or a
    ret z
    ld a,UG_GS_GS_FREE_LEGACY ; 37h
    ld b,0
    ld e,0
    jp gs_command
; docs:gs-cleanup:end

snapshot:
    ld a,UG_OP_SNAPSHOT
    ld bc,0
    ld ix,UG_OP_SNAPSHOT_RESP_LEN
rpc:
    ld de,response
    call UG_RPC
    ret c
    push ix
    pop hl
    or a
    sbc hl,bc
    ret z
    ld a,UG_ERR_LENGTH
    scf
    ret
compare:
    ld a,(de)
    cp (hl)
    jr nz,.bad
    inc hl
    inc de
    djnz compare
    xor a
    ret
.bad:
    ld a,UG_ERR_STATE
    scf
    ret
music_data:
    INCBIN "GUIDE.MOD"
MUSIC_BYTES EQU $-music_data
signature: DB "UGS1",1,0,8,0
ok_text: DB "GSMOD: module loaded by GS commands, played, paused, resumed, freed",13,10,0
error_text: DB "GSMOD: failed (DSS exit code = API error)",13,10,0
saved_sp EQU 0xB900
result EQU 0xB902
loading EQU 0xB903
loaded EQU 0xB904
second EQU 0xB905
elapsed EQU 0xB906
budget EQU 0xB908
target EQU 0xB90A
gs_reply EQU 0xB910
response EQU 0xBA00
    INCLUDE "ugproto.asm"
    ASSERT $ < 0xB700
    END start
