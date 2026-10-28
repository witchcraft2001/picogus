; SPDX-License-Identifier: GPL-2.0-or-later
; S3M: загрузка через расширенный API или командами GS, чтение обратно,
; наблюдение за трекером и очистка своих ресурсов.
; Перед работой программа сбрасывает карту: чужие объекты и звук не сохраняются.
    IFNDEF DOC_SLOT
    DEFINE DOC_SLOT 0
    ENDIF
    DEFINE UG_NO_DSS          ; библиотека UltraGS не вызывает DSS
CARD_IO_BASE EQU 0x02A0       ; первый порт UltraGS на шине ISA

TONE_BYTES  EQU 768
    ORG 0x8000
header:
    DB "EXE",1
    DW 128,0,0,0,0,0,start,start,0xB800
    DS 128-($-header),0
start:
    ld (saved_sp),sp
    xor a
    ld (allocated),a
    call open_card
    jr c,finish
    call play_tone
finish:
    ld (result),a
    call cleanup
    jr nc,.closed
    ld (result),a             ; ошибку очистки тоже сообщить
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
    call UG_LIB_INIT         ; подготовить переменные библиотеки
    ld a,DOC_SLOT            ; слот с картой: 0 или 1
    ld hl,CARD_IO_BASE       ; адрес первого порта карты
    call UG_OPEN             ; проверить, что карта отвечает
    ret c                    ; при ошибке вернуться к общему выходу
    ld a,1                   ; включить проверку целостности ответов
    call UG_FRAME_CRC
    jp check_card            ; версия, возможности, затем сброс карты

; Служебные проверки и сброс карты до первого изменения её памяти.
check_card:
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
    ld hl,response+36
    ld b,4
    call compare
    ret c
    ld a,UG_OP_CAPS
    ld bc,0
    ld ix,UG_OP_CAPS_RESP_LEN
    call rpc
    ret c
    ld a,(response)
    bit 1,a                  ; features бит 1: трекер MOD/S3M
    jr z,.unsupported
    ld a,(response+4)
    bit 7,a                  ; formats бит 7: S3M
    jr z,.unsupported
    jp reset_card            ; начать с чистой карты (глава 3)
.unsupported:
    ld a,UG_ERR_STATE
    scf
    ret

; Сброс карты, как в главе 2: отменить чужую передачу, RESET_STORE уровня 0,
; запомнить новый session.
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
    ld hl,response
    ld de,saved_session
    ld bc,8
    ldir
    xor a
    ret
reset_request:
    DD UG_RESET_STORE_KEY
    DB 0

play_tone:
    call allocate_sound      ; получить место в памяти карты
    ret c
    call upload_sound        ; скопировать туда массив samples
    ret c
    call seal_sound          ; подтвердить: загрузка закончена
    ret c
    call verify_sound        ; прочитать обратно и сравнить
    ret c
    call start_sound         ; теперь включить воспроизведение
    ret c
    call wait_tone           ; подождать 1-2 секунды или ESC
    ret

allocate_sound:
    IFDEF DEMO_GS
    ld a,1
    ld (allocated),a
    ld hl,gs_load
    call UG_GS_COMMAND
    ret c
    ld a,UG_OP_LEGACY_INFO
    ld bc,0
    ld ix,UG_OP_LEGACY_INFO_RESP_LEN
    call rpc
    ret c
    ld hl,(response+4)
    ld (sound_handle),hl
    ld a,h
    or l
    jr nz,.ready
    ld a,UG_ERR_NO_MEMORY
    scf
    ret
.ready:
    xor a
    ret
    ELSE
    ld a,1
    ld (allocated),a          ; для очистки даже при потере ответа ALLOC
    ld a,UG_OP_ALLOC         ; команда: выделить память
    ld hl,alloc_request      ; адрес её аргументов в памяти Z80
    ld bc,UG_OP_ALLOC_REQ_LEN ; размер аргументов: 5 байт
    ld ix,UG_OP_ALLOC_RESP_LEN ; ожидаем ответ из 6 байт
    call rpc                 ; отправить команду, получить response
    ret c                    ; ошибка: следующий шаг не выполнять
    ld hl,(response)         ; первые 2 байта: номер нового объекта
    ld (sound_handle),hl     ; запомнить этот номер
    ld (seal_request),hl
    ld (play_request),hl
    xor a
    ret
    ENDIF

upload_sound:
    IFDEF DEMO_GS
    ld hl,gs_d1
    call UG_GS_COMMAND
    ret c
    ld hl,samples
    ld bc,TONE_BYTES
.byte:
    push hl
    push bc
    ld a,(hl)
    call UG_GS_SD
    call nc,UG_GS_WD
    pop bc
    pop hl
    ret c
    inc hl
    dec bc
    ld a,b
    or c
    jr nz,.byte
    ret
    ELSE
    ld hl,0
    ld (UG_OFFSET),hl        ; смещение = 0: пишем с начала объекта
    ld (UG_OFFSET+2),hl      ; смещение занимает 4 байта, обнуляем оба слова
    ld hl,(sound_handle)     ; куда: объект в памяти карты
    ld de,samples            ; откуда: массив в памяти Z80
    ld bc,TONE_BYTES         ; сколько: 256 байт
    ld a,UG_TRANSPORT_BULK_VERIFIED ; передача с проверкой целостности
    call UG_WRITE
    ret
    ENDIF

