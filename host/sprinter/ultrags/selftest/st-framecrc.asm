; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-framecrc.asm - POSITIVE RULE: UG_FRAME_CRC accepts exactly A=0/1
; (spec 12.1).  Any other value must return CF=1/A=UG_ERR_BAD_ARGUMENT
; with UG_LAST_ERROR=UG_ERR_BAD_ARGUMENT and UG_LAST_SOURCE=1 (HOST),
; and must leave the previous flag untouched.  Pure-ABI test: no bus
; access is needed, so the whole run must show zero IO writes.

	INCLUDE	"st-head.inc"

	call	UG_LIB_INIT
	; 0 accepted, flag reads 0
	xor	a
	call	UG_FRAME_CRC
	jp	c,st_fail
	ld	a,(UGFRAME.CRCF)
	or	a
	jp	nz,st_fail
	; 1 accepted, flag reads 1
	ld	a,1
	call	UG_FRAME_CRC
	jp	c,st_fail
	ld	a,(UGFRAME.CRCF)
	cp	1
	jp	nz,st_fail
	; 2 refused: BAD_ARGUMENT/HOST, flag still 1
	ld	a,2
	call	UG_FRAME_CRC
	jp	nc,st_fail		; must not succeed
	cp	UG_ERR_BAD_ARGUMENT
	jp	nz,st_failA
	call	st_cksrc
	ld	a,(UGFRAME.CRCF)
	cp	1			; unchanged from the accepted set
	jp	nz,st_fail
	; 0FFh refused: BAD_ARGUMENT/HOST, flag still 1
	ld	a,0xFF
	call	UG_FRAME_CRC
	jp	nc,st_fail
	cp	UG_ERR_BAD_ARGUMENT
	jp	nz,st_failA
	call	st_cksrc
	ld	a,(UGFRAME.CRCF)
	cp	1
	jp	nz,st_fail
	; and 0 still accepted after refusals
	xor	a
	call	UG_FRAME_CRC
	jp	c,st_fail
	ld	a,(UGFRAME.CRCF)
	or	a
	jp	nz,st_fail
	jp	st_pass

; LAST_ERROR must hold BAD_ARGUMENT, LAST_SOURCE must be 1 (HOST) after
; a refused UG_FRAME_CRC.  Mismatch -> marker E7h in err byte.
st_cksrc:
	ld	a,(UG_LAST_ERROR)
	cp	UG_ERR_BAD_ARGUMENT
	jr	nz,.bad
	ld	a,(UG_LAST_SOURCE)
	cp	1			; HOST
	ret	z
.bad:	ld	a,0xE7
	ld	(ST_RESULT+3),a
	jp	st_fail

	INCLUDE	"st-tail.inc"