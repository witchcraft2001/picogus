; SPDX-License-Identifier: GPL-2.0-or-later
;
; ugcrc.asm - CRC-32/ISO-HDLC for the Ultra GS host library.
; Reflected poly EDB88320h, init FFFFFFFFh, xorout FFFFFFFFh (spec 6.1).
;
; Streaming ABI (single workspace, non-recursive, never from ISR):
;   UG_CRC32_INIT : ACC := FFFFFFFFh
;   UG_CRC32_FOLD : HL=data ptr, BC=len; folds all bytes into ACC
;   UG_CRC32_END  : ACC := ACC xor FFFFFFFFh -> UGCRC.ACC, UGCRC.OUT
;   UG_CRC32      : one-shot INIT+FOLD+END (HL,BC) -> UGCRC.OUT valid
;
; Register use inside fold: B,C,D,E = 32-bit accumulator (B=MSB),
;   HL = data ptr, A = scratch, H = bit counter (data ptr pushed per byte).
; Output CRC is available little-endian at UGCRC.ACC / UGCRC.OUT.
; ABI: BC, DE, HL, IX, IY and the alternate set are preserved; AF and the
;   flag state are NOT (A is used freely inside UG_CRC32_FOLD).
;   UG_CRC32_INIT/END preserve AF.

	INCLUDE "ugmem.inc"

; ---------------------------------------------------------------- init
UG_CRC32_INIT:
	push	af
	ld	a,0xFF
	ld	(UGCRC.ACC),a
	ld	(UGCRC.ACC+1),a
	ld	(UGCRC.ACC+2),a
	ld	(UGCRC.ACC+3),a
	pop	af
	ret

; ---------------------------------------------------------------- fold
; In: HL=ptr, BC=len (may be 0). Folds bytes into UGCRC.ACC.
UG_CRC32_FOLD:
	push	bc
	push	de
	push	hl
	; store remaining length into UGCRC.N (u16)
	ld	a,c
	ld	(UGCRC.N),a
	ld	a,b
	ld	(UGCRC.N+1),a
	; load accumulator B(MSB),C,D,E(LSB)
	ld	a,(UGCRC.ACC+3)
	ld	b,a
	ld	a,(UGCRC.ACC+2)
	ld	c,a
	ld	a,(UGCRC.ACC+1)
	ld	d,a
	ld	a,(UGCRC.ACC)
	ld	e,a
.by:	; while N != 0
	ld	a,(UGCRC.N+1)
	or	a
	jr	nz,.more
	ld	a,(UGCRC.N)
	or	a
	jr	z,.done
.more:	; N--
	ld	a,(UGCRC.N)
	sub	1
	ld	(UGCRC.N),a
	ld	a,(UGCRC.N+1)
	sbc	a,0
	ld	(UGCRC.N+1),a
	; ACC ^= *HL++
	ld	a,(hl)
	inc	hl
	xor	e
	ld	e,a
	; 8 bit shifts; save data ptr, H = bit counter
	push	hl
	ld	h,8
.bits:	srl	b			; ACC >>= 1; old bit0 -> CF
	rr	c
	rr	d
	rr	e
	jr	nc,.nox
	ld	a,b
	xor	0xED			; poly EDB88320h
	ld	b,a
	ld	a,c
	xor	0xB8
	ld	c,a
	ld	a,d
	xor	0x83
	ld	d,a
	ld	a,e
	xor	0x20
	ld	e,a
.nox:	dec	h
	jr	nz,.bits
	pop	hl
	jr	.by
.done:	; store accumulator back
	ld	a,b
	ld	(UGCRC.ACC+3),a
	ld	a,c
	ld	(UGCRC.ACC+2),a
	ld	a,d
	ld	(UGCRC.ACC+1),a
	ld	a,e
	ld	(UGCRC.ACC),a
	pop	hl
	pop	de
	pop	bc
	ret

; ---------------------------------------------------------------- end
; Finalize: ACC ^= FFFFFFFFh; copy ACC to UGCRC.OUT.
UG_CRC32_END:
	push	af
	ld	a,(UGCRC.ACC)
	xor	0xFF
	ld	(UGCRC.ACC),a
	ld	(UGCRC.OUT),a
	ld	a,(UGCRC.ACC+1)
	xor	0xFF
	ld	(UGCRC.ACC+1),a
	ld	(UGCRC.OUT+1),a
	ld	a,(UGCRC.ACC+2)
	xor	0xFF
	ld	(UGCRC.ACC+2),a
	ld	(UGCRC.OUT+2),a
	ld	a,(UGCRC.ACC+3)
	xor	0xFF
	ld	(UGCRC.ACC+3),a
	ld	(UGCRC.OUT+3),a
	pop	af
	ret

; ---------------------------------------------------------------- one-shot
; In: HL=ptr, BC=len -> UGCRC.OUT = crc32(data) (LE, 4 bytes)
UG_CRC32:
	call	UG_CRC32_INIT
	call	UG_CRC32_FOLD
	call	UG_CRC32_END
	ret
