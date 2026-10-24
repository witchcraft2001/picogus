; SPDX-License-Identifier: GPL-2.0-or-later
; Музыка и эффект: загрузить MOD блоками, включить его с повтором, поверх
; него на секунду включить короткий гудок, затем всё остановить и освободить.
; Для урока карта изначально пуста, других управляющих программ нет.
    IFNDEF DOC_SLOT
    DEFINE DOC_SLOT 0
    ENDIF
    DEFINE UG_NO_DSS          ; библиотека UltraGS не вызывает DSS
CARD_IO_BASE EQU 0x02A0
; docs:modfx-settings:begin
BLOCK_BYTES EQU 1024         ; наибольший блок одной передачи UG_WRITE
TONE_RATE   EQU 8000         ; частота гудка-эффекта
TONE_BYTES  EQU 256          ; длина его массива
FX_GAIN     EQU 32           ; громкость эффекта: 0 = тишина, 64 = максимум
FX_REPEAT   EQU 2            ; флаг PLAY_FX: повторять весь объект
; docs:modfx-settings:end
    ORG 0x8000
header:
    DB "EXE",1
    DW 128,0,0,0,0,0,start,start,0xB800
    DS 128-($-header),0
start:
    ld (saved_sp),sp
    ld hl,0
    ld (music_handle),hl
    ld (fx_handle),hl
    ld (play_id),hl
    ld (fx_id),hl
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
    ld hl,response+12
    ld de,saved_session
    ld bc,8
    ldir
    ld a,UG_OP_CAPS
    ld bc,0
    ld ix,UG_OP_CAPS_RESP_LEN
    call rpc
    ret c
    ld a,(response+1)
    bit 0,a                  ; features bit 8: независимые эффекты
    jr z,.unsupported
    ld a,(response+4)
    and 0x09                 ; formats: RAW8 и MOD4
    cp 0x09
    jr nz,.unsupported
    ld a,UG_OP_MEM_INFO
    ld bc,0
    ld ix,UG_OP_MEM_INFO_RESP_LEN
    call rpc
    ret c
    ld hl,(response+16)      ; уже загруженные объекты
    ld a,h
    or l
    ld a,UG_ERR_BUSY         ; урок требует пустую карту
    scf
    ret nz
    xor a
    ret
.unsupported:
    ld a,UG_ERR_STATE
    scf
    ret

; docs:modfx-sequence:begin
play_lesson:
    call load_music          ; ALLOC, блоки UG_WRITE, SEAL
    ret c
    call load_effect         ; то же для гудка плюс PCM_CONFIG
    ret c
    call start_music         ; PLAY_MOD с повтором песни
    ret c
    ld a,1
    call wait_seconds        ; секунда одной музыки
    ret c
    call start_effect        ; PLAY_FX поверх музыки
    ret c
    ld a,1
    call wait_seconds        ; секунда музыки вместе с гудком
    ret c
    call stop_effect         ; STOP_FX: музыка продолжается
    ret c
    ld a,1
    jp wait_seconds          ; ещё секунда одной музыки
; docs:modfx-sequence:end

; docs:load-music:begin
load_music:
    ld a,UG_OP_ALLOC
    ld hl,music_alloc        ; kind=MOD, размер файла
    ld bc,UG_OP_ALLOC_REQ_LEN
    ld ix,UG_OP_ALLOC_RESP_LEN
    call rpc
    ret c
    ld hl,(response)
    ld (music_handle),hl
    ld (music_seal),hl
    ld (music_play),hl
    ld hl,0
    ld (UG_OFFSET),hl        ; первый блок пишется с начала объекта
    ld (UG_OFFSET+2),hl
    ld hl,MUSIC_BYTES
    ld (remaining),hl
    ld de,music_data
.block:
    ld bc,(remaining)
    ld hl,BLOCK_BYTES
    or a
    sbc hl,bc                ; осталось больше одного блока?
    jr nc,.size_ok
    ld bc,BLOCK_BYTES        ; да: передаём ровно 1024 байта
.size_ok:
    push bc
    push de
    ld hl,(music_handle)
    ld a,UG_TRANSPORT_BULK_VERIFIED
    call UG_WRITE            ; HL=объект, DE=источник, BC=длина
    pop de
    pop bc
    ret c
    ld hl,(UG_OFFSET)
    add hl,bc                ; следующий блок продолжает предыдущий
    ld (UG_OFFSET),hl
    ex de,hl
    add hl,bc                ; источник тоже сдвигается
    ex de,hl
    ld hl,(remaining)
    or a
    sbc hl,bc
    ld (remaining),hl
    ld a,h
    or l
    jr nz,.block
    ld a,UG_OP_SEAL          ; все байты на карте: проверить формат MOD
    ld hl,music_seal
    ld bc,UG_OP_SEAL_REQ_LEN
    ld ix,UG_OP_SEAL_RESP_LEN
    jp rpc
; docs:load-music:end

load_effect:
    ld a,UG_OP_ALLOC
    ld hl,fx_alloc
    ld bc,UG_OP_ALLOC_REQ_LEN
    ld ix,UG_OP_ALLOC_RESP_LEN
    call rpc
    ret c
    ld hl,(response)
    ld (fx_handle),hl
    ld (fx_pcm),hl
    ld (fx_seal),hl
    ld (fx_play),hl
    ld hl,0
    ld (UG_OFFSET),hl        ; новый объект: снова с нулевого смещения
    ld (UG_OFFSET+2),hl
    ld hl,(fx_handle)
    ld de,samples
    ld bc,TONE_BYTES
    ld a,UG_TRANSPORT_BULK_VERIFIED
    call UG_WRITE
    ret c
    ld a,UG_OP_PCM_CONFIG
    ld hl,fx_pcm
    ld bc,UG_OP_PCM_CONFIG_REQ_LEN
    ld ix,0
    call rpc
    ret c
    ld a,UG_OP_SEAL
    ld hl,fx_seal
    ld bc,UG_OP_SEAL_REQ_LEN
    ld ix,UG_OP_SEAL_RESP_LEN
    jp rpc

; docs:start-music:begin
start_music:
    ld a,UG_OP_PLAY_MOD
    ld hl,music_play         ; номер объекта и флаги
    ld bc,UG_OP_PLAY_MOD_REQ_LEN
    ld ix,UG_OP_PLAY_MOD_RESP_LEN
    call rpc
    ret c
    ld hl,(response)
    ld (play_id),hl          ; номер запуска музыки
    xor a
    ret
; docs:start-music:end

; docs:start-effect:begin
start_effect:
    ld a,UG_OP_PLAY_FX
    ld hl,fx_play            ; объект, выбор голоса, приоритет, громкость
    ld bc,UG_OP_PLAY_FX_REQ_LEN
    ld ix,UG_OP_PLAY_FX_RESP_LEN
    call rpc
    ret c
    ld hl,(response)         ; первые 2 байта: номер запуска эффекта
    ld (fx_id),hl            ; следующие 2: сколько голосов он занял
    xor a
    ret

stop_effect:
    ld hl,(fx_id)
    ld (fx_stop),hl
    ld a,UG_OP_STOP_FX
    ld hl,fx_stop
    ld bc,UG_OP_STOP_FX_REQ_LEN
    ld ix,0
    call rpc
    ret c
    ld hl,0
    ld (fx_id),hl            ; больше останавливать нечего
    ret
; docs:start-effect:end

stop_music:
    ld hl,(play_id)
    ld (music_stop),hl
    ld a,UG_OP_CONTROL
    ld hl,music_stop
    ld bc,UG_OP_CONTROL_REQ_LEN
    ld ix,0
    call rpc
    ret c
    ld hl,0
    ld (play_id),hl
    ret

; A = сколько секунд ждать. ESC прекращает ожидание кодом CANCELLED.
; Все вызовы DSS выполняются при закрытом ISA-окне.
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
    ld a,UG_ERR_TIMEOUT      ; часы DSS не идут
    scf
    ret
.cancel:
    ld a,UG_ERR_CANCELLED
    scf
    ret
.done:
    xor a
    ret

; docs:modfx-cleanup:begin
; Общий выход: при успехе, ESC и любой ошибке. Останавливает только свои
; запуски и удаляет только свои объекты, повторяя FREE, пока данные заняты.
cleanup:
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL            ; закрыть недоконченный обмен, если он был
    ret c
    ld hl,(fx_id)
    ld a,h
    or l
    call nz,stop_effect
    ret c
    ld hl,(play_id)
    ld a,h
    or l
    call nz,stop_music
    ret c
    ld hl,fx_handle
    call free_object
    ret c
    ld hl,music_handle
    jp free_object

; HL = адрес переменной с номером объекта; 0 означает "удалять нечего".
free_object:
    ld e,(hl)
    inc hl
    ld d,(hl)
    ld a,d
    or e
    ret z
    ld (free_request),de
    ld a,64
    ld (retries),a
.retry:
    call snapshot            ; пауза: звуковая часть применяет STOP
    ret c
    ld a,UG_OP_FREE
    ld hl,free_request
    ld bc,UG_OP_FREE_REQ_LEN
    ld ix,0
    call rpc
    jr nc,.freed
    cp UG_ERR_PINNED         ; данные ещё звучат: повторить позже
    jr z,.again
    cp UG_ERR_BUSY
    ret nz
.again:
    ld hl,retries
    dec (hl)
    jr nz,.retry
    ld a,UG_ERR_TIMEOUT
    scf
    ret
.freed:
    xor a
    ret
; docs:modfx-cleanup:end

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
    sbc hl,bc                ; длина ответа должна совпасть с ожидаемой
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

; docs:modfx-requests:begin
music_alloc:
    DB UG_KIND_MOD           ; карта сама разберёт заголовок MOD
    DD MUSIC_BYTES           ; размер файла в байтах
music_seal:
    DW 0                     ; номер объекта запишет load_music
    DB 0                     ; CRC всего файла не задаём
    DD 0
music_play:
    DW 0                     ; номер объекта
    DB UG_MOD_LOOP           ; повторять песню до STOP
music_stop:
    DW 0                     ; номер запуска
    DB 0                     ; действие STOP
fx_alloc:
    DB UG_KIND_RAW_PCM
    DD TONE_BYTES
fx_pcm:
    DW 0                     ; номер объекта
    DD TONE_RATE             ; 8000 отсчётов в секунду
    DB 1,8,0,0               ; mono, 8 бит, U8, без внутренней петли
    DD 0                     ; данные с начала объекта
    DD TONE_BYTES
    DD 0,0
fx_seal:
    DW 0
    DB 0
    DD 0
fx_play:
    DW 0                     ; номер объекта
    DW UG_VOICE_AUTO         ; голос выберет карта
    DB 128                   ; приоритет среди эффектов
    DB FX_GAIN
    DB 128                   ; панорама: по центру
    DB FX_REPEAT             ; повторять, пока не остановим
fx_stop:
    DW 0                     ; номер запуска эффекта
free_request:
    DW 0
; docs:modfx-requests:end
samples:
    DUP 4
        DUP 32
            DB 144
        EDUP
        DUP 32
            DB 112
        EDUP
    EDUP
    ASSERT $-samples == TONE_BYTES
music_data:
    INCBIN "GUIDE.MOD"       ; четырёхканальный MOD, собранный docs-examples.py
MUSIC_BYTES EQU $-music_data
signature: DB "UGS1",1,0,8,0
ok_text: DB "MODFX: music looped, effect added and stopped, freed",13,10,0
error_text: DB "MODFX: failed (DSS exit code = API error)",13,10,0
saved_sp EQU 0xB900
result EQU 0xB902
music_handle EQU 0xB904
fx_handle EQU 0xB906
play_id EQU 0xB908
fx_id EQU 0xB90A
saved_session EQU 0xB90C
remaining EQU 0xB914
second EQU 0xB916
elapsed EQU 0xB917
budget EQU 0xB918
retries EQU 0xB91A
target EQU 0xB91B
response EQU 0xBA00
    INCLUDE "ugproto.asm"
    ASSERT $ < 0xB700
    END start
