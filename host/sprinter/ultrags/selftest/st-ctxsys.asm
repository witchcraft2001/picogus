; SPDX-License-Identifier: GPL-2.0-or-later
;
; Positive: obsolete SYSTEM save byte must not affect canonical DSS close.

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
