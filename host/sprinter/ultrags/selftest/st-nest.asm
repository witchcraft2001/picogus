; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-nest.asm - POSITIVE RULE: nested UG_OPEN is rejected with the
; defined error UG_ERR_STATE (06h) and no hardware corruption.
; Expected: second call CF=1/A=06h; context restored.

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	; second open while the session is live
	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	nc,st_fail		; CF=0 would be wrong
	cp	UG_ERR_STATE
	jp	nz,st_failA		; must be STATE
	call	UG_CLOSE
	jp	st_pass

	INCLUDE	"st-tail.inc"
