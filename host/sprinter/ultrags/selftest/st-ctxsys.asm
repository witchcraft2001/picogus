; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-ctxsys.asm - NEGATIVE control: corrupt UGCTX.SYSSAVE mid-window so
; UG_ISA_CLOSE restores the WRONG PORT_SYSTEM value.
; Expected: harness sees final SYSTEM != initial context.

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	call	UG_WIN_OPEN
	jp	c,st_failA
	ld	a,0x77			; poison the saved SYSTEM cell
	ld	(UGCTX.SYSSAVE),a
	call	UG_ISA_CLOSE
	call	UG_CLOSE
	jp	st_pass

	INCLUDE	"st-tail.inc"
