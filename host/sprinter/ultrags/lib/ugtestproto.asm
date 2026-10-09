; SPDX-License-Identifier: GPL-2.0-or-later
; Actual DSS protocol fault injections on an exclusively owned BLOB.
PROTO_SUITE:
    call BLOB_SETUP
    ld hl,32
    ld (SIZE32),hl
    ld hl,0
    ld (SIZE32+2),hl
    call RESERVE
    call START_BLOCKS
    call NEXT_BLOCK
    call PATTERN
    call WRITE_BLOCK
    ; Rewrites of committed prefix: short, extra, CRC must preserve data.
    ld a,16
    ld (V+130),a
    ld hl,31
    ld (V+132),hl
    call PROTO_BAD_BLOCK
    ld a,14
    ld (V+130),a
    ld hl,33
    ld (V+132),hl
    call PROTO_BAD_BLOCK
    ld a,4
    ld (V+130),a
    ld hl,32
    ld (V+132),hl
    call PROTO_BAD_BLOCK
    call READ_BLOCK
    call COMPARE_BLOCK
    ; A deserted grant times out; STATUS never extends its inactivity.
    call PROTO_TIMEOUT
    ; A bad FRAME_CRC must never allocate an object.
    ld a,1
    call UG_FRAME_CRC
    ld hl,proto_alloc
    ld de,UGREQ.FRAME
    ld bc,5
    ld a,16
    call UG_BUILD_FRAME
    ld hl,UGREQ.FRAME+10
    inc (hl)
    call UG_WIN_OPEN
    jp c,PROTOCOL
    ld hl,UGREQ.FRAME
    ld bc,11
    call UG_REQ_WRITE
    call UG_ISA_CLOSE
    call PROTO_REPLY
    ld a,(RESP)
    cp 4
    jp nz,VERIFY_ERROR
    ; Oversized length -> FAULT, suffix resembles ALLOC; no reply.
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    call UG_WIN_OPEN
    jp c,PROTOCOL
    ld hl,proto_oversize
    ld bc,8
    call UG_REQ_WRITE
    call UG_ISA_CLOSE
    call UG_POLL_STATUS
    and 7
    jp nz,VERIFY_ERROR
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    ; INFO recovery and own object remain readable.
    call SESSION_CHECK
    jp c,VERIFY_ERROR
    call READ_BLOCK
    call COMPARE_BLOCK
    ld hl,proto_pass
    call SHOW
    call NL
    jp PASS
PROTO_BAD_BLOCK:
    ld hl,(HANDLE)
    ld (REQ),hl
    xor a
    ld (REQ+2),a
    ld (REQ+3),a
    ld (REQ+4),a
    ld (REQ+5),a
    ld hl,32
    ld (REQ+6),hl
    ld a,(V+130)
    cp 4
    ld a,1
    ld bc,9
    jr nz,.fast
    ld a,0x81
    ld bc,13
    ld hl,0
    ld (REQ+9),hl
    ld (REQ+11),hl
.fast:
    ld (REQ+8),a
    ld a,32
    ld hl,REQ
    ld de,RESP
    ld ix,128
    call UG_RPC
    jp c,RPC_ERROR
    ld hl,RESP
    ld de,REQ
    ld bc,4
    ldir
    ld hl,BUF
    ld bc,(V+132)
.loop:
    push hl
    push bc
    ld a,(hl)
    call UG_GS_SD
    call UG_GS_WD
    pop bc
    pop hl
    inc hl
    dec bc
    ld a,b
    or c
    jr nz,.loop
    ld a,33
    ld hl,REQ
    ld de,RESP
    ld bc,4
    ld ix,128
    call UG_RPC
    ld b,a
    ld a,(V+130)
    cp b
    jp nz,VERIFY_ERROR
    ret
PROTO_REPLY:
    ld hl,0x4000
.loop:
    push hl
    call UG_POLL_STATUS
    pop hl
    bit 2,a
    jr nz,.ready
    dec hl
    ld a,h
    or l
    jr nz,.loop
    jp PROTOCOL
.ready:
    call UG_WIN_OPEN
    jp c,PROTOCOL
    ld de,RESP
    ld bc,6
    call UG_RESP_READ
    jp UG_ISA_CLOSE
PROTO_TIMEOUT:
    ld hl,(HANDLE)
    ld (REQ),hl
    ld hl,0
    ld (REQ+2),hl
    ld (REQ+4),hl
    ld hl,32
    ld (REQ+6),hl
    ld a,1
    ld (REQ+8),a
    ld a,32
    ld hl,REQ
    ld de,RESP
    ld bc,9
    ld ix,128
    call UG_RPC
    jp c,RPC_ERROR
    call UG_WAIT_START
    ; DSS has one-second resolution; six ticks ensure >= five seconds.
    ld a,6
    ld (UGTM.LIMIT),a
.wait:
    call UG_POLL_STATUS
    call UG_WAIT_NEXT
    jr nc,.wait
    cp UG_ERR_TIMEOUT
    jp nz,RPC_ERROR
    call UG_POLL_STATUS
    and 24
    jp nz,VERIFY_ERROR
    call UG_WIN_OPEN
    jp c,PROTOCOL
    ld a,UG_REG_X_ERROR
    call UG_REG_R
    push af
    call UG_ISA_CLOSE
    pop af
    cp UG_ERR_TIMEOUT
    jp nz,VERIFY_ERROR
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    call READ_BLOCK
    jp COMPARE_BLOCK
proto_alloc: DB 0,16,0,0,0
proto_oversize: DB 16,129,16,5,0,16,0,0
proto_pass: DB "PROTO CRC/SHORT/EXTRA/TIMEOUT/FAULT recovery PASS",0
