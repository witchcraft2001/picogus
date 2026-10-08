; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-nmihaz.asm - NEGATIVE hazard demonstration: the caller lies about
; NMI safety (forces UG_NMI_PROFILE=1) and the harness injects a real
; NMI mid-burst.  The NMI pushes PC through the switched SP -> the push
; lands in the DATA BUFFER (corruption), and the handler return reads
; data bytes as the return address.  Expected: nmiDelivered >= 1 and the
; run does NOT complete the write cleanly (violation/corruption visible).

	INCLUDE	"st-head.inc"

	; install a minimal NMI handler at 0066h: RETN (EDh 45h).  The push
	; already corrupted the data stream; RETN pops a data word as PC.
	ld	a,0xED
	ld	(0x0066),a
	ld	a,0x45
	ld	(0x0067),a
	; pretend NMI safety is proven (the lie under test)
	ld	a,1
	ld	(UG_NMI_PROFILE),a
	; fill TX with a known pattern
	ld	hl,ST_TX
	ld	bc,64
	ld	e,0x41
.fill:	ld	a,e
	ld	(hl),a
	inc	hl
	inc	e
	dec	bc
	ld	a,b
	or	c
	jr	nz,.fill

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA
	ld	de,UG_ARGBUF
	xor	a
	ld	(de),a
	inc	de
	ld	hl,64
	ld	bc,0
	call	PUT_LE32
	ld	a,UG_OP_ALLOC
	ld	hl,UG_ARGBUF
	ld	bc,5
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	; STACK write: the harness arms the NMI to land inside the burst.
	; The implicit push writes PC through the switched SP -> it lands on
	; ST_TX bytes behind the consume cursor.  After the call the buffer
	; must differ from the written pattern if the hazard is real.
	xor	a
	ld	(UG_OFFSET),a
	ld	(UG_OFFSET+1),a
	ld	(UG_OFFSET+2),a
	ld	(UG_OFFSET+3),a
	ld	hl,(ST_RESP)
	ld	de,ST_TX
	ld	bc,64
	xor	a
	call	UG_WRITE_STACK
	; re-verify the source buffer: two bytes are corrupted by the push
	ld	hl,ST_TX
	ld	bc,64
	ld	e,0x41
.chk:	ld	a,(hl)
	cp	e
	jr	nz,.corrupt
	inc	hl
	inc	e
	dec	bc
	ld	a,b
	or	c
	jr	nz,.chk
	; buffer intact: either no NMI arrived or the push was harmless -
	; in both cases the hazard went UNSEEN, so the test must fail
	call	UG_CLOSE
	jp	st_fail
.corrupt:
	call	UG_CLOSE
	ld	a,0xE5			; named marker: NMI push corrupted data
	ld	(ST_RESULT+3),a
	jp	st_fail

	INCLUDE	"st-tail.inc"
