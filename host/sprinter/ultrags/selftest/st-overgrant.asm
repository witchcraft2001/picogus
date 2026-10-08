; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-overgrant.asm - NEGATIVE: one byte beyond the advertised grant.
; BEGIN grants N=16 bytes; the host deliberately streams 17.  Expected:
; the card flags OVERFLOW (0Eh), the WRITE_END status returns nonzero,
; and the run records it - not a generic hang.

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	; ALLOC 64B
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
	; WRITE_BEGIN(handle, 0, 16, FAST)
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
	; stream SEVENTEEN bytes in one bounded window (one over grant)
	ld	hl,ST_TX
	call	UG_WIN_OPEN
	jp	c,st_failA
	ld	hl,ST_TX
	ld	bc,17
	call	UG_BULK_WRITE
	call	UG_ISA_CLOSE
	; WRITE_END(token) -> card reports OVERFLOW as response status
	ld	de,UG_ARGBUF
	ld	hl,(ST_RESP)
	call	PUT_LE16
	ld	hl,(ST_RESP+2)
	call	PUT_LE16
	ld	a,UG_OP_WRITE_END
	ld	hl,UG_ARGBUF
	ld	bc,4
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	nc,st_fail		; END must NOT succeed
	; A holds the wire status; OVERFLOW = 0Eh is the named defect
	cp	UG_ERR_OVERFLOW
	jp	nz,st_failA
	call	UG_CLOSE
	jp	st_pass

	INCLUDE	"st-tail.inc"
