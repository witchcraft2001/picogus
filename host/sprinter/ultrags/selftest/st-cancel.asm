; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-cancel.asm - POSITIVE rollback coverage: a live write grant is
; cancelled by the framed TRANSFER_CANCEL (spec 7.4).  After cancel the
; object pin must be released: OBJECT_INFO.pins == 0 and FREE succeeds.
; The runner also checks the [24h,04,id...] frame hit the wire and the
; card's transfer slot was released.
; Expected: exit 0, err=0.

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
	; manual WRITE_BEGIN (FAST): handle,off=0,n=64,trans=0
	ld	de,UG_ARGBUF
	call	PUT_LE16		; HL = handle still
	ld	hl,0
	call	PUT_LE16
	call	PUT_LE16
	ld	hl,64
	call	PUT_LE16
	xor	a
	ld	(de),a			; BULK_FAST
	ld	a,UG_OP_WRITE_BEGIN
	ld	hl,UG_ARGBUF
	ld	bc,9
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	; token -> ST_RESULT+6
	ld	hl,(ST_RESP)
	ld	(ST_RESULT+6),hl
	ld	hl,(ST_RESP+2)
	ld	(ST_RESULT+8),hl
	; write 32 real bulk bytes inside the live grant
	call	UG_WIN_OPEN
	jp	c,st_failA
	ld	hl,ST_TX
	ld	bc,32
	call	UG_BULK_WRITE
	call	UG_ISA_CLOSE
	; TRANSFER_CANCEL(token)
	ld	de,UG_ARGBUF
	ld	hl,(ST_RESULT+6)
	call	PUT_LE16
	ld	hl,(ST_RESULT+8)
	call	PUT_LE16
	ld	a,UG_OP_TRANSFER_CANCEL
	ld	hl,UG_ARGBUF
	ld	bc,4
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	; OBJECT_INFO: pins must be 0 (bytes 4..5 of the 38-byte reply)
	ld	de,UG_ARGBUF
	ld	hl,(ST_RESULT+4)
	call	PUT_LE16
	ld	a,UG_OP_OBJECT_INFO
	ld	hl,UG_ARGBUF
	ld	bc,2
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	ld	a,(ST_RESP+4)
	or	a
	jp	nz,st_failA		; pins still held
	ld	a,(ST_RESP+5)
	or	a
	jp	nz,st_failA
	; FREE now succeeds (unpinned, no transfer)
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