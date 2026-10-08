; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-dssgrant.asm - NEGATIVE: DSS call while a card transfer grant is
; active.  Defect: PCHARS runs between WRITE_BEGIN and the data phase.
; Expected: harness records "DSS call while transfer grant active".

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	; ALLOC 16 bytes
	ld	de,UG_ARGBUF
	xor	a
	ld	(de),a
	inc	de
	ld	hl,16
	ld	bc,0
	call	PUT_LE32
	ld	a,UG_OP_ALLOC
	ld	hl,UG_ARGBUF
	ld	bc,5
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	; WRITE_BEGIN(handle, 0, 16, FAST) -> grant opens
	ld	de,UG_ARGBUF
	ld	hl,(ST_RESP)
	call	PUT_LE16
	ld	hl,0
	ld	bc,0
	call	PUT_LE32
	ld	hl,16
	call	PUT_LE16
	xor	a
	ld	(de),a
	inc	de
	ld	a,UG_OP_WRITE_BEGIN
	ld	hl,UG_ARGBUF
	ld	bc,9
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	; grant is now live -> DSS call is the named violation
	ld	hl,stmsg
	ld	c,DSS_PCHARS
	rst	0x10
	; tidy up: framed TRANSFER_CANCEL(token) + close
	ld	de,UG_ARGBUF
	ld	hl,(ST_RESP)
	call	PUT_LE16
	ld	hl,(ST_RESP+2)
	call	PUT_LE16
	ld	a,UG_OP_TRANSFER_CANCEL
	ld	hl,UG_ARGBUF
	ld	bc,4
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	call	UG_CLOSE
	jp	st_pass

stmsg:	DB	"DSS-GRANT",0

	INCLUDE	"st-tail.inc"
