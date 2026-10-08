; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-badcrc.asm - NEGATIVE: a VERIFIED WRITE_BEGIN with a deliberately
; wrong host block CRC is ACCEPTED at BEGIN (spec 6.3 defers the check
; to END), then rejected by the card with X_CRC (0x04) at WRITE_END
; once the received bytes fail the comparison.  The transfer must be
; released and the object pin dropped.
; Expected: WRITE_END returns status CRC(4); card.transfer is null.

	INCLUDE	"st-head.inc"

	; fill TX with real data (the forged crc below will not match it)
	ld	hl,ST_TX
	ld	bc,64
	ld	e,7
.fill:	ld	a,e
	ld	(hl),a
	inc	hl
	add	a,13
	ld	e,a
	dec	bc
	ld	a,b
	or	c
	jr	nz,.fill

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
	; manual WRITE_BEGIN req: handle,off=0,n=64,transport=80h,crc=BAD
	ld	de,UG_ARGBUF
	call	PUT_LE16		; HL still = handle
	ld	hl,0
	call	PUT_LE16
	call	PUT_LE16		; offset u32 = 0
	ld	hl,64
	call	PUT_LE16		; n
	ld	a,UG_TRANSPORT_BULK_VERIFIED
	ld	(de),a
	inc	de			; transport
	ld	hl,0xDEAD		; deliberately wrong host crc
	call	PUT_LE16
	ld	hl,0xBEEF
	call	PUT_LE16		; crc u32 = BEEFDEADh
	ld	a,UG_OP_WRITE_BEGIN
	ld	hl,UG_ARGBUF
	ld	bc,13
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA		; BEGIN is allowed to accept (crc is deferred)
	; token for the manual END
	ld	hl,(ST_RESP)
	ld	(ST_RESULT+6),hl
	ld	hl,(ST_RESP+2)
	ld	(ST_RESULT+8),hl
	; stream the real 64 bytes inside the grant
	call	UG_WIN_OPEN
	jp	c,st_failA
	ld	hl,ST_TX
	ld	bc,64
	call	UG_BULK_WRITE
	call	UG_ISA_CLOSE
	; manual WRITE_END(token): the received bytes fail the forged crc
	ld	de,UG_ARGBUF
	ld	hl,(ST_RESULT+6)
	call	PUT_LE16
	ld	hl,(ST_RESULT+8)
	call	PUT_LE16
	ld	a,UG_OP_WRITE_END
	ld	hl,UG_ARGBUF
	ld	bc,4
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	nc,st_fail		; must fail
	cp	UG_ERR_CRC
	jp	nz,st_failA
	; bookkeeping: the card answered with a nonzero WIRE STATUS, so
	; LAST_ERROR=CRC and LAST_SOURCE must be 2 (X), not HOST
	ld	a,(UG_LAST_ERROR)
	cp	UG_ERR_CRC
	jr	nz,.badsrc
	ld	a,(UG_LAST_SOURCE)
	cp	2			; X: genuine card status byte
	jr	z,.srcok
.badsrc:
	ld	a,0xE9			; distinct marker: wrong err source
	ld	(ST_RESULT+3),a
	jp	st_fail
.srcok:
	; FREE the object: END released the pin even on the crc error
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