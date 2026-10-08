; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-respbuf.asm - POSITIVE/negative response-destination coverage.
;   1. INFO with DE=UGREQ.FRAME (caller buffer ALIASES the wire frame):
;      payload "UGS1" starts at FRAME+0 - a nonzero first byte that a
;      status-after-copy implementation would misread as a card error.
;   2. INFO with DE=ST_RESP (distinct destination).
;   3. opcode 7Fh (unassigned) -> nonzero wire status BAD_OPCODE, both
;      destinations.
;   4. ALLOC with IX=exact response size (6) -> exact fit must succeed.
;   5. ALLOC with IX=5 -> OVERFLOW, and NO partial copy may touch the
;      caller buffer (sentinel must survive).
; Expected: exit 0, err=0, errcode fields clean.

	INCLUDE	"st-head.inc"

	xor	a
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,st_failA

	; ---- 1: INFO -> DE=UGREQ.FRAME (alias) ------------------------------
	ld	a,UG_OP_INFO
	ld	hl,UG_ARGBUF
	ld	bc,0
	ld	de,UGREQ.FRAME		; aliased destination (the M2 bug)
	ld	ix,136
	call	UG_RPC
	jp	c,st_failA
	ld	a,(UGREQ.FRAME)		; payload[0] must be 'U', not a status
	cp	0x55
	jp	nz,st_failA
	ld	a,(UGREQ.FRAME+3)
	cp	0x31			; '1' - "UGS1" magic
	jp	nz,st_failA

	; ---- 2: INFO -> DE=ST_RESP (distinct) -------------------------------
	ld	a,UG_OP_INFO
	ld	hl,UG_ARGBUF
	ld	bc,0
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	ld	a,(ST_RESP)
	cp	0x55
	jp	nz,st_failA

	; ---- 3: opcode 7Fh -> BAD_OPCODE status, alias + distinct -----------
	ld	a,0x7F
	ld	hl,UG_ARGBUF
	ld	bc,0
	ld	de,UGREQ.FRAME
	ld	ix,136
	call	UG_RPC
	jp	nc,st_fail		; must fail
	cp	UG_ERR_BAD_OPCODE
	jp	nz,st_failA
	ld	a,0x7F
	ld	hl,UG_ARGBUF
	ld	bc,0
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	nc,st_fail
	cp	UG_ERR_BAD_OPCODE
	jp	nz,st_failA

	; ---- 4: ALLOC, IX=6 exact-fit ----------------------------------------
	ld	de,UG_ARGBUF
	xor	a
	ld	(de),a			; BLOB
	inc	de
	ld	hl,16
	ld	bc,0
	call	PUT_LE32
	ld	a,UG_OP_ALLOC
	ld	hl,UG_ARGBUF
	ld	bc,5
	ld	de,ST_RESP
	ld	ix,6			; exact fit = ALLOC_RESP size
	call	UG_RPC
	jp	c,st_failA
	ld	hl,(ST_RESP)
	ld	(ST_RESULT+4),hl	; keep the handle
	; ---- 5: ALLOC, IX=5 too small -> OVERFLOW, buffer untouched ---------
	ld	a,0xAA
	ld	(ST_RESP),a		; sentinel proves no partial copy
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
	ld	ix,5
	call	UG_RPC
	jp	nc,st_fail		; must fail
	cp	UG_ERR_OVERFLOW
	jp	nz,st_failA
	ld	a,(ST_RESP)
	cp	0xAA			; no byte may have been delivered
	jp	nz,st_failA
	; the card still performed ALLOC #2; capture its handle from the
	; wire frame NOW - later RPCs overwrite UGREQ.FRAME
	ld	hl,(UGREQ.FRAME+2)
	ld	(ST_RESULT+6),hl
	; free the object allocated in step 4
	ld	de,UG_ARGBUF
	ld	hl,(ST_RESULT+4)
	call	PUT_LE16
	ld	a,UG_OP_FREE
	ld	hl,UG_ARGBUF
	ld	bc,2
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	; and free object #2 as well
	ld	de,UG_ARGBUF
	ld	hl,(ST_RESULT+6)
	call	PUT_LE16
	ld	a,UG_OP_FREE
	ld	hl,UG_ARGBUF
	ld	bc,2
	ld	de,ST_RESP
	ld	ix,ST_RESP_CAP
	call	UG_RPC
	jp	c,st_failA
	call	UG_CLOSE
	jp	st_pass

	INCLUDE	"st-tail.inc"