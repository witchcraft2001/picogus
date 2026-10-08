; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-ctxpg3.asm - NEGATIVE control: corrupt UGCTX.PAGE3SAVE mid-window so
; UG_ISA_CLOSE restores the WRONG page3.  Proves the restore path is the
; sampled cell and that a corrupted restore is observable at the harness.
; Expected: harness sees final PAGE3 != initial context.

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	call	UG_WIN_OPEN
	jp	c,st_failA
	ld	a,0x99			; poison the saved PAGE3 cell
	ld	(UGCTX.PAGE3SAVE),a
	call	UG_ISA_CLOSE
	; window is closed; PAGE3 was restored to 99h -> runner asserts the
	; corruption is visible (a correct restore would re-show the init)
	call	UG_CLOSE
	jp	st_pass

	INCLUDE	"st-tail.inc"
