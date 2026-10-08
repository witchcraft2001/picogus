; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-verified.asm - POSITIVE BULK_VERIFIED roundtrip (spec 6.3):
;   WRITE_BEGIN carries a 13-byte request (host block CRC32 appended);
;   READ_BEGIN reply carries the card CRC32; READ_END carries ours.
;   The runner checks the card logged >=2 block CRC verifications and
;   that the BEGIN request on the wire was 13 bytes.
; Expected: exit 0, err=0.

	INCLUDE	"st-head.inc"

	; fill TX with the diag pattern (i*13+7)
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
	; UG_WRITE VERIFIED
	xor	a
	ld	(UG_OFFSET),a
	ld	(UG_OFFSET+1),a
	ld	(UG_OFFSET+2),a
	ld	(UG_OFFSET+3),a
	ld	hl,(ST_RESULT+4)
	ld	de,ST_TX
	ld	bc,64
	ld	a,UG_TRANSPORT_BULK_VERIFIED
	call	UG_WRITE
	jp	c,st_failA
	; UG_READ VERIFIED into ST_TX+256 (offset 0x100 keeps sources apart)
	xor	a
	ld	(UG_OFFSET),a
	ld	(UG_OFFSET+1),a
	ld	(UG_OFFSET+2),a
	ld	(UG_OFFSET+3),a
	ld	hl,(ST_RESULT+4)
	ld	de,ST_TX+256
	ld	bc,64
	ld	a,UG_TRANSPORT_BULK_VERIFIED
	call	UG_READ
	jp	c,st_failA
	; compare ST_TX vs ST_TX+256
	ld	de,ST_TX
	ld	hl,ST_TX+256
	ld	bc,64
.cmp:	ld	a,(de)
	cp	(hl)
	jp	nz,st_failA
	inc	de
	inc	hl
	dec	bc
	ld	a,b
	or	c
	jr	nz,.cmp
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