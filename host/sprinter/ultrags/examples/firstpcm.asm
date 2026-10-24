; SPDX-License-Identifier: GPL-2.0-or-later
; Первый звук: загрузить свой массив, описать, проверить, проиграть, удалить.
; Для этого урока карта изначально пуста, других управляющих программ нет.
    IFNDEF DOC_SLOT
    DEFINE DOC_SLOT 0
    ENDIF
    DEFINE UG_NO_DSS          ; библиотека UltraGS не вызывает DSS
; docs:card-address:begin
CARD_IO_BASE EQU 0x02A0       ; первый порт UltraGS на шине ISA
; docs:card-address:end

; docs:tone-settings:begin
TONE_RATE   EQU 8000         ; 8000 отсчётов звука в секунду
TONE_BYTES  EQU 256          ; длина нашего массива в байтах
TONE_GAIN   EQU 16           ; громкость: 0 = тишина, 64 = максимум
PAN_CENTER  EQU 128          ; по центру между левым и правым выходами
PCM_U8      EQU 0            ; формат: один беззнаковый байт на отсчёт
; docs:tone-settings:end
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
    ld (result),a             ; report cleanup failure too
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
; docs:open-card:begin
    call UG_LIB_INIT         ; подготовить переменные библиотеки
    ld a,DOC_SLOT            ; слот с картой: 0 или 1
    ld hl,CARD_IO_BASE       ; адрес первого порта карты
    call UG_OPEN             ; проверить, что карта отвечает
    ret c                    ; при ошибке вернуться к общему выходу
; docs:open-card:end
    ld a,1                   ; включить проверку целостности ответов
    call UG_FRAME_CRC
    jp check_card            ; версия, возможности и свободная память

; Служебные проверки до первого изменения памяти карты.
; Их подробный разбор находится после урока о загрузке звука.
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
; docs:save-session:begin
    ld hl,response+12        ; поле session в ответе INFO
    ld de,saved_session      ; место для его копии в памяти Z80
    ld bc,8                  ; идентификатор занимает восемь байт
    ldir                     ; сохранить, ничего не посылая карте
; docs:save-session:end
    ld a,UG_OP_CAPS
    ld bc,0
    ld ix,UG_OP_CAPS_RESP_LEN
    call rpc
    ret c
    ld a,(response)
    bit 0,a                  ; карта умеет воспроизводить PCM
    jr z,.unsupported
    ld a,(response+4)
    bit 0,a                  ; карта понимает формат RAW8
    jr z,.unsupported
    ld a,UG_OP_MEM_INFO
    ld bc,0
    ld ix,UG_OP_MEM_INFO_RESP_LEN
    call rpc
    ret c
    ld hl,(response+16)      ; число уже загруженных объектов
    ld a,h
    or l
    ld a,UG_ERR_BUSY         ; учебный пример требует пустую карту
    scf
    ret nz
    xor a
    ret
.unsupported:
    ld a,UG_ERR_STATE
    scf
    ret

; docs:tone-sequence:begin
play_tone:
    call allocate_sound      ; получить место в памяти карты
    ret c
    call upload_sound        ; скопировать туда массив samples
    ret c
    call describe_sound      ; задать частоту и формат массива
    ret c
    call seal_sound          ; подтвердить: загрузка закончена
    ret c
    call verify_sound        ; прочитать обратно и сравнить
    ret c
    call start_sound         ; теперь включить воспроизведение
    ret c
    call wait_tone           ; подождать 1-2 секунды или ESC
    ret
; docs:tone-sequence:end

allocate_sound:
    ld a,1
    ld (allocated),a          ; для очистки даже при потере ответа ALLOC
; docs:allocate-sound:begin
    ld a,UG_OP_ALLOC         ; команда: выделить память
    ld hl,alloc_request      ; адрес её аргументов в памяти Z80
    ld bc,UG_OP_ALLOC_REQ_LEN ; размер аргументов: 5 байт
    ld ix,UG_OP_ALLOC_RESP_LEN ; ожидаем ответ из 6 байт
    call rpc                 ; отправить команду, получить response
    ret c                    ; ошибка: следующий шаг не выполнять
    ld hl,(response)         ; первые 2 байта: номер нового объекта
    ld (sound_handle),hl     ; запомнить этот номер
