; SPDX-License-Identifier: GPL-2.0-or-later
; POSITIVE: an unread response may not be reused as a new RPC response.
; The refused call resets transport but sends no request bytes.
	INCLUDE "st-head.inc"
	xor a
	ld hl,0x2A0
	call UG_OPEN
	jp c,st_failA
	call UG_WIN_OPEN
	jp c,st_failA
	ld hl,.request
	ld bc,2
	call UG_REQ_WRITE
	call UG_ISA_CLOSE
	ld a,UG_OP_INFO
	ld hl,UG_ARGBUF
	ld bc,0
	ld de,ST_RESP
	ld ix,64
	call UG_RPC
	jp nc,st_fail
	cp UG_ERR_STATE
	jp nz,st_fail
	ld a,(UG_LAST_SOURCE)
	cp 1
	jp nz,st_fail
	call UG_CLOSE
	jp st_pass
.request:	DB 0,0
	INCLUDE "st-tail.inc"
