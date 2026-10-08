; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-budget.asm - POSITIVE RULE under a wedged card: the REPLY wait loop
; is BOUNDED.  The model is run with noReply=true so EXEC never
; completes; UG_RPC must return UG_ERR_TIMEOUT (0Dh) inside the step
; budget and leave the transport usable (TRANSPORT_RESET was issued).
; Expected: err=0Dh, run terminates well under the instruction cap.

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	; INFO request; card wedges in EXEC -> bounded wait -> TIMEOUT
	ld	a,UG_OP_INFO
	ld	hl,UG_ARGBUF
	ld	bc,0
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	nc,st_fail		; success here would mean no timeout
	cp	UG_ERR_TIMEOUT
	jp	nz,st_failA
	; bookkeeping: a wedged/no-reply wait is a HOST transport failure,
	; not a card status - LAST_ERROR=TIMEOUT, LAST_SOURCE=1(HOST)
	ld	a,(UG_LAST_ERROR)
	cp	UG_ERR_TIMEOUT
	jr	nz,.badsrc
	ld	a,(UG_LAST_SOURCE)
	cp	1			; HOST
	jr	z,.srcok
.badsrc:
	ld	a,0xE8			; distinct marker: timeout src wrong
	ld	(ST_RESULT+3),a
	jp	st_fail
.srcok:
	call	UG_CLOSE
	jp	st_pass

	INCLUDE	"st-tail.inc"
