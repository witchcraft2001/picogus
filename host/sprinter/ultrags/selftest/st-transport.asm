; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-transport.asm - NEGATIVE: public UG_WRITE/UG_READ accept ONLY the
; implemented BULK transports (00h FAST, 80h VERIFIED).  GS transports
; 01h/81h (and any other value) must fail BAD_ARGUMENT WITHOUT touching
; the bus - the runner counts the ISA events after ALLOC's reply and
; requires zero.
; Expected: exit 0, err=0, no bus traffic from the rejected calls.

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	; ALLOC 64 BLOB
	ld	de,UG_ARGBUF
	xor	a
	ld	(de),a
	inc	de
	ld	hl,64
	ld	bc,0
	call	PUT_LE32
	ld	a,UG_OP_ALLOC
	ld	hl,UG_ARGBUF
	ld	bc,5
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	ld	hl,(ST_RESP)
	ld	(ST_RESULT+4),hl	; handle
	xor	a
	ld	(UG_OFFSET),a
	ld	(UG_OFFSET+1),a
	ld	(UG_OFFSET+2),a
	ld	(UG_OFFSET+3),a
	; UG_WRITE transport=01h (GS_FAST) -> BAD_ARGUMENT, no bus access
	ld	hl,(ST_RESULT+4)
	ld	de,ST_TX
	ld	bc,64
	ld	a,1
	call	UG_WRITE
	jp	nc,st_fail
	cp	UG_ERR_BAD_ARGUMENT
	jp	nz,st_failA
	; UG_WRITE transport=81h (GS_VERIFIED) -> BAD_ARGUMENT
	ld	hl,(ST_RESULT+4)
	ld	de,ST_TX
	ld	bc,64
	ld	a,0x81
	call	UG_WRITE
	jp	nc,st_fail
	cp	UG_ERR_BAD_ARGUMENT
	jp	nz,st_failA
	; UG_READ transport=01h -> BAD_ARGUMENT
	ld	hl,(ST_RESULT+4)
	ld	de,ST_TX
	ld	bc,64
	ld	a,1
	call	UG_READ
	jp	nc,st_fail
	cp	UG_ERR_BAD_ARGUMENT
	jp	nz,st_failA
	; UG_WRITE N=0 -> LENGTH, still no bus access
	ld	hl,(ST_RESULT+4)
	ld	de,ST_TX
	ld	bc,0
	xor	a
	call	UG_WRITE
	jp	nc,st_fail
	cp	UG_ERR_LENGTH
	jp	nz,st_failA
	; FREE + CLOSE
	ld	de,UG_ARGBUF
	ld	hl,(ST_RESULT+4)
	call	PUT_LE16
	ld	a,UG_OP_FREE
	ld	hl,UG_ARGBUF
	ld	bc,2
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	call	UG_CLOSE
	jp	st_pass

	INCLUDE	"st-tail.inc"