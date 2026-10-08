; SPDX-License-Identifier: GPL-2.0-or-later
;
; ugframe.asm - compact request frame serializer for the Ultra GS host
; library (spec 6.2). Builds: header2 + payload + optional CRC-32 trailer.
;
;   UG_BUILD_FRAME:
;     in : A  = opcode (0..7Fh; bit7 set = arg error, never sent)
;          DE = destination buffer (>= 134 bytes)
;          HL = payload source (may be anything when BC=0)
;          BC = payload length (0..UG_MAX_PAYLOAD)
;          UGFRAME.CRCF: 0=FAST, nonzero=FRAME_CRC bit + 4-byte trailer
;     out: CF=0, BC = total frame length (2+len[+4])
;          CF=1 on arg error (opcode>=80h or len>128)
;     preserves IX/IY; clobbers AF,BC,DE,HL
;
; The serializer writes header0 = opcode | (CRCF ? 80h : 0) and appends
; the CRC only when CRCF set - matching "CRC trailer 4 bytes only by
; request" and "bit7 is only FRAME_CRC" (spec 6.2).

	INCLUDE "ugmem.inc"
	INCLUDE "ug_wire.inc"

UG_BUILD_FRAME:
	push	ix
	bit	7,a
	jr	nz,.bad			; opcode must be < 80h
	push	af			; keep opcode for .out balance
	ld	a,b
	or	a
	jr	nz,.badp		; len must be < 256 (B=0)
	ld	a,c
	cp	UG_MAX_PAYLOAD+1
	jr	nc,.badp		; len > 128 rejected
	; header0 = opcode (bit7 patched later if CRCF)
	pop	af
	push	af
	ld	(de),a
	inc	de
	; header1 = payload length
	ld	a,c
	ld	(de),a
	inc	de
	; payload copy (BC=0 must NOT enter LDIR: it would copy 65536 bytes)
	ld	a,b
	or	c
	jr	z,.nopl
	push	bc
	ldir				; HL=src -> DE=dst, BC bytes
	pop	bc
.nopl:
	; trailer?
	ld	a,(UGFRAME.CRCF)
	or	a
	jr	nz,.crc
	inc	bc
	inc	bc			; total = len + 2
	jr	.out
.crc:	; remember payload len for total (BC will be consumed by CRC)
	ld	a,c
	ld	(UGFRAME.SV),a
	; frame base = DE - (2 + len)
	ld	a,e
	sub	c
	ld	l,a
	ld	a,d
	sbc	a,0
	ld	h,a
	dec	hl
	dec	hl			; HL = frame base
	set	7,(hl)			; header0 |= 80h
	; crc over base..end = len+2 bytes
	push	de			; save end ptr
	inc	bc
	inc	bc			; BC = len + 2
	call	UG_CRC32		; -> UGCRC.OUT (4 bytes LE)
	pop	de
	ld	a,(UGCRC.OUT)
	ld	(de),a
	inc	de
	ld	a,(UGCRC.OUT+1)
	ld	(de),a
	inc	de
	ld	a,(UGCRC.OUT+2)
	ld	(de),a
	inc	de
	ld	a,(UGCRC.OUT+3)
	ld	(de),a
	inc	de
	; total = len + 6
	ld	a,(UGFRAME.SV)
	add	a,6
	ld	c,a
	xor	a
	ld	b,a
.out:	pop	af			; discard saved opcode
	pop	ix
	or	a			; CF=0
	ret
.badp:	pop	af
.bad:	pop	ix
	scf				; CF=1 error
	ret
