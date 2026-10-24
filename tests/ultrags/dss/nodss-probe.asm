; SPDX-License-Identifier: GPL-2.0-or-later
; nodss-probe.asm - host probe for UG_NO_DSS with and without UG_ISA_TURBO_OFF.
; The harness patches probe_mode before the run and makes the card stall:
;   0 open/close only        1 INFO RPC
;   2 GS command 37h (WC)    3 ALLOC + 16-byte UG_WRITE over GS_FAST
; The DSS exit code is the API error (0 = success).
    DEFINE UG_NO_DSS
    ORG 0x8000
header:
    DB "EXE",1
    DW 128,0,0,0,0,0,start,start,0xB800
    DS 128-($-header),0
start:
    ld (saved_sp),sp
    call UG_LIB_INIT
    ld a,(probe_slot)
    ld hl,0x02A0
    call UG_OPEN
    jr c,.exit
    ld a,(probe_mode)
    dec a
    jr z,.info
    dec a
    jr z,.gs
    dec a
    jr z,.write
    xor a
    jr .close
.info:
    ld a,UG_OP_INFO
    ld bc,0
    ld ix,UG_OP_INFO_RESP_LEN
    ld de,response
    call UG_RPC
    jr .close
.gs:
    ld hl,gs_desc
    call UG_GS_COMMAND
    jr .close
.write:
    ld a,UG_OP_ALLOC
    ld hl,alloc_req
    ld bc,UG_OP_ALLOC_REQ_LEN
    ld ix,UG_OP_ALLOC_RESP_LEN
    ld de,response
    call UG_RPC
    jr c,.close
    ld hl,0
    ld (UG_OFFSET),hl
    ld (UG_OFFSET+2),hl
    ld hl,(response)
    ld de,payload
    ld bc,16
    ld a,UG_TRANSPORT_GS_FAST
    call UG_WRITE
.close:
    jr c,.keep
    xor a
.keep:
    push af
    call UG_CLOSE
    pop af
.exit:
    jr c,.code
    xor a
.code:
    ld sp,(saved_sp)
    ld b,a
    ld c,0x41
    rst 0x10

probe_mode: DB 0
probe_slot: DB 0
alloc_req:  DB UG_KIND_BLOB
            DD 16
gs_desc:    DB 0x37,0,0,0
            DW 0
            DB 0
            DW response
payload:    DS 16,0x5A
response:   DS 64,0
saved_sp EQU 0xB900
    INCLUDE "ugproto.asm"
