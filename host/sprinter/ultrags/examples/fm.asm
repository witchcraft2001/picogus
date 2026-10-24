; SPDX-License-Identifier: GPL-2.0-or-later
; Нота OPL2: настроить инструмент на канале 0, нажать клавишу на секунду,
; отпустить её и дать звуку затухнуть. Образцы не загружаются.
    IFNDEF DOC_SLOT
    DEFINE DOC_SLOT 0
    ENDIF
    DEFINE UG_NO_DSS          ; библиотека UltraGS не вызывает DSS
CARD_IO_BASE EQU 0x02A0
; docs:fm-settings:begin
OPL_ISA_BASE EQU 0x0388      ; порты OPL2: 0388h адрес/статус, 0389h данные
OPL_ADDRESS  EQU 0xC388      ; те же порты в окне win3: C000h + номер порта
OPL_DATA     EQU 0xC389
NOTE_FNUM_LO EQU 0x44        ; A-4 (440 Гц): f-number 244h при октаве 4
NOTE_KEY_ON  EQU 0x32        ; бит 5 = клавиша нажата, октава 4, f-number[9:8]=2
NOTE_KEY_OFF EQU 0x12        ; те же биты без бита 5
; docs:fm-settings:end
    ORG 0x8000
header:
    DB "EXE",1
    DW 128,0,0,0,0,0,start,start,0xB800
    DS 128-($-header),0
start:
    ld (saved_sp),sp
    xor a
    ld (sounding),a
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
; docs:fm-caps:begin
    ld a,UG_OP_CAPS
    ld bc,0
    ld ix,UG_OP_CAPS_RESP_LEN
    call rpc
    ret c
    ld a,(response+1)        ; второй байт поля features
    bit 5,a                  ; бит 13: встроенный OPL2
    jr nz,.ok
    ld a,UG_ERR_STATE
    scf
    ret
.ok:
    xor a
    ret
; docs:fm-caps:end

; docs:fm-sequence:begin
play_lesson:
    call silence_all         ; снять старые ноты, мелодический режим
    ret c
    ld hl,instrument
    call write_registers     ; тембр канала 0
    ret c
    ld a,0xA0
    ld e,NOTE_FNUM_LO        ; младшие 8 бит высоты ноты
    call opl_write
    ret c
    ld a,1
    ld (sounding),a
    ld a,0xB0
    ld e,NOTE_KEY_ON         ; старшие биты, октава и нажатие клавиши
    call opl_write
    ret c
    ld a,1
    call wait_seconds        ; нота звучит
    ret c
    ld a,0xB0
    ld e,NOTE_KEY_OFF        ; клавиша отпущена: начинается затухание
    call opl_write
    ret c
    xor a
    ld (sounding),a
    ld a,1
    jp wait_seconds          ; слышно затухание
; docs:fm-sequence:end

; docs:fm-write:begin
; A = номер регистра OPL2, E = значение. Между записью адреса и данных
; чипу нужно не меньше 3,3 мкс, после данных - не меньше 23 мкс; паузы
; заполняются чтением статуса. Окно ISA открыто только на время записи.
opl_write:
    ld (opl_reg),a
    ld a,e
    ld (opl_value),a
    ld a,DOC_SLOT
    ld hl,OPL_ISA_BASE
    call UG_ISA_OPEN
    ret c
    ld a,(opl_reg)
    ld (OPL_ADDRESS),a
    ld b,6
.address_delay:
    ld a,(OPL_ADDRESS)
    djnz .address_delay
    ld a,(opl_value)
    ld (OPL_DATA),a
    ld b,36
.data_delay:
    ld a,(OPL_ADDRESS)
    djnz .data_delay
    jp UG_ISA_CLOSE

; HL = таблица пар "регистр, значение", конец - байт FFh.
write_registers:
    ld a,(hl)
    cp 0xFF
    jr z,.done
    inc hl
    ld e,(hl)
    inc hl
    push hl
    call opl_write
    pop hl
    ret c
    jr write_registers
.done:
    xor a
    ret
; docs:fm-write:end

; Снять клавиши всех девяти каналов и выбрать мелодический режим.
silence_all:
    ld a,0xB0
.channel:
    push af
    ld e,0
    call opl_write
    pop bc
    ret c
    ld a,b
    inc a
    cp 0xB9
    jr nz,.channel
    ld a,0xBD
    ld e,0
    jp opl_write

; docs:fm-instrument:begin
instrument:
    DB 0x01,0x20             ; разрешить выбор формы волны
    DB 0x20,0x21             ; модулятор: множитель частоты 1, удержание
    DB 0x23,0x21             ; носитель: то же
    DB 0x40,0x18             ; уровень модулятора: ослабить на 18 дБ
    DB 0x43,0x00             ; носитель на полной громкости
    DB 0x60,0xF3             ; быстрая атака, умеренный спад
    DB 0x63,0xF3
    DB 0x80,0x35             ; уровень удержания и скорость затухания
    DB 0x83,0x35
    DB 0xE0,0x00             ; синус у обоих операторов
    DB 0xE3,0x00
    DB 0xC0,0x00             ; FM-связь операторов, без обратной связи
    DB 0xFF
; docs:fm-instrument:end

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

; Общий выход: отпустить свою ноту, если она ещё нажата. Другие каналы
; программа не трогает: у OPL2 нет учёта владельцев, ноты снимает тот,
; кто их нажал.
cleanup:
    ld a,(sounding)
    or a
    ret z
    ld a,0xB0
    ld e,NOTE_KEY_OFF
    jp opl_write

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
signature: DB "UGS1",1,0,8,0
ok_text: DB "FM: note played and released",13,10,0
error_text: DB "FM: failed (DSS exit code = API error)",13,10,0
saved_sp EQU 0xB900
result EQU 0xB902
sounding EQU 0xB903
opl_reg EQU 0xB904
opl_value EQU 0xB905
second EQU 0xB906
elapsed EQU 0xB907
budget EQU 0xB908
target EQU 0xB90A
response EQU 0xBA00
    INCLUDE "ugproto.asm"
    ASSERT $ < 0xB700
    END start
