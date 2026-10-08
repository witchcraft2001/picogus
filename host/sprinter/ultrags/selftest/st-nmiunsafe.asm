; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-nmiunsafe.asm - POSITIVE RULE: UG_WRITE_STACK with an unproven NMI
; profile must refuse UG_ERR_UNSAFE_NMI (F0h) WITHOUT touching the ISA
; bus.  DI does not mask NMI; spec 11.4 makes the switched-SP window
; conditional on a proven NMI-safe interval.
; Expected: CF=1/A=F0h and zero ISA traffic attributable to the call.

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	; ALLOC so a handle exists (STACK refusal is not about objects)
	ld	de,UG_ARGBUF
	xor	a
	ld	(de),a
	inc	de
	ld	hl,16
	ld	bc,0
	call	PUT_LE32
	ld	a,UG_OP_ALLOC
	ld	hl,UG_ARGBUF
	ld	bc,5
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	; UG_WRITE_STACK must refuse: UG_NMI_PROFILE is UNKNOWN (0)
	ld	hl,(ST_RESP)
	ld	de,ST_TX
	ld	bc,16
	xor	a			; BULK_FAST
	call	UG_WRITE_STACK
	jp	nc,st_fail		; must not succeed
	cp	UG_ERR_UNSAFE_NMI
	jp	nz,st_failA
	call	UG_CLOSE
	jp	st_pass

	INCLUDE	"st-tail.inc"
