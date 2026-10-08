; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-dsswin.asm - NEGATIVE: DSS call while the ISA window is open.
; Defect demonstrated: application does PCHARS with the window mapped.
; Expected: harness records "DSS call while ISA window open".

	INCLUDE	"st-head.inc"

	xor	a			; slot 0, base 02A0h
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	; open a raw window (window-only op on the session context)
	call	UG_WIN_OPEN
	jp	c,st_failA
	; DSS call while the ISA window is mapped -> named violation
	ld	hl,stmsg
	ld	c,DSS_PCHARS
	rst	0x10
	call	UG_ISA_CLOSE
	jp	st_pass

stmsg:	DB	"DSS-WIN",0

	INCLUDE	"st-tail.inc"