; docs:allocate-sound:end
    ld (pcm_request),hl      ; тот же номер нужен следующим командам
    ld (seal_request),hl
    ld (play_request),hl
    xor a
    ret

; docs:upload-sound:begin
upload_sound:
    ld hl,0
    ld (UG_OFFSET),hl        ; смещение = 0: пишем с начала объекта
    ld (UG_OFFSET+2),hl      ; смещение занимает 4 байта, обнуляем оба слова
    ld hl,(sound_handle)     ; куда: объект в памяти карты
    ld de,samples            ; откуда: массив в памяти Z80
    ld bc,TONE_BYTES         ; сколько: 256 байт
    ld a,UG_TRANSPORT_BULK_VERIFIED ; передача с проверкой целостности
    call UG_WRITE
    ret
; docs:upload-sound:end

; docs:describe-sound:begin
describe_sound:
    ld a,UG_OP_PCM_CONFIG    ; команда: описать содержимое RAW
    ld hl,pcm_request        ; номер объекта, частота, формат, длина
    ld bc,UG_OP_PCM_CONFIG_REQ_LEN ; 26 байт аргументов
    ld ix,0                  ; данных в ответе нет, только успех/ошибка
    call rpc
    ret
; docs:describe-sound:end

; docs:seal-sound:begin
seal_sound:
    ld a,UG_OP_SEAL          ; команда: проверить и завершить загрузку
    ld hl,seal_request
    ld bc,UG_OP_SEAL_REQ_LEN ; 7 байт аргументов
    ld ix,UG_OP_SEAL_RESP_LEN ; 4 байта контрольной суммы в ответе
    call rpc
    ret
; docs:seal-sound:end

; docs:verify-sound:begin
verify_sound:
    ld hl,(sound_handle)     ; читаем тот же объект
    ld de,readback           ; но в другой массив памяти Z80
    ld bc,TONE_BYTES
    ld a,UG_TRANSPORT_BULK_VERIFIED
    call UG_READ             ; UG_OFFSET остался равен нулю
    ret c
    ld hl,readback
    ld de,samples
    ld b,0                   ; цикл DJNZ при B=0 выполнит 256 сравнений
    call compare             ; проверить все прочитанные байты
    ret
; docs:verify-sound:end

; docs:start-sound:begin
start_sound:
    ld a,UG_OP_PLAY_PCM      ; команда: воспроизвести объект
    ld hl,play_request       ; номер объекта, повторы, громкость, панорама
    ld bc,UG_OP_PLAY_PCM_REQ_LEN ; 6 байт аргументов
    ld ix,UG_OP_PLAY_PCM_RESP_LEN ; 2 байта: номер запуска
    call rpc
    ret c
    ld hl,(response)
    ld (play_id),hl           ; нужен для остановки именно этого запуска
    xor a
    ret
; docs:start-sound:end

; docs:stop-sound:begin
stop_sound:
    ld hl,(play_id)           ; номер запуска, который требуется остановить
    ld (stop_request),hl
    ld a,UG_OP_CONTROL       ; управление воспроизведением
    ld hl,stop_request       ; номер запуска и действие STOP
    ld bc,UG_OP_CONTROL_REQ_LEN ; 3 байта аргументов
    ld ix,0                  ; ответ без дополнительных данных
    call rpc
    ret
; docs:stop-sound:end

; docs:free-sound:begin
free_sound:
    ld a,UG_OP_FREE          ; команда: удалить объект из памяти карты
    ld hl,sound_handle       ; адрес переменной с номером объекта
    ld bc,UG_OP_FREE_REQ_LEN ; номер занимает 2 байта
    ld ix,0                  ; ответ без дополнительных данных
    call rpc
    ret
; docs:free-sound:end

tone_parameters:
; docs:alloc-params:begin
alloc_request:
    DB UG_KIND_RAW_PCM       ; будут обычные отсчёты, без заголовка файла
    DD TONE_BYTES            ; нужно 256 байт памяти на карте
