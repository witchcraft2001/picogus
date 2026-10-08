; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-badslot.asm - POSITIVE RULE: invalid slot (2/3) is rejected with
; UG_ERR_BAD_ARGUMENT (02h) BEFORE any hardware write.  Also exercises
; slot=1 as the valid non-zero slot so CURBASE != slot is observable.
; Expected: A=02h on slot 2; zero ISA-window traffic; ctx intact.

	INCLUDE	"st-head.inc"

	; slot 2: must fail with BAD_ARGUMENT before touching hardware
	ld	a,2
	ld	hl,0x02A0
	call	UG_OPEN
	jp	nc,st_fail		; CF=0 would be wrong
	cp	UG_ERR_BAD_ARGUMENT
	jp	nz,st_failA
	; slot 3 likewise
	ld	a,3
	ld	hl,0x02A0
	call	UG_OPEN
	jp	nc,st_fail
	cp	UG_ERR_BAD_ARGUMENT
	jp	nz,st_failA
	; valid nonzero slot for contrast (runner places the card in slot 1)
	ld	a,1
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	; CURSLOT must be 1, CURBASE must be A0h (low base != slot)
	ld	a,(UG_CURSLOT)
	cp	1
	jp	nz,st_failA
	ld	a,(UG_CURBASE)
	cp	0xA0
	jp	nz,st_failA
	call	UG_CLOSE
	jp	st_pass

	INCLUDE	"st-tail.inc"