seal_sound:
    IFDEF DEMO_GS
    ld hl,gs_d2
    call UG_GS_COMMAND
    ret c
    ld a,(gs_reply)
    or a
    jr nz,.ready
    ld a,UG_ERR_FORMAT
    scf
    ret
.ready:
    xor a
    ret
    ELSE
    ld a,UG_OP_SEAL          ; команда: проверить и завершить загрузку
    ld hl,seal_request
    ld bc,UG_OP_SEAL_REQ_LEN ; 7 байт аргументов
    ld ix,UG_OP_SEAL_RESP_LEN ; 4 байта контрольной суммы в ответе
    call rpc
    ret
    ENDIF

verify_sound:
    ld hl,0
    ld (UG_OFFSET),hl
    ld (UG_OFFSET+2),hl
    ld hl,(sound_handle)     ; читаем тот же объект
    ld de,readback           ; но в другой массив памяти Z80
    ld bc,TONE_BYTES
    ld a,UG_TRANSPORT_BULK_VERIFIED
    call UG_READ             ; UG_OFFSET остался равен нулю
    ret c
    ld hl,readback
    ld de,samples
    ld c,3                   ; все 768 байт исходного файла
.block:
    push bc
    ld b,0
    call compare
    pop bc
    ret c
    dec c
    jr nz,.block
    ret

start_sound:
    IFDEF DEMO_GS
    ld hl,gs_play
    call UG_GS_COMMAND
    ret c
    ld a,(gs_reply)
    or a
    jr nz,.ready
    ld a,UG_ERR_NO_VOICE
    scf
    ret
.ready:
    xor a
    ret
    ELSE
    ld a,UG_OP_PLAY_MOD      ; команда трекера принимает и S3M
    ld hl,play_request       ; номер объекта, повторы, громкость, панорама
    ld bc,UG_OP_PLAY_MOD_REQ_LEN ; handle (2 байта) и флаги (1 байт)
    ld ix,UG_OP_PLAY_MOD_RESP_LEN ; ответ: play_id (2 байта)
    call rpc
    ret c
    ld hl,(response)
    ld (play_id),hl           ; нужен для остановки именно этого запуска
    xor a
    ret
    ENDIF

stop_sound:
    ld hl,(play_id)           ; номер запуска, который требуется остановить
    ld (stop_request),hl
    ld a,UG_OP_CONTROL       ; управление воспроизведением
    ld hl,stop_request       ; номер запуска и действие STOP
    ld bc,UG_OP_CONTROL_REQ_LEN ; 3 байта аргументов
    ld ix,0                  ; ответ без дополнительных данных
    call rpc
    ret

free_sound:
    ld a,UG_OP_FREE          ; команда: удалить объект из памяти карты
    ld hl,sound_handle       ; адрес переменной с номером объекта
    ld bc,UG_OP_FREE_REQ_LEN ; номер занимает 2 байта
    ld ix,0                  ; ответ без дополнительных данных
    call rpc
    ret

alloc_request:
    DB UG_KIND_S3M
    DD TONE_BYTES
seal_request:
    DW 0
    DB 0
    DD 0
play_request:
    DW 0
    DB 1                     ; только LOOP: флаги F00 для S3M не годятся
samples:
    DB "UltraGS S3M example"
    DS 28-($-samples),0
    DB 0x1A,16
    DW 0,2,1,1,0,0x1321,2
    DB "SCRM",64,6,125,0xB0,0,0
    DS 8,0
    DW 0
    DB 0
    DS 31,255
    DB 0,255                 ; порядок: паттерн 0, затем конец песни
    DW 7,12                  ; инструмент с 112, паттерн с 192 (в параграфах)
    DS 112-($-samples),0
    DB 1
    DS 12,0
    DB 0
    DW 32                    ; отсчёты с байта 512
    DD 256,0,256             ; длина, начало и конец петли в отсчётах
    DB 32,0,0,1              ; громкость, резерв, без упаковки, петля/U8/моно
    DD 8363
    DS 12,0
    DB "Own quiet square"
    DS 188-($-samples),0
    DB "SCRS"
    DW 78                    ; размер упакованного паттерна вместе с этим словом
    DB 0xE0,0x40,1,32,0,0,0
    DS 3,0
    DB 0xE0,255,0,255,3,0,0  ; C00 после четырёх строк
    DS 59,0
    DS 512-($-samples),0
    DUP 4
        DS 32,144
        DS 32,112
    EDUP
    ASSERT $-samples == TONE_BYTES
tone_parameters_end:

; Ждать 1-2 секунды. Клавиатура и часы DSS опрашиваются при закрытом окне ISA.
; Число итераций ограничено: так замечается и остановившийся таймер DSS.
wait_tone:
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
    cp 2
    jr nc,.done
    ; Снимок состояния заодно показывает ошибки звуковой части.
    call snapshot
    ret c
    ld a,(response+50)        ; код последней ошибки звуковой части
    or a
    scf
    ret nz
    ld hl,response+4
    ld de,saved_session
    ld b,8
    call compare
    ret c
    ld hl,(budget)
    dec hl
    ld (budget),hl
    ld a,h
    or l
    jr nz,.poll
    ld a,UG_ERR_TIMEOUT      ; время ожидания истекло
    scf
    ret
.cancel:
    ld a,UG_ERR_CANCELLED    ; нажата ESC
    scf
    ret
.done:
    xor a
    ret

; Общий выход: при успехе, ESC и любой ошибке. Карта сброшена в начале, и
; другие программы ею не управляют, поэтому единственный объект на ней наш,
; даже если ответ ALLOC был потерян. Старые номера используются только
; при прежнем сеансе (saved_session).
cleanup:
    ld a,(allocated)
    or a
    ret z
    ld a,UG_XC_TRANSPORT_RESET ; отменить незавершённый обмен
    call UG_XCTRL
    ret c
    xor a
    ld bc,0
    ld ix,UG_OP_INFO_RESP_LEN
    call rpc
    ret c
    ld hl,response+12
    ld de,saved_session
    ld b,8
    call compare
    jr c,.changed            ; сеанс сменился: старые номера забыть
    IFDEF DEMO_GS
    ; Незаконченную загрузку GS сначала закрыть D2h: даже при ответе FORMAT
    ; она снимает закрепление объекта. Карту при выходе не сбрасывают.
    ld a,UG_OP_LEGACY_INFO
    ld bc,0
    ld ix,UG_OP_LEGACY_INFO_RESP_LEN
    call rpc
    ret c
    ld hl,(response+4)
    ld a,h
    or l
    jr z,.gs_closed
    ld hl,gs_d2
    call UG_GS_COMMAND
    ret c
.gs_closed:
    ENDIF
    ld a,UG_OP_OBJECT_ENUM   ; найти объект после потери ответа ALLOC
    ld hl,enum_request
    ld bc,2
    ld ix,2
    call rpc
    ret c
    ld hl,(response)
    ld (sound_handle),hl
    ld a,h
    or l
    ret z                    ; ALLOC не выполнился: удалять нечего
    call snapshot
    ret c
    ld hl,(response+28)       ; останавливать, только если играет наш объект
    ld de,(sound_handle)
    or a
    sbc hl,de
    jr nz,.free
    ld hl,(response+20)       ; play_id, даже если ответ PLAY был потерян
    ld a,h
    or l
    jr z,.free
    ld (play_id),hl
    call stop_sound
    ret c
.free:
    ld a,64
    ld (retries),a
.retry:
    call snapshot            ; пауза, пока звуковая часть выполняет STOP
    ret c
    call free_sound
    ret nc
    cp UG_ERR_PINNED         ; PINNED: STOP ещё не выполнен
    jr z,.again
    cp UG_ERR_BUSY           ; BUSY: тоже повторить
    ret nz
.again:
    ld hl,retries
    dec (hl)
    jr nz,.retry
    ld a,UG_ERR_TIMEOUT
    scf
    ret
.changed:
    ld a,UG_ERR_STATE        ; сеанс сменился: старые номера не удалять
    scf
    ret
snapshot:
    ld a,UG_OP_SNAPSHOT
    ld bc,0
    ld ix,UG_OP_SNAPSHOT_RESP_LEN
    jp rpc
rpc:
    ld de,response
    call UG_RPC
    ret c
    push ix
    pop hl
    or a
    sbc hl,bc                ; длина ответа должна совпасть с ожидаемой
    ret z
    ld a,UG_ERR_LENGTH       ; неверная длина ответа
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
    ld a,UG_ERR_STATE        ; байты не совпали
    scf
    ret
gs_load: DB 0x30,0,0,0
    DW 0
    DB 1
    DW gs_reply
gs_d1: DB 0xD1,0,0,0
    DW 0
    DB 0
    DW gs_reply
gs_d2: DB 0xD2,0,0,0
    DW 0
    DB 1
    DW gs_reply
gs_play: DB 0x31,1,0,0
    DW 0
    DB 1
    DW gs_reply
gs_reply: DB 0
enum_request: DW 0
stop_request:
    DW 0                     ; сюда stop_sound запишет play_id
    DB 0                     ; действие 0 = STOP (остановить)
signature: DB "UGS1",1,0,8,0,"VLS1"
ok_text: DB "S3M: uploaded, read back, played, freed",13,10,0
error_text: DB "S3M: failed (DSS exit code = API error)",13,10,0
saved_sp EQU 0xB900
result EQU 0xB902
allocated EQU 0xB903
sound_handle EQU 0xB904
play_id EQU 0xB906
saved_session EQU 0xB908
second EQU 0xB910
elapsed EQU 0xB911
budget EQU 0xB912
retries EQU 0xB914
response EQU 0xBA00           ; 128 байт, вне рабочей области библиотеки
readback EQU 0x5800           ; 768 байт, вне резидентной области DSS
    INCLUDE "ugproto.asm"
    ASSERT $ < 0xB700
    END start