; docs:alloc-params:end
; docs:pcm-params:begin
pcm_request:
    DW 0                     ; сюда allocate_sound запишет sound_handle
    DD TONE_RATE             ; частота: 8000 отсчётов в секунду
    DB 1                     ; один канал: mono
    DB 8                     ; 8 бит, то есть один байт на отсчёт
    DB PCM_U8                ; значения от 0 до 255, середина = 128
    DB 0                     ; внутренняя петля не используется
    DD 0                     ; отсчёты начинаются с первого байта объекта
    DD TONE_BYTES            ; длина массива в байтах
    DD 0                     ; начало внутренней петли: не используется
    DD 0                     ; конец внутренней петли: не используется
; docs:pcm-params:end
; docs:seal-params:begin
seal_request:
    DW 0                     ; сюда allocate_sound запишет sound_handle
    DB 0                     ; не задаём ожидаемую CRC всего объекта
    DD 0                     ; это поле тогда должно быть нулём
; docs:seal-params:end
; docs:play-params:begin
play_request:
    DW 0                     ; сюда allocate_sound запишет sound_handle
    DW 0                     ; повторять весь объект до команды STOP
    DB TONE_GAIN             ; небольшая громкость, 16 из 64
    DB PAN_CENTER            ; одинаковая громкость слева и справа
; docs:play-params:end
; docs:samples:begin
samples:
    DUP 4                    ; четыре одинаковых периода волны
        DUP 32
            DB 144           ; 32 отсчёта выше середины
        EDUP
        DUP 32
            DB 112           ; 32 отсчёта ниже середины
        EDUP
    EDUP
    ASSERT $-samples == TONE_BYTES ; 4 * (32 + 32) = 256 байт
; docs:samples:end
tone_parameters_end:

; About 1..2 seconds; SCANKEY and SYSTIME are outside the ISA window.
; A finite iteration bound also catches a stopped DSS clock.
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
    ; Polling a snapshot lets the caller also monitor card errors.
    call snapshot
    ret c
    ld a,(response+50)        ; asynchronous audio error
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
    ld a,UG_ERR_TIMEOUT      ; TIMEOUT
    scf
    ret
.cancel:
    ld a,UG_ERR_CANCELLED    ; CANCELLED
    scf
    ret
.done:
    xor a
    ret

; Common exit for success, ESC and errors. The empty-store precondition
; plus exclusive host access makes the sole allocated object ours even
; after a damaged ALLOC reply. Check saved_session before using any old ID.
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
    jr c,.changed            ; old objects no longer belong to this saved_session
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
    ret z                    ; ALLOC did not take effect
    call snapshot
    ret c
    ld hl,(response+28)       ; stop only foreground using our sound_handle
    ld de,(sound_handle)
    or a
    sbc hl,de
    jr nz,.free
    ld hl,(response+20)       ; recovers a lost PLAY acknowledgement too
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
    call snapshot            ; wait for the audio side to apply STOP
    ret c
    call free_sound
    ret nc
    cp UG_ERR_PINNED         ; PINNED until STOP has been applied
    jr z,.again
    cp UG_ERR_BUSY           ; BUSY is also retryable here
    ret nz
.again:
    ld hl,retries
    dec (hl)
    jr nz,.retry
    ld a,UG_ERR_TIMEOUT
    scf
    ret
.changed:
    ld a,UG_ERR_STATE        ; STATE: never FREE IDs from a new saved_session
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
    sbc hl,bc                ; require the exact response length
    ret z
    ld a,UG_ERR_LENGTH       ; LENGTH
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
    ld a,UG_ERR_STATE        ; STATE / unexpected bytes
    scf
    ret
enum_request: DW 0
; docs:stop-params:begin
stop_request:
    DW 0                     ; сюда stop_sound запишет play_id
    DB 0                     ; действие 0 = STOP (остановить)
; docs:stop-params:end
signature: DB "UGS1",1,0,8,0,"VLS1"
ok_text: DB "PCM: uploaded, read back, played, freed",13,10,0
error_text: DB "PCM: failed (DSS exit code = API error)",13,10,0
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
response EQU 0xBA00           ; 128 bytes, outside the library workspace
readback EQU 0x5800           ; 256 bytes, outside the DSS resident area
    INCLUDE "ugproto.asm"
    ASSERT $ < 0xB700
    END start
