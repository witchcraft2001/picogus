; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-ctxsp.asm - NEGATIVE: SP is pointed into the ISA window while it is
; mapped; the PUSH writes onto the card bus.  Expected: harness flags
; "stack inside ISA window" (and the push itself hits an ISA address).

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	call	UG_WIN_OPEN
	jp	c,st_failA
	ld	hl,0
	add	hl,sp			; keep real SP in HL
	ld	sp,0xC500			; SP into the window (illegal)
	push	af			; this PUSH writes to the ISA bus
	pop	af
	ld	sp,hl			; restore real SP
	call	UG_ISA_CLOSE
	call	UG_CLOSE
	jp	st_pass

	INCLUDE	"st-tail.inc"
