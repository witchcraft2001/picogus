; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-ctxiff.asm - NEGATIVE control: corrupt UGCTX.IFFSAVE mid-window so
; UG_ISA_CLOSE restores the WRONG interrupt flag.
; Expected: harness sees final IFF1 != the sampled value.

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	call	UG_WIN_OPEN
	jp	c,st_failA
	; flip the saved IFF: write the opposite of what was sampled
	ld	a,(UGCTX.IFFSAVE)
	xor	1
	ld	(UGCTX.IFFSAVE),a
	call	UG_ISA_CLOSE
	call	UG_CLOSE
	jp	st_pass

	INCLUDE	"st-tail.inc"
