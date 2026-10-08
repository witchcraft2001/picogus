; SPDX-License-Identifier: GPL-2.0-or-later
;
; ugle.asm - little-endian writers for the Ultra GS host library.
; PUT/GET helpers are ASM helpers per spec 12.1, not memcpy'd structs.
;
;   PUT_LE16 : DE=dest, HL=value u16 -> writes L,H; DE advances 2
;   PUT_LE32 : DE=dest, HL=low16, BC=high16 -> 4 bytes; DE advances 4
;   PUT_LE64 : DE=dest, HL=ptr to 8-byte LE value -> copy 8; DE advances 8
;   GET_LE16 : HL=ptr -> HL = u16 read (L,H)
;   GET_LE32 : HL=ptr -> DE:HL = u32 (HL=low, DE=high)

PUT_LE16:
	ld	a,l
	ld	(de),a
	inc	de
	ld	a,h
	ld	(de),a
	inc	de
	ret

PUT_LE32:
	ld	a,l
	ld	(de),a
	inc	de
	ld	a,h
	ld	(de),a
	inc	de
	ld	a,c
	ld	(de),a
	inc	de
	ld	a,b
	ld	(de),a
	inc	de
	ret

PUT_LE64:
	ld	bc,8
	ldir
	ret

GET_LE16:
	ld	a,(hl)
	inc	hl
	ld	h,(hl)
	ld	l,a
	ret

GET_LE32:
	ld	a,(hl)
	ld	e,a
	inc	hl
	ld	a,(hl)
	ld	d,a
	inc	hl
	push	de
	ld	a,(hl)
	ld	e,a
	inc	hl
	ld	a,(hl)
	ld	d,a
	pop	hl
	ret
