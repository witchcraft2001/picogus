; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-alias.asm - NEGATIVE boundary: the 32-byte alias window maps every
; address to BULK_DATA.  Streaming 33 bytes via UG_BULK_WRITE_ALIAS makes
; byte 33 escape past the window (alias+20h is NOT an alias address).
; Expected: an ISA write lands outside the alias range (visible in the
; bus log) - the byte escapes instead of silently wrapping.

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	; ALLOC + BEGIN(64) so the grant is live for the stream
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
	ld	de,UG_ARGBUF
	ld	hl,(ST_RESP)
	call	PUT_LE16
	ld	hl,0
	ld	bc,0
	call	PUT_LE32
	ld	hl,64
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
	; 33-byte ALIAS burst: byte 33 lands at alias+20h (boundary escape)
	call	UG_WIN_OPEN
	jp	c,st_failA
	ld	hl,ST_TX
	ld	bc,33
	call	UG_BULK_WRITE_ALIAS
	call	UG_ISA_CLOSE
	; cancel the grant
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

	INCLUDE	"st-tail.inc"
