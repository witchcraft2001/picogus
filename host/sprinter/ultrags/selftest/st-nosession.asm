; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-nosession.asm - NEGATIVE: every public ISA-touching call must fail
; with UG_ERR_STATE when no session is open (UG_LIB_INIT only, never
; UG_OPEN).  UG_SNAPSHOT, UG_XCTRL and UG_GS_COMMAND funnel through
; UG_WIN_OPEN, which must refuse BEFORE any port/ISA access.  The runner
; asserts the ENTIRE run produced zero IO-port writes and zero ISA
; transactions, and that SYSTEM/PAGE3 stayed at their init values.
; Expected: exit 0, err=0, zero ioLog/isaLog entries.

	INCLUDE	"st-head.inc"

	; snapshot of the machine state BEFORE the calls: PAGE3/SYSTEM are
	; captured by the runner; the test only needs the three public calls
	call	UG_LIB_INIT		; no UG_OPEN at all

	; UG_SNAPSHOT without a session -> STATE, no window, bookkeeping
	ld	hl,ST_RESP		; valid in-RAM destination
	call	UG_SNAPSHOT
	jp	nc,st_fail
	cp	UG_ERR_STATE
	jp	nz,st_failA
	call	st_ckerr		; LAST_ERROR=STATE, LAST_SOURCE=HOST
	; UG_XCTRL without a session -> STATE, no X_CONTROL write
	ld	a,UG_XC_TRANSPORT_RESET
	call	UG_XCTRL
	jp	nc,st_fail
	cp	UG_ERR_STATE
	jp	nz,st_failA
	call	st_ckerr
	; UG_GS_COMMAND without a session -> STATE, nothing sent
	ld	hl,ST_GSDESC
	call	UG_GS_COMMAND
	jp	nc,st_fail
	cp	UG_ERR_STATE
	jp	nz,st_failA
	call	st_ckerr
	; UG_RPC without a session likewise -> STATE (defence in depth)
	ld	a,UG_OP_INFO
	ld	hl,ST_TX
	ld	bc,0
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	nc,st_fail
	cp	UG_ERR_STATE
	jp	nz,st_failA
	call	st_ckerr
	jp	st_pass

; shared bookkeeping check: after every no-session refusal the public
; ABI fields must read UG_LAST_ERROR==UG_ERR_STATE, UG_LAST_SOURCE==1
; (HOST).  A bookkeeping mismatch fails with marker E6h in the err byte
; so it cannot be confused with a wrong return code from the call.
st_ckerr:
	ld	a,(UG_LAST_ERROR)
	cp	UG_ERR_STATE
	jr	nz,.baderr
	ld	a,(UG_LAST_SOURCE)
	cp	1			; HOST
	ret	z
.baderr:
	; fail with a distinct marker so the runner's err byte shows the
	; bookkeeping check rather than the call check
	ld	a,0xE6
	ld	(ST_RESULT+3),a
	jp	st_fail

ST_GSDESC:
	DB	0x6A			; command
	DB	0x00			; has_pre = 0
	DB	0x00			; pre
	DB	0x00			; post_count = 0
	DW	ST_TX			; post_ptr (unused)
	DB	0x00			; reply_count = 0
	DW	ST_TX			; reply_ptr (unused)

	INCLUDE	"st-tail.inc"