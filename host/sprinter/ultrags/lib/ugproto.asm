; SPDX-License-Identifier: GPL-2.0-or-later
;
; ugproto.asm - Ultra GS public ABI (spec 12.1) over the Sprinter ISA-8
; window.  Every entry point is self-contained: it opens the ISA window
; for one bounded bus operation, then closes it and restores the sampled
; PAGE3/read-back SYSTEM/IFF context.  The window is NEVER held across
; DSS work, frame waits, or between caller operations; a status wait is a
; loop of independently opened/closed poll slices (spec 3.1).
;
;   UG_LIB_INIT    : once per process; initialises the workspace (RAM is
;                    NOT guaranteed zero - caller must run this first)
;   UG_OPEN        : in A=slot, HL=ISA base; config discovery + probe.
;                    CF=1 + A=UG_ERR_* on failure (window always closed)
;   UG_CLOSE       : ends the session; cancels a live transfer first
;   UG_RPC         : in A=opcode(0..7Fh), HL=req payload, BC=req len<=128,
;                    DE=response buffer, IX=response capacity
;                    out CF=0: A=0, BC=payload len (payload at caller buf)
;                        CF=1: A=error (UG_LAST_* set); status!=0 maps to
;                              CF=1/A=status per ABI
;   UG_WRITE       : in HL=handle, DE=buffer, BC=N(1..1024), A=transport,
;                    UG_OFFSET[4]=offset LE -> BEGIN/data-chunks/END
;   UG_READ        : same -> N bytes in buffer after success
;   UG_FRAME_CRC   : in A=0/1 selects FRAME_CRC for subsequent UG_RPC
;   UG_SNAPSHOT    : in HL=128B buffer -> coherent SNAP capture
;   UG_XCTRL       : in A=UG_XC_* control byte -> X_CONTROL write
;   UG_GS_COMMAND  : in HL=9-byte GS descriptor (spec 12.1 layout)
;   UG_WRITE_STACK : explicit METHOD:STACK data phase; refuses UNSAFE_NMI
;                    (no bus access) when the NMI profile is unproven
;                    (spec 11.4/3.1 - DI does not mask NMI)
;
; Wait budgets are bounded loop counts; virtual card time is driven by
; bus traffic.  Public entries preserve IX/IY and restore IFF/MMU/system.

	IFNDEF UGPROTO_INC
	DEFINE UGPROTO_INC

	INCLUDE	"ugmem.inc"
	INCLUDE	"ug_wire.inc"
	INCLUDE	"isa.asm"
	INCLUDE "ugconfig.asm"
	INCLUDE	"ugle.asm"
	INCLUDE	"ugcrc.asm"
	INCLUDE	"ugframe.asm"

; host-private error codes (outside the wire 00h-16h range)
UG_ERR_UNSAFE_NMI EQU 0xF0		; STACK refused: NMI safety unproven

; UG_WAIT_REPLY poll budget: bounded window-poll slices.
; One poll ~= 95 instructions (~0.5K T) -> 0x4000 polls bounds the wait
; to roughly 0.4s at 21MHz and ~1.6M instructions on the pinned core.
UG_WAIT_BUDGET	EQU 0x4000
; GS latch WC/WN poll budget (~0.4s @21MHz)
UG_GS_BUDGET	EQU 0x4000

; conservative pre-measurement ISA chunk (spec 3.1: protected 3.5 MHz ISA, chunk<=8)
UG_CHUNK_DEF	EQU 8
UG_CHUNK_SLOW	EQU 8

; ------------------------------------------------------------ UG_SET_ERR
; in A=error code, B=UG_LAST_SOURCE (0=NONE 1=HOST 2=X 3=GS)
; out CF=1, A=code.  clobbers AF
UG_SET_ERR:
	ld	(UG_LAST_ERROR),a
	ld	a,b
	ld	(UG_LAST_SOURCE),a
	ld	a,(UG_LAST_ERROR)
	scf
	ret

; ------------------------------------------------------------ UG_LIB_INIT
; Zeroes the library state; conservative profile defaults (spec 3.1).
; clobbers AF,BC,HL
UG_LIB_INIT:
	xor	a
	ld	(UGFRAME.CRCF),a
	ld	(UGFRAME.SV),a
	ld	(UG_LAST_ERROR),a
	ld	(UG_LAST_SOURCE),a
	ld	(UG_CURSLOT),a
	ld	(UG_CURBASE),a
	ld	(UG_CURBASE+1),a
	ld	(UG_PROFILE),a
	ld	(UGCTX.ISOPEN),a
	ld	(UGCTX.SESS),a
	ld	(UGXFER.DIR),a
	ld	(UGTM.NOESC),a
	ld	(UG_NMI_PROFILE),a	; UNKNOWN: STACK writes are refused
	ld	(UG_METHOD),a		; 0 = FIXED
	ld	(UG_ALIASCFG),a
	ld	(UG_ALIASCFG+1),a
    IFDEF UG_FILE_WINDOW
    DEFINE UG_PAYLOAD_CAP UG_FILE_WINDOW
    ELSE
    IFDEF UG_EXPERIMENT_WINDOW
    DEFINE UG_PAYLOAD_CAP UG_EXPERIMENT_WINDOW
    ENDIF
    ENDIF
    IFDEF UG_PAYLOAD_CAP
    ASSERT UG_PAYLOAD_CAP == 8 || UG_PAYLOAD_CAP == 64 || UG_PAYLOAD_CAP == 256
    ld hl,UG_PAYLOAD_CAP
    ld (UG_CHUNK),hl
    ELSE
	ld	a,UG_CHUNK_SLOW
	ld	(UG_CHUNK),a
	xor	a
	ld	(UG_CHUNK+1),a
    ENDIF
	ret

; A=1: 21MHz, A=2: 3.5MHz, anything else: unknown/conservative.
; Call after a CPU mode change, outside a transfer. Unknown resets METHOD
; to FIXED; no profile claims physical wait-state timing before REAL S1.
UG_CPU_PROFILE:
	ld	b,a
	ld	a,(UGXFER.DIR)
	or	a
	jr	z,.idle
	ld	a,UG_ERR_BUSY
	ld	b,1
	jp	UG_SET_ERR
.idle:
	ld	a,b
	cp	1
	ld	hl,UG_CHUNK_DEF
	jr	z,.store
	cp	2
	ld	hl,UG_CHUNK_SLOW
	jr	z,.store
	xor	a
	ld	(UG_METHOD),a
.store:
	ld	(UG_PROFILE),a
	ld	(UG_CHUNK),hl
	xor	a
	ret

; Always cap the actual window, including caller-supplied profiles.
; out BC=1..cap; clobbers AF. Zero/oversized chunks use the compiled cap.
; Public default is eight; file apps use 256 (same clocks and data loops).
UG_SAFE_CHUNK:
    IFDEF UG_PAYLOAD_CAP
    ld bc,(UG_CHUNK)
    ld a,b
    or c
    jr z,.cap
    push hl
    ld hl,UG_PAYLOAD_CAP
    or a
    sbc hl,bc
    pop hl
    ret nc
.cap:
    ld bc,UG_PAYLOAD_CAP
    ret
    ELSE
	ld bc,(UG_CHUNK)
	ld a,b
	or a
	jr nz,.cap
	ld a,c
	dec a
	cp 8
	ret c
.cap:
	ld bc,8
	ret
    ENDIF

; ------------------------------------------------- internal window helper
; UG_WIN_OPEN: open the ISA window on the SESSION slot/base.
; Central session gate: without an established session (UGCTX.SESS==0)
; the call fails BEFORE loading CURSLOT/CURBASE or touching any hardware,
; so public entries that funnel through here (UG_SNAPSHOT, UG_XCTRL,
; UG_POLL_STATUS, the UG_GS_* primitives behind UG_GS_COMMAND) cannot
; drive ISA at base 0000h.  UG_OPEN uses UG_ISA_OPEN directly and is
; unaffected.  A failed open leaves UGCTX.ISOPEN==0, so error paths that
; then call UG_ISA_CLOSE stay no-ops (it refuses when not open).
; out CF=0 open; CF=1 A=err (UG_ERR_STATE no session / propagates
; UG_ISA_OPEN's defined error)
UG_WIN_OPEN:
	ld	a,(UGCTX.SESS)
	or	a
	jr	nz,.sess
	ld	a,UG_ERR_STATE
	ld	b,1			; HOST: missing session is a host-side
	jp	UG_SET_ERR		; lifecycle violation, not a card fault
.sess:	ld	a,(UG_CURSLOT)
	ld	hl,(UG_CURBASE)
	call	UG_ISA_OPEN
	ret	nc
	ld	b,1			; HOST: window-open failure is host-side
	jp	UG_SET_ERR		; bookkeeping is public ABI (spec 12.1)

; ------------------------------------------------------------ UG_OPEN
; in : A = ISA slot (0/1), HL = ISA base
; out: CF=0 session open (window closed again); CF=1 A=error:
;        BAD_ARGUMENT slot>1 | STATE session already open |
;        TIMEOUT no card answers config magic | STATE wrong fw mode/API
; Spec 5 ordering: common-config discovery (magic -> protocol -> E4
; FW_ACTIVE=8) completes BEFORE the first BASE register access.
; clobbers AF,BC,DE,HL
UG_OPEN:
	ld	b,a			; slot
	; reject invalid slot before any hardware write
	cp	UG_MAX_SLOT+1
	jp	c,.slotok
	ld	a,UG_ERR_BAD_ARGUMENT
	ld	b,1
	jp	UG_SET_ERR
.slotok:
	; refuse a nested session
	ld	a,(UGCTX.SESS)
	or	a
	jr	z,.nosess
	ld	a,UG_ERR_STATE
	ld	b,1
	jp	UG_SET_ERR
.nosess:
	ld	a,b			; slot back
	call	UG_ISA_OPEN		; validates slot again (defensive)
	jp	c,.open_fail
    call UG_ISA_CLOSE
    xor a ; CMD_MAGIC=00, magic is DATA_HIGH, CONTROL echoes selector
    call UG_CFG_READ8
    jp c,.open_fail
    cp UG_CFG_MAGIC_BYTE
    jr nz,.absent
    ld a,UG_CFG_SEL_PROTOCOL
    call UG_CFG_READ8
    jp c,.open_fail
    cp UG_CFG_PROTOCOL_VER
    jr nz,.wrongmode
    ld a,UG_CFG_SEL_FW_ACTIVE
    call UG_CFG_READ8
    jp c,.open_fail
    cp 8
    jr nz,.wrongmode
    ld a,UG_CFG_SEL_UG_ALIAS
    call UG_CFG_READ16
    jp c,.open_fail
    ld (UG_ALIASCFG),hl
    call UG_CFG_OPEN
	; --- only now may BASE registers be touched ---
	ld	a,UG_REG_API_MAJOR
	call	UG_REG_R
	cp	1
	jr	nz,.wrongmode
	ld	a,UG_REG_API_MINOR
	call	UG_REG_R
	or	a
	jr	nz,.wrongmode		; minor must be 0
	; session established; drop the window
	call	UG_ISA_CLOSE
	ld	a,1
	ld	(UGCTX.SESS),a
	ld	a,(UGCTX.SLOT)
	ld	(UG_CURSLOT),a
	ld	hl,(UGCTX.BASE)
	ld	a,l
	ld	(UG_CURBASE),a		; low byte of BASE, not the slot
	ld	a,h
	ld	(UG_CURBASE+1),a
	xor	a
	ld	(UG_LAST_ERROR),a
	ld	(UG_LAST_SOURCE),a
	ret
.absent:
	call	UG_ISA_CLOSE
	ld	a,UG_ERR_TIMEOUT
	ld	b,1			; HOST detected: nothing answered
	jp	UG_SET_ERR
.wrongmode:
	call	UG_ISA_CLOSE
	ld	a,UG_ERR_STATE
	ld	b,1
	jp	UG_SET_ERR
.open_fail:
	; ISA_OPEN failed before changing hardware; A=err already
	ld	b,1
	jp	UG_SET_ERR

; ------------------------------------------------------------ UG_CLOSE
; Ends the session.  Cancels a live transfer first (best-effort framed
; TRANSFER_CANCEL), then makes sure the window is closed and context
; restored.  out CF=0.  clobbers AF,BC,DE,HL; preserves IX
UG_CLOSE:
	push	ix
	ld	a,(UGXFER.DIR)
	or	a
	jr	z,.noxfer
	call	UG_XFER_CANCEL		; framed cancel of UGXFER.ID
.noxfer:
	ld	a,(UGCTX.ISOPEN)
	or	a
	call	nz,UG_ISA_CLOSE
	xor	a
	ld	(UGCTX.SESS),a
	pop	ix
	ret

; ------------------------------------------------- UG_POLL_STATUS (wait)
; One bounded poll slice: open window, sample X_STATUS, close/restore.
; out CF=0 -> A=X_STATUS; CF=1 -> A=window error
; clobbers AF,BC,HL
UG_POLL_STATUS:
	call	UG_WIN_OPEN
	ret	c
	ld	a,UG_REG_X_STATUS
	call	UG_REG_R
	push	af
	call	UG_ISA_CLOSE
	pop	af
	or	a			; CF=0
	ret

; ------------------------------------------------------------ UG_XCTRL
; Public control write: in A=UG_XC_* -> X_CONTROL in one bounded window.
; out CF=0 done; CF=1 A=err (STATE when no session).  clobbers AF,BC,HL
UG_XCTRL:
	ld	(UGREQ.GPRE),a		; operand survives the window open
	call	UG_WIN_OPEN
	ret	c			; propagate CF=1/A=err (no session: no HW)
	ld	a,(UGREQ.GPRE)
	ld	e,UG_REG_X_CONTROL
	call	UG_REG_W
	call	UG_ISA_CLOSE
	xor	a
	ret

; ------------------------------------------------------------ UG_RPC
; in : A=opcode(0..7Fh), HL=req payload, BC=req len<=128,
;      DE=response buffer, IX=response capacity
; out: CF=0 -> A=0, BC=actual payload len, HL=caller buffer
;      CF=1 -> A=error code (wire status maps to CF=1/A=status, src=X)
; clobbers AF,BC,DE,HL; IX/IY preserved (capacity copied out of IX)
UG_RPC:
	bit	7,a
	jp	nz,.badop
	ld	(UGREQ.OP),a
	ld	a,b
	or	a
	jp	nz,.badlen		; len must fit in u8 first
	ld	a,c
	cp	UG_MAX_PAYLOAD+1
	jp	nc,.badlen		; and be <= 128
	ld	a,(UGCTX.SESS)
	or	a
	jp	z,.notopen
	; stash caller response destination (IX must survive the call)
	ld	a,e
	ld	(UGREQ.PTR),a
	ld	a,d
	ld	(UGREQ.PTR+1),a
	push	ix
	pop	de			; DE = caller capacity (IX intact)
	ld	a,e
	ld	(UGREQ.CAP),a
	ld	a,d
	ld	(UGREQ.CAP+1),a
	; build the frame while the window is closed (pure RAM work)
	ld	de,UGREQ.FRAME
	ld	a,(UGREQ.OP)
	call	UG_BUILD_FRAME		; BC = total frame bytes
	jp	c,.badframe
	push	bc			; frame len across the window open
    IFDEF UG_DSS_TIMED
    call UG_WAIT_START
    ENDIF
	; READY is required before the FIRST byte. An old response must not
	; be mistaken for this call's result or replay a non-idempotent RPC.
	ld	hl,UG_WAIT_BUDGET
.ready_wait:
	push	hl
	call	UG_POLL_STATUS
	pop	hl
	jr	c,.ready_winfail
	bit	0,a
	jr	nz,.ready
    IFDEF UG_DSS_TIMED
    bit 1,a
    jr nz,.busy_unowned
    bit 2,a
    jr nz,.busy_unowned
    ELSE
	bit	2,a
	jr	nz,.stale_reply
    ENDIF
	bit	5,a
	jr	nz,.ready_fault
    IFDEF UG_DSS_TIMED
    call UG_WAIT_NEXT
    jr nc,.ready_wait
    pop bc
    ld b,1
    jp UG_SET_ERR
.busy_unowned:
    pop bc
    ld a,UG_ERR_BUSY
    ld b,2
    jp UG_SET_ERR
    ELSE
	dec	hl
	ld	a,h
	or	l
	jr	nz,.ready_wait
    ENDIF
	pop	bc
	jp	.timeout
.ready_winfail:
	pop	bc
	ret				; failed open never owns an ISA window
.stale_reply:
	pop	bc
	ld	a,UG_XC_TRANSPORT_RESET
	call	UG_XCTRL
	ld	a,UG_ERR_STATE
	ld	b,1
	jp	UG_SET_ERR
.ready_fault:
	pop	bc
	jp	.xerr_read
.ready:
	; ---- send window (bounded) ----
	call	UG_WIN_OPEN
	jp	c,.send_failpop
	ld	hl,UGREQ.FRAME
	pop	bc
	call	UG_REQ_WRITE
	call	UG_ISA_CLOSE
	; ---- wait: a loop of independently opened/closed status reads ----
	ld	hl,UG_WAIT_BUDGET
.wait:	push	hl
	call	UG_POLL_STATUS
	jp	c,.poll_winfail
	bit	2,a			; REPLY first: an error response still
					; arrives as a consumable REPLY frame
	jr	nz,.have_reply
    ; X_ERROR is sticky in every profile. BUSY denotes a legitimate EXEC,
    ; so a prior error cannot cancel a new RPC before its reply is ready.
    bit 1,a
    jr nz,.executing
	bit	5,a			; XERR in a non-EXEC/no-REPLY state = framing fault
	jp	nz,.xerr
.executing:
	pop	hl
    IFDEF UG_DSS_TIMED
    call UG_WAIT_NEXT
    jr nc,.wait
    push af
    ld a,UG_XC_TRANSPORT_RESET
    call UG_XCTRL
    pop af
    ld b,1
    jp UG_SET_ERR
    ELSE
	dec	hl
	ld	a,h
	or	l
	jp	z,.timeout
    ENDIF
	jr	.wait
.have_reply:
	pop	hl
	; ---- receive window (bounded) ----
	call	UG_WIN_OPEN
	jp	c,.recv_winfail
	ld	de,UGREQ.FRAME		; header+payload+trailer contiguous
	ld	bc,2
	call	UG_RESP_READ
	ld	a,(UGREQ.FRAME+1)	; payload len on the wire
	cp	UG_MAX_PAYLOAD+1
	jr	c,.lenok
	; malformed length: drain the announced bytes + trailer, reset
	ld	b,0
	ld	c,a
	call	UG_RESP_SKIP
	ld	a,(UGFRAME.CRCF)
	or	a
	jr	z,.drained
	ld	bc,4
	call	UG_RESP_SKIP
.drained:
	ld	e,UG_REG_X_CONTROL
	ld	a,UG_XC_TRANSPORT_RESET
	call	UG_REG_W
	call	UG_ISA_CLOSE
	ld	a,UG_ERR_LENGTH
	ld	b,1			; HOST: malformed wire frame is a
	jp	UG_SET_ERR		; transport failure, not a card status
.lenok:	ld	c,a
	ld	b,0
	ld	(UGREQ.LEN),bc
	; payload into scratch right after the header
	ld	de,UGREQ.FRAME+2
	call	UG_RESP_READ
	ld	a,(UGFRAME.CRCF)
	or	a
	jr	z,.recv_done
	; trailer lands contiguously at FRAME+2+len
	ld	hl,(UGREQ.LEN)
	ld	de,UGREQ.FRAME+2
	add	hl,de
	ex	de,hl
	ld	bc,4
	call	UG_RESP_READ
.recv_done:
	call	UG_ISA_CLOSE
	; ---- verify CRC trailer if the request asked for it ----
	ld	a,(UGFRAME.CRCF)
	or	a
	jr	z,.capcheck
	ld	hl,UGREQ.FRAME
	ld	bc,(UGREQ.LEN)
	inc	bc
	inc	bc			; status+len+payload
	call	UG_CRC32		; -> UGCRC.OUT
	ld	hl,(UGREQ.LEN)
	ld	de,UGREQ.FRAME+2
	add	hl,de			; HL -> stored trailer
	ld	a,(UGCRC.OUT)
	cp	(hl)
	jp	nz,.badcrc
	inc	hl
	ld	a,(UGCRC.OUT+1)
	cp	(hl)
	jp	nz,.badcrc
	inc	hl
	ld	a,(UGCRC.OUT+2)
	cp	(hl)
	jp	nz,.badcrc
	inc	hl
	ld	a,(UGCRC.OUT+3)
	cp	(hl)
	jp	nz,.badcrc
.capcheck:
	; response must fit the caller's IX capacity; len==cap is legal
	ld	hl,(UGREQ.CAP)
	ld	de,(UGREQ.LEN)
	or	a
	sbc	hl,de			; cap - len
	jr	c,.toobig		; cap < len: never write past buffer
	; save the wire status BEFORE the payload copy: the caller's
	; destination may alias UGREQ.FRAME itself (UG_WRITE/UG_READ use it
	; as their scratch), and the copy would overwrite FRAME[0] with the
	; first payload byte, faking a status like BAD_OPCODE
	ld	a,(UGREQ.FRAME)
	ld	(UGREQ.ST),a
	; deliver payload to caller buffer
	ld	bc,(UGREQ.LEN)
	ld	a,b
	or	c
	jr	z,.status
	ld	hl,UGREQ.FRAME+2
	ld	de,(UGREQ.PTR)
	ldir
.status:
	ld	a,(UGREQ.ST)		; saved wire status byte
	or	a
	jr	z,.okout
	; nonzero card status -> CF=1, A=status, source X (spec 12.1)
	ld	b,2
	jp	UG_SET_ERR
.okout:	ld	bc,(UGREQ.LEN)
	ld	hl,(UGREQ.PTR)
	xor	a			; CF=0, A=0
	ret
.toobig:
	; too-small capacity: reject WITHOUT any partial copy (the wire
	; frame stays in scratch; the caller buffer is untouched), then
	; drain/reset the transport and fail honestly
	call	UG_WIN_OPEN
	jr	c,.toobig_done		; cannot reopen: still report overflow
	ld	e,UG_REG_X_CONTROL
	ld	a,UG_XC_TRANSPORT_RESET
	call	UG_REG_W
	call	UG_ISA_CLOSE
.toobig_done:
	ld	a,UG_ERR_OVERFLOW
	ld	b,1
	jp	UG_SET_ERR
.xerr:
	pop	hl
.xerr_read:
	; fault without a reply: read X_ERROR in a fresh bounded window
	call	UG_WIN_OPEN
	jr	c,.xerr_winfail
	ld	a,UG_REG_X_ERROR
	call	UG_REG_R
	push	af
	call	UG_ISA_CLOSE
	pop	af
	push	af
	ld	a,UG_XC_TRANSPORT_RESET
	call	UG_XCTRL
	pop	af
	ld	b,2
	jp	UG_SET_ERR
.xerr_winfail:
	ld	a,UG_ERR_TIMEOUT
	ld	b,1			; HOST: could not even open the
	jp	UG_SET_ERR		; window - nothing card-side reported
.timeout:
	; no reply inside the bounded wait; reset the wedged transport
	call	UG_WIN_OPEN
	jr	c,.timeout2
	ld	e,UG_REG_X_CONTROL
	ld	a,UG_XC_TRANSPORT_RESET
	call	UG_REG_W
	call	UG_ISA_CLOSE
.timeout2:
	ld	a,UG_ERR_TIMEOUT
	ld	b,1			; HOST: wait budget expired - the
	jp	UG_SET_ERR		; card never produced a status byte
.badcrc:
	ld	a,UG_XC_TRANSPORT_RESET
	call	UG_XCTRL
	ld	a,UG_ERR_CRC
	ld	b,1			; HOST: received trailer failed the
	jp	UG_SET_ERR		; local CRC - host transport failure
.poll_winfail:
	pop	hl			; balance the pushed budget
	ld	b,1			; HOST: poll window open failed
	jp	UG_SET_ERR
.recv_winfail:
	ld	b,1			; HOST: receive window open failed
	jp	UG_SET_ERR
.send_failpop:
	pop	bc
	ld	b,1
	jp	UG_SET_ERR
.badframe:
.badop:	ld	a,UG_ERR_BAD_ARGUMENT
	ld	b,1
	jp	UG_SET_ERR
.badlen:
	ld	a,UG_ERR_LENGTH
	ld	b,1
	jp	UG_SET_ERR
.notopen:
	ld	a,UG_ERR_STATE
	ld	b,1
	jp	UG_SET_ERR

; ------------------------------------------------- UG_XFER_CANCEL (int.)
; best-effort framed TRANSFER_CANCEL for UGXFER.ID; clears DIR.
; clobbers AF,BC,DE,HL; preserves IX
UG_XFER_CANCEL:
	push	ix
    ld hl,(UGREQ.LEN)             ; retain the failed response diagnostics
    push hl
	ld	a,(UGTM.NOESC)
	push	af
	ld	a,1
	ld	(UGTM.NOESC),a
	ld	a,(UG_LAST_ERROR)
	push	af
	ld	a,(UG_LAST_SOURCE)
	push	af
	ld	a,(UGCTX.SESS)
	or	a
	jr	z,.xc_out
	ld	a,(UGXFER.DIR)
	or	a
	jr	z,.xc_out
	ld	de,UG_ARGBUF
	ld	hl,(UGXFER.ID)
	call	PUT_LE16
	ld	hl,(UGXFER.ID+2)
	call	PUT_LE16
	ld	a,UG_OP_TRANSFER_CANCEL
	ld	hl,UG_ARGBUF
	ld	bc,4
	ld	de,UGREQ.FRAME
	ld	ix,136
	call	UG_RPC			; best effort, result ignored
	jr	nc,.cancelled
	ld	a,UG_XC_TRANSFER_CANCEL	; release an owned grant even if
	call	UG_XCTRL		; its END/cancel response was lost
.cancelled:
	xor	a
	ld	(UGXFER.DIR),a
.xc_out:
	pop	af
	ld	(UG_LAST_SOURCE),a
	pop	af
	ld	(UG_LAST_ERROR),a
	pop	af
	ld	(UGTM.NOESC),a
    pop hl
    ld (UGREQ.LEN),hl
	pop	ix
	ret

; ------------------------------------------------- UG_XFER_SAVE (int.)
; Stash the public UG_WRITE/UG_READ inputs into the workspace.
; in : DE=buffer, BC=N, A=transport; HL=handle is left untouched.
; out: fields set; clobbers AF only
UG_XFER_SAVE:
	ld	(UGXFER.TRANS),a
	ld	a,e
	ld	(UGXFER.BUF),a
	ld	a,d
	ld	(UGXFER.BUF+1),a
	ld	a,c
	ld	(UGXFER.N),a
	ld	a,b
	ld	(UGXFER.N+1),a
	xor	a
	ld	(UGXFER.SENT),a
	ld	(UGXFER.SENT+1),a
	ld	(UGXFER.DIR),a
    ld (UGXFER.STAGE),a
    ld a,255
    ld (UGXFER.KEYHI),a
	ret

; ------------------------------------------- UG_XFER_VALIDATE (int.)
; in : A=transport, BC=N; requires SESS.  Defined errors only, no ISA.
;      Only BULK transports implemented here: 00h FAST / 80h VERIFIED.
; out: CF=0 ok; CF=1 A=err
UG_XFER_VALIDATE:
    and 0x7E
    jr nz,.badarg
.t_ok:
	ld	a,(UGCTX.SESS)
	or	a
	jr	z,.notopen
	; N in 1..UG_MAX_BLOCK(1024)
	ld	a,b
	cp	(UG_MAX_BLOCK>>8)+1	; B must be <= 4
	jr	nc,.badlen
	cp	UG_MAX_BLOCK>>8
	jr	nz,.bok			; B<4 -> N<=0x3FF fine
	ld	a,c
	or	a
	jr	nz,.badlen		; B==4 requires C==0
.bok:	ld	a,b
	or	c
	jr	z,.badlen		; N=0 rejected
	or	a			; CF=0
	ret
.badarg:
	ld	a,UG_ERR_BAD_ARGUMENT
	ld	b,1
	jp	UG_SET_ERR
.notopen:
	ld	a,UG_ERR_STATE
	ld	b,1
	jp	UG_SET_ERR
.badlen:
	ld	a,UG_ERR_LENGTH
	ld	b,1
	jp	UG_SET_ERR

; -------------------------------------------- UG_METHOD_GATE (int.)
; Apply the write-method policy before any bus access.
;   METHOD 0   FIXED      -> always
;   METHOD 0FFh ALL       -> FIXED here; STACK is skipped when NMI-unsafe
;   METHOD 1   ALIAS      -> requires configured alias else STATE
;   METHOD 2   STACK      -> requires UG_NMI_PROFILE=1 else UNSAFE_NMI,
;                            WITHOUT touching the bus (spec 11.4)
; out: CF=0 ok; CF=1 A=err
UG_METHOD_GATE:
	ld	a,(UG_METHOD)
	or	a
	ret	z			; FIXED
	inc	a
	ret	z			; ALL -> FIXED body
	dec	a
	cp	1
	jr	z,.alias
	cp	2
	jr	nz,.bad
	; explicit STACK: the switched-SP window needs a proven NMI profile;
	; DI does not mask NMI and an unproven window is refused outright
	ld	a,(UG_NMI_PROFILE)
	cp	1
	jr	nz,.unsafe
	or	a
	ret				; proven: STACK chunk writer is used
.alias:
	ld	hl,(UG_ALIASCFG)
	ld	a,h
	and	l
	inc	a
	ret	nz			; != FFFFh -> configured, ALIAS writer
	ld	a,UG_ERR_STATE		; explicit ALIAS without configuration
	ld	b,1
	jp	UG_SET_ERR
.unsafe:
	ld	a,UG_ERR_UNSAFE_NMI
	ld	b,1
	jp	UG_SET_ERR
.bad:	ld	a,UG_ERR_BAD_ARGUMENT
	ld	b,1
	jp	UG_SET_ERR

; ------------------------------------------------------------ UG_WRITE
; in : HL = object handle, DE = data buffer, BC = N (1..UG_MAX_BLOCK),
;      A  = transport (UG_TRANSPORT_BULK_FAST/_VERIFIED),
;      UG_OFFSET[4] = object offset LE, UG_METHOD selects write method
; out: CF=0 committed; CF=1 A=error (live grant cancelled best-effort)
; Per spec 12.3.2: BEGIN (one RPC) -> N bytes in chunks, each chunk an
; independently opened/closed bounded ISA window of <=UG_CHUNK bytes ->
; END.  VERIFIED (bit7) computes the host block CRC and appends it to
; the 13-byte BEGIN request (spec 6.3).  Chunk writers: FIXED byte FIFO,
; ALIAS via the configured 32-byte alias window, STACK switched-SP burst
; (only reached with UG_NMI_PROFILE=1).
; clobbers AF,BC,DE,HL; IX/IY preserved
UG_WRITE:
	push	ix			; preserve caller IX through RPCs
	push	hl			; handle
	call	UG_XFER_SAVE
	call	UG_METHOD_GATE		; before any bus access
	jp	c,.w_done_fail
	ld	a,(UGXFER.TRANS)
	ld	bc,(UGXFER.N)
	call	UG_XFER_VALIDATE
	jp	c,.w_done_fail
    IFDEF UG_BENCH_TIMING
    call BENCH_SETUP
    ENDIF
	; ---- BEGIN request into ARG buffer ----
	ld	de,UG_ARGBUF
	pop	hl			; handle
	push	hl
	call	PUT_LE16
	ld	hl,(UG_OFFSET)
	call	PUT_LE16
	ld	hl,(UG_OFFSET+2)
	call	PUT_LE16
	ld	hl,(UGXFER.N)
	call	PUT_LE16
	ld	a,(UGXFER.TRANS)
	ld	(de),a
	inc	de
	ld	bc,9
	; VERIFIED: append host-computed CRC32 of the block (13-byte req)
	bit	7,a
	jr	z,.begin
	push	bc
	push	de
	ld	hl,(UGXFER.BUF)
	ld	bc,(UGXFER.N)
	call	UG_CRC32		; -> UGCRC.OUT
	pop	de
	pop	bc
	push	bc
	ld	hl,(UGCRC.OUT)
	call	PUT_LE16
	ld	hl,(UGCRC.OUT+2)
	call	PUT_LE16
	pop	bc
	ld	c,13
.begin:
    ld a,1                       ; WRITE_BEGIN, retained across cleanup RPCs
    ld (UGXFER.STAGE),a
	ld	a,UG_OP_WRITE_BEGIN
	ld	hl,UG_ARGBUF
	ld	de,UGREQ.FRAME
	ld	ix,136
	call	UG_RPC
	jp	c,.w_fail		; A=err already set
	ld	a,b
	or	a
	jp	nz,.w_badreply
	ld	a,c
	cp	4
	jp	nz,.w_badreply
	; token -> UGXFER.ID (+ UGREQ.TOKEN shadow for preservation check)
	; (RPC copied the payload to our caller buffer = UGREQ.FRAME+0)
	ld	hl,(UGREQ.FRAME)
	ld	(UGXFER.ID),hl
	ld	(UGREQ.TOKEN),hl
	ld	hl,(UGREQ.FRAME+2)
	ld	(UGXFER.ID+2),hl
	ld	(UGREQ.TOKEN+2),hl
	ld	a,1
	ld	(UGXFER.DIR),a
    ld a,2                       ; write grant gate
    ld (UGXFER.STAGE),a
	; ---- grant gate: WRITE_GRANT must be advertised before data ----
	call	UG_WIN_OPEN
	jp	c,.w_fail
	ld	a,UG_REG_X_STATUS
	call	UG_REG_R
	and	UG_XS_WRITE_GRANT
	push	af
	call	UG_ISA_CLOSE
	pop	af
	jp	z,.w_nogrant
    ld a,3                       ; write payload / GS latch wait
    ld (UGXFER.STAGE),a
    IFDEF UG_BENCH_TIMING
    call BENCH_PAYLOAD
    ENDIF
    ld a,(UGXFER.TRANS)
    bit 0,a
    jr z,.w_loop
    call UG_SLOW_DATA
    jp c,.w_fail
    jp .w_data_done
	; ---- data: N bytes as <=UG_CHUNK bounded windows ----
.w_loop:
    IFDEF UG_DSS_TIMED
    call UG_BULK_YIELD
    jp c,.w_fail
    ENDIF
	ld	hl,(UGXFER.N)
	ld	de,(UGXFER.SENT)
	or	a
	sbc	hl,de			; HL = remaining
	jr	z,.w_data_done
	; k = min(UG_CHUNK, remaining), and ALIAS caps at 32 (window size)
	call	UG_SAFE_CHUNK
	or	a
	sbc	hl,bc			; remaining - chunk
	jr	nc,.w_usechunk		; remaining>=chunk -> k=BC
	add	hl,bc			; restore remaining
	ld	b,h
	ld	c,l			; k = remaining
.w_usechunk:				; BC = k
	ld	a,(UG_METHOD)
	cp	1
	jr	nz,.w_pushek
	; ALIAS: chunk is capped at the 32-byte window
	ld	a,b
	or	a
	jr	nz,.w_cap32		; k >= 256 -> cap
	ld	a,c
	cp	33
	jr	c,.w_pushek		; k <= 32 already
.w_cap32:
	ld	bc,32
.w_pushek:
	push	bc
	call	UG_WIN_OPEN
	jp	c,.w_failpop
    IFDEF UG_EXPERIMENT_TURBO_WRITE
    ; Explicit experimental binary only. Request/config/GS/read windows
    ; retain Turbo off. No ISA reads occur before this window is closed.
    ld bc,UG_PORT_SYS_RAM
    ld a,3
    out (c),a
    ENDIF
	ld	hl,(UGXFER.BUF)
	ld	de,(UGXFER.SENT)
	add	hl,de			; src = buf + sent
	pop	bc			; k
	push	bc
	ld	a,(UG_METHOD)
	cp	1
	jr	z,.w_awr
	cp	2
	jr	nz,.w_fwr
	call	UG_BULK_WRITE_STACK	; switched-SP burst (NMI-safe only)
	jr	.w_wd
.w_awr:	call	UG_BULK_WRITE_ALIAS	; LDIR into the alias window
	jr	.w_wd
.w_fwr:	call	UG_BULK_WRITE		; FIXED single-FIFO loop
.w_wd:	call	UG_ISA_CLOSE
	pop	bc
	ld	hl,(UGXFER.SENT)
	add	hl,bc
	ld	(UGXFER.SENT),hl
	jr	.w_loop
.w_data_done:
	; token preservation invariant: UGREQ.TOKEN untouched by data phase
	ld	hl,(UGXFER.ID)
	ld	de,(UGREQ.TOKEN)
	or	a
	sbc	hl,de
	jr	nz,.w_internal
	ld	hl,(UGXFER.ID+2)
	ld	de,(UGREQ.TOKEN+2)
	or	a
	sbc	hl,de
	jr	nz,.w_internal
	; ---- END ----
    ld a,4
    ld (UGXFER.STAGE),a
	xor	a
	call	UG_XFER_END
	jp	c,.w_fail
	xor	a
	ld	(UGXFER.DIR),a
    IFDEF UG_BENCH_TIMING
    call BENCH_FINISH
    ENDIF
	pop	hl
	pop	ix
	ret
.w_nogrant:
	ld	a,UG_ERR_STATE
	ld	b,1
	call	UG_SET_ERR
	jr	.w_fail
.w_badreply:
	call	UG_BAD_BEGIN
	jr	.w_fail
.w_internal:
	ld	a,UG_ERR_INTERNAL
	ld	b,1
	call	UG_SET_ERR
	jr	.w_fail
.w_failpop:
	pop	bc			; balance chunk push
.w_fail:
	; rollback: best-effort cancel of the live grant, then report
	push	af
	call	UG_XFER_CANCEL
	pop	af
	scf				; keep CF=1 (cancel may clobber)
.w_done_fail:
	pop	hl
	pop	ix
	ret

; ------------------------------------------- UG_XFER_END (int.)
; framed END for UGXFER.ID.
; in : A=0 -> WRITE_END; nz -> READ_END (VERIFIED appends host_crc)
; out: CF=0 ok; CF=1 A=err
UG_XFER_END:
    IFDEF UG_BENCH_TIMING
    call BENCH_END
    ENDIF
	push	ix
	push	af
	ld	de,UG_ARGBUF
	ld	hl,(UGXFER.ID)
	call	PUT_LE16
	ld	hl,(UGXFER.ID+2)
	call	PUT_LE16
	ld	bc,4
	pop	af
	or	a			; test A itself: pop af restores stale F
	jr	z,.endw			; write end: 4B request, no host crc
	; read end: VERIFIED appends host-computed crc of received bytes
	ld	a,(UGXFER.TRANS)
	bit	7,a
	jr	z,.rend
	push	bc
	ld	hl,(UGXFER.BUF)
	ld	bc,(UGXFER.N)
	call	UG_CRC32
	pop	bc
    push bc
    push de
    ld hl,UGCRC.OUT
    ld de,UGXFER.CRC
    ld b,4
.checkcrc:
    ld a,(de)
    cp (hl)
    jr nz,.readcrc_bad
    inc hl
    inc de
    djnz .checkcrc
    pop de
    pop bc
	ld	hl,(UGCRC.OUT)
	call	PUT_LE16
	ld	hl,(UGCRC.OUT+2)
	call	PUT_LE16
	ld	bc,8
.rend:	ld	a,UG_OP_READ_END
	jr	.doend
.endw:	ld	a,UG_OP_WRITE_END
.doend:	ld	hl,UG_ARGBUF
	ld	de,UGREQ.FRAME
	ld	ix,136
	call	UG_RPC
	jr	c,.done
	ld	a,b
	or	c
	jr	z,.done			; successful END must have empty payload
	call	UG_BAD_BEGIN
.done:
	pop	ix
	ret
.readcrc_bad:
    pop de
    pop bc
    ld a,UG_ERR_CRC
    ld b,1
    call UG_SET_ERR
    jr .done

; ------------------------------------------------------------ UG_READ
; Same signature as UG_WRITE.  READ_BEGIN -> chunks -> READ_END.
; VERIFIED: card returns the block CRC in BEGIN resp (stored UGXFER.CRC)
; and the host's own CRC of received bytes goes in the 8-byte END req.
UG_READ:
	push	ix
	push	hl			; handle
	call	UG_XFER_SAVE
	ld	a,(UGXFER.TRANS)
	ld	bc,(UGXFER.N)
	call	UG_XFER_VALIDATE
	jp	c,.r_done_fail
    ld a,(UGXFER.TRANS)
    bit 0,a
    jr nz,.r_methodok
    ld a,(UG_METHOD)
    cp 2
    jr nz,.r_gate
    ld a,UG_ERR_BAD_ARGUMENT
    ld b,1
    call UG_SET_ERR
    jp .r_done_fail
.r_gate:
    call UG_METHOD_GATE
    jp c,.r_done_fail
.r_methodok:
    IFDEF UG_BENCH_TIMING
    call BENCH_SETUP
    ENDIF
	; BEGIN req (no host crc ever - spec 6.3)
	ld	de,UG_ARGBUF
	pop	hl
	push	hl
	call	PUT_LE16
	ld	hl,(UG_OFFSET)
	call	PUT_LE16
	ld	hl,(UG_OFFSET+2)
	call	PUT_LE16
	ld	hl,(UGXFER.N)
	call	PUT_LE16
	ld	a,(UGXFER.TRANS)
	ld	(de),a
	inc	de
    ld a,5                       ; READ_BEGIN
    ld (UGXFER.STAGE),a
	ld	a,UG_OP_READ_BEGIN
	ld	hl,UG_ARGBUF
	ld	bc,9
	ld	de,UGREQ.FRAME
	ld	ix,136
	call	UG_RPC
	jp	c,.r_fail
	ld	a,b
	or	a
	jp	nz,.r_badreply
	ld	a,(UGXFER.TRANS)
	bit	7,a
	ld	a,4
	jr	z,.r_checklen
	ld	a,8
.r_checklen:
	cp	c
	jp	nz,.r_badreply
	ld	hl,(UGREQ.FRAME)
	ld	(UGXFER.ID),hl
	ld	(UGREQ.TOKEN),hl
	ld	hl,(UGREQ.FRAME+2)
	ld	(UGXFER.ID+2),hl
	ld	(UGREQ.TOKEN+2),hl
	; VERIFIED card crc lands at payload+4 (fields: transfer u32, crc u32)
	ld	a,(UGXFER.TRANS)
	bit	7,a
	jr	z,.r_nocrc
	ld	hl,(UGREQ.FRAME+4)
	ld	(UGXFER.CRC),hl
	ld	hl,(UGREQ.FRAME+6)
	ld	(UGXFER.CRC+2),hl
.r_nocrc:
	ld	a,2
	ld	(UGXFER.DIR),a
    ld a,6                       ; read grant gate
    ld (UGXFER.STAGE),a
	; grant gate
	call	UG_WIN_OPEN
	jp	c,.r_fail
	ld	a,UG_REG_X_STATUS
	call	UG_REG_R
	and	UG_XS_READ_GRANT
	push	af
	call	UG_ISA_CLOSE
	pop	af
	jp	z,.r_nogrant
    ld a,7                       ; read payload / GS latch wait
    ld (UGXFER.STAGE),a
    IFDEF UG_BENCH_TIMING
    call BENCH_PAYLOAD
    ENDIF
    ld a,(UGXFER.TRANS)
    bit 0,a
    jr z,.r_loop
    call UG_SLOW_DATA
    jp c,.r_fail
    jp .r_data_done
	; chunks
.r_loop:
    IFDEF UG_DSS_TIMED
    call UG_BULK_YIELD
    jp c,.r_fail
    ENDIF
	ld	hl,(UGXFER.N)
	ld	de,(UGXFER.SENT)
	or	a
	sbc	hl,de
	jr	z,.r_data_done
	call	UG_SAFE_CHUNK
	or	a
	sbc	hl,bc
	jr	nc,.r_usechunk
	add	hl,bc
	ld	b,h
	ld	c,l
.r_usechunk:
    ld a,(UG_METHOD)
    cp 1
    jr nz,.r_pushchunk
    ld a,b
    or a
    jr nz,.r_cap32
    ld a,c
    cp 33
    jr c,.r_pushchunk
.r_cap32:
    ld bc,32
.r_pushchunk:
	push	bc
	call	UG_WIN_OPEN
	jp	c,.r_failpop
	ld	hl,(UGXFER.BUF)
	ld	de,(UGXFER.SENT)
	add	hl,de
	pop	bc
	push	bc
    ld a,(UG_METHOD)
    cp 1
    jr nz,.r_fixed
    call UG_BULK_READ_ALIAS
    jr .r_copied
.r_fixed:
    call UG_BULK_READ
.r_copied:
	call	UG_ISA_CLOSE
	pop	bc
	ld	hl,(UGXFER.SENT)
	add	hl,bc
	ld	(UGXFER.SENT),hl
	jr	.r_loop
.r_data_done:
	ld	hl,(UGXFER.ID)
	ld	de,(UGREQ.TOKEN)
	or	a
	sbc	hl,de
	jr	nz,.r_internal
	ld	hl,(UGXFER.ID+2)
	ld	de,(UGREQ.TOKEN+2)
	or	a
	sbc	hl,de
	jr	nz,.r_internal
    ld a,8
    ld (UGXFER.STAGE),a
	ld	a,1			; nz -> read-end form
	call	UG_XFER_END
	jp	c,.r_fail
	xor	a
	ld	(UGXFER.DIR),a
    IFDEF UG_BENCH_TIMING
    call BENCH_FINISH
    ENDIF
	pop	hl
	pop	ix
	ret
.r_nogrant:
	ld	a,UG_ERR_STATE
	ld	b,1
	call	UG_SET_ERR
	jr	.r_fail
.r_badreply:
	call	UG_BAD_BEGIN
	jr	.r_fail
.r_internal:
	ld	a,UG_ERR_INTERNAL
	ld	b,1
	call	UG_SET_ERR
	jr	.r_fail
.r_failpop:
	pop	bc
.r_fail:
	push	af
	call	UG_XFER_CANCEL
	pop	af
	scf
.r_done_fail:
	pop	hl
	pop	ix
	ret

    IFDEF UG_DSS_TIMED
; Check ESC on entering each 256-byte region, with ISA already closed.
; IRQ/MMU/Turbo are still restored after EVERY chunk. Public cap is eight;
; file payload cap is 256. For arbitrary chunk sizes <=cap the poll gap is
; at most 255+cap bytes; standard file chunks poll every 256 bytes.
UG_BULK_YIELD:
    ld a,(UGXFER.SENT+1)
    push hl
    ld hl,UGXFER.KEYHI
    cp (hl)
    jr nz,.poll
    pop hl
    or a
    ret
.poll:
    ld (hl),a
    pop hl
    push bc
    push de
    push hl
    push ix
    push iy
    ld c,0x31
    rst 0x10
    cp 27
    pop iy
    pop ix
    pop hl
    pop de
    pop bc
    jr z,.cancel
    xor a
    ret
.cancel:
    ld a,UG_ERR_CANCELLED
    ld b,1
    jp UG_SET_ERR
    ENDIF

 ; GS_DATA uses one-byte windows and closed-window latch waits.
UG_SLOW_DATA:
    ld hl,0xFFFF
    ld (UGXFER.SLOWCOUNT),hl
    IFDEF UG_DSS_TIMED
    call UG_WAIT_START
    ld a,5
    ld (UGTM.LIMIT),a
    ENDIF
.loop:
    ld hl,(UGXFER.SENT)
    ld de,(UGXFER.N)
    or a
    sbc hl,de
    ret z
    ld hl,(UGXFER.BUF)
    ld de,(UGXFER.SENT)
    add hl,de
    push hl
    ld a,(UGXFER.DIR)
    cp 2
    jr z,.read
    ld a,(hl)
    call UG_GS_SD
    jr c,.fail
.waitwrite:
    call UG_GS_POLL_CB
    jr c,.fail
    bit 7,a
    jr z,.advance
    call UG_SLOW_WAIT
    jr nc,.waitwrite
    jr .fail
.read:
    call UG_GS_POLL_CB
    jr c,.fail
    bit 7,a
    jr nz,.readbyte
    call UG_SLOW_WAIT
    jr nc,.read
    jr .fail
.readbyte:
    call UG_GS_GD
    jr c,.fail
    pop hl
    ld (hl),a
    push hl
.advance:
    pop hl
    ld hl,(UGXFER.SENT)
    inc hl
    ld (UGXFER.SENT),hl
    ld a,l
    and 7
    jr nz,.loop
    call UG_SLOW_WAIT
    ret c
    jr .loop
.fail:
    pop hl
    ret
UG_SLOW_WAIT:
    IFDEF UG_DSS_TIMED
    call UG_WAIT_NEXT
    ret nc
    ld b,1
    jp UG_SET_ERR
    ELSE
    ; Non-DSS library users still have a finite latch wait.
    ld hl,(UGXFER.SLOWCOUNT)
    dec hl
    ld (UGXFER.SLOWCOUNT),hl
    ld a,h
    or l
    ret nz
    ld a,UG_ERR_TIMEOUT
    ld b,1
    jp UG_SET_ERR
    ENDIF

; -------------------------------------------------------- UG_WRITE_STACK
; Explicit METHOD:STACK entry (spec 11.4).  When the NMI profile is not
; proven (UG_NMI_PROFILE != 1) this refuses UNSAFE_NMI WITHOUT any bus
; access - DI does not mask NMI, so an unproven switched-SP window is
; forbidden.  With a proven profile it runs the same BEGIN/chunks/END
; flow and each chunk uses the real switched-SP burst writer
; (UG_BULK_WRITE_STACK).  in/out identical to UG_WRITE.
UG_WRITE_STACK:
	push	bc			; N
	push	af			; transport
	push	de			; buffer
	push	hl			; handle
	ld	a,(UG_NMI_PROFILE)
	cp	1
	jr	z,.safe
	pop	hl
	pop	de
	pop	af
	pop	bc
	ld	a,UG_ERR_UNSAFE_NMI
	ld	b,1
	jp	UG_SET_ERR		; CF=1, no ISA opened, no bus touched
.safe:
	pop	hl			; handle
	pop	de			; buffer
	pop	af			; transport
	pop	bc			; N - all four args restored for UG_WRITE
	push	af			; keep transport while sampling
	ld	a,(UG_METHOD)
	ld	(UGREQ.STACKMETHOD),a	; distinct from control operand scratch
	ld	a,2
	ld	(UG_METHOD),a		; METHOD==STACK for the chunk loop
	pop	af			; transport back for the call
	call	UG_WRITE
	push	af			; keep result + CF across restore
	ld	a,(UGREQ.STACKMETHOD)
	ld	(UG_METHOD),a
	pop	af
	ret

; -------------------------------------------------------- UG_FRAME_CRC
; in A=0/1 -> UGFRAME.CRCF (one flag per process, spec 12.1); any
; other value is BAD_ARGUMENT/HOST and leaves the flag unchanged
UG_FRAME_CRC:
	cp	2
	jr	nc,.badval
	ld	(UGFRAME.CRCF),a
	xor	a
	ret
.badval:
	ld	a,UG_ERR_BAD_ARGUMENT
	ld	b,1
	jp	UG_SET_ERR

; --------------------------------------------------------- UG_SNAPSHOT
; in HL = caller buffer (>=128 bytes). SNAP_LATCH once, then
; 128 consuming SNAP_DATA reads in windows of at most eight bytes.
; out CF=0; CF=1 A=err.  clobbers AF,BC,DE,HL
UG_SNAPSHOT:
	push	hl			; caller buffer
	call	UG_WIN_OPEN
	jp	c,.s_fail
	ld	e,UG_REG_X_CONTROL
	ld	a,UG_XC_SNAP_LATCH
	call	UG_REG_W
	pop	de			; DE = dest ptr: UG_REG_R clobbers HL!
	ld	bc,128
.sloop:
    call UG_FRAME_YIELD
	ld	a,UG_REG_SNAP_DATA
	call	UG_REG_R		; preserves BC and DE
	ld	(de),a
	inc	de
	dec	bc
	ld	a,b
	or	c
	jr	nz,.sloop
	call	UG_ISA_CLOSE
	xor	a
	ret
.s_fail:
	pop	hl
	ret

; ------------------------------------------------------- GS latch helpers
; Each primitive is its own bounded open/close window (spec 12.2: every
; WC/WN sits between short independent ISA accesses).
;
; UG_GS_POLL_CB: out CF=0 -> A=GS_CMDSTAT; CF=1 window error
UG_GS_POLL_CB:
	call	UG_WIN_OPEN
	ret	c
	ld	a,UG_REG_GS_CMDSTAT
	call	UG_REG_R
	push	af
	call	UG_ISA_CLOSE
	pop	af
	or	a
	ret
;
; UG_GS_WC: wait until CB(bit0) clears, bounded
UG_GS_WC:
	ld	hl,UG_GS_BUDGET
.wc:	push	hl
	call	UG_GS_POLL_CB
	jr	c,.wcf			; propagate window error
	bit	0,a
	jr	z,.wcdone
	pop	hl
	dec	hl
	ld	a,h
	or	l
	jr	nz,.wc
	ld	a,UG_ERR_TIMEOUT
	ld	b,3			; GS source
	jp	UG_SET_ERR
.wcdone:pop	hl
	or	a
	ret
.wcf:	pop	hl
	ret
;
; UG_GS_WN: wait until DB(bit7) sets, bounded
UG_GS_WN:
	ld	hl,UG_GS_BUDGET
.wn:	push	hl
	call	UG_GS_POLL_CB
	jr	c,.wnf
	bit	7,a
	jr	nz,.wndone
	pop	hl
	dec	hl
	ld	a,h
	or	l
	jr	nz,.wn
	ld	a,UG_ERR_TIMEOUT
	ld	b,3
	jp	UG_SET_ERR
.wndone:pop	hl
	or	a
	ret
.wnf:	pop	hl
	ret
;
UG_GS_WD:
    ld hl,UG_GS_BUDGET
.loop:
    push hl
    call UG_GS_POLL_CB
    pop hl
    ret c
    bit 7,a
    ret z
    dec hl
    ld a,h
    or l
    jr nz,.loop
    ld a,UG_ERR_TIMEOUT
    ld b,3
    jp UG_SET_ERR
;
; UG_GS_SD: in A=byte -> GS_DATA write (bounded window)
UG_GS_SD:
	ld	(UGREQ.GPRE),a		; keep the data byte across WIN_OPEN
	call	UG_WIN_OPEN
	ret	c			; propagate CF=1/A=err
	ld	a,(UGREQ.GPRE)
	ld	e,UG_REG_GS_DATA
	call	UG_REG_W
	call	UG_ISA_CLOSE
	or	a
	ret
;
; UG_GS_SC: in A=command -> GS_CMDSTAT write (bounded window)
UG_GS_SC:
	ld	(UGREQ.GPRE),a
	call	UG_WIN_OPEN
	ret	c
	ld	a,(UGREQ.GPRE)
	ld	e,UG_REG_GS_CMDSTAT
	call	UG_REG_W
	call	UG_ISA_CLOSE
	or	a
	ret
;
; UG_GS_GD: out CF=0 -> A=GS_DATA byte (bounded window)
UG_GS_GD:
	call	UG_WIN_OPEN
	ret	c
	ld	a,UG_REG_GS_DATA
	call	UG_REG_R
	push	af
	call	UG_ISA_CLOSE
	pop	af
	or	a
	ret

; ------------------------------------------------------- UG_GS_COMMAND
; in : HL = 9-byte descriptor:
;   +0 command, +1 has_pre(0/1), +2 pre, +3 post_count, +4 post_ptr u16,
;   +6 reply_count, +7 reply_ptr u16   (spec 12.1)
; Handshake per spec 8.1: optional pre -> GS_DATA, SC -> GS_CMDSTAT, WC
; until CB clears, post bytes -> GS_DATA, reply_count WN/GD reads.
; out CF=0; CF=1 A=err (TIMEOUT src=GS on the latch waits).
; clobbers AF,BC,DE,HL; IX/IY preserved
UG_GS_COMMAND:
	; validate has_pre in {0,1} before any bus access
	push	hl
	inc	hl
	ld	a,(hl)
	pop	hl
	cp	2
	jp	nc,.g_badarg
	; copy the descriptor to scratch so field pointers survive calls
	push	bc
	push	de
	push	hl
	ld	de,UG_ARGBUF
	ld	bc,UG_GS_DESC_LEN
	ldir
	pop	hl
	pop	de
	pop	bc
	; optional pre byte -> GS_DATA
	ld	a,(UG_ARGBUF+1)
	or	a
	jr	z,.g_sc
	ld	a,(UG_ARGBUF+2)
	call	UG_GS_SD
	jp	c,.g_ret
.g_sc:
	; SC: command -> GS_CMDSTAT
	ld	a,(UG_ARGBUF)
	call	UG_GS_SC
	jp	c,.g_ret
	; WC
	call	UG_GS_WC
	jp	c,.g_ret
	; post bytes (WD semantics: WC poll between each SD)
	ld	a,(UG_ARGBUF+3)
	or	a
	jr	z,.g_reply
	ld	b,a
	ld	hl,(UG_ARGBUF+4)	; post_ptr (u16 read from scratch)
.g_post:
	push	bc
	push	hl
	ld	a,(hl)
	call	UG_GS_SD
	jp	c,.g_postpop
	call	UG_GS_WC
	jp	c,.g_postpop
	pop	hl
	pop	bc
	inc	hl
	djnz	.g_post
.g_reply:
	; OUT latch reads only when reply_count given
	ld	a,(UG_ARGBUF+6)
	or	a
	jr	z,.g_ok
	ld	b,a
	ld	hl,(UG_ARGBUF+7)
.g_rloop:
	push	bc
	push	hl
	call	UG_GS_WN		; WN: DB set
	jp	c,.g_rpop
	call	UG_GS_GD		; GD: read byte
	jp	c,.g_rpop
	pop	hl
	pop	bc
	ld	(hl),a
	inc	hl
	djnz	.g_rloop
.g_ok:	xor	a
	ret
.g_postpop:
	pop	hl
	pop	bc
	jr	.g_ret
.g_rpop:
	pop	hl
	pop	bc
.g_ret:	scf
	ret
.g_badarg:
	ld	a,UG_ERR_BAD_ARGUMENT
	ld	b,1
	jp	UG_SET_ERR

; A successful BEGIN with a malformed payload has no trustworthy token.
; Reset the transport (which cancels its grant), then report LENGTH/HOST.
UG_BAD_BEGIN:
	ld	a,UG_XC_TRANSPORT_RESET
	call	UG_XCTRL
	ld	a,UG_ERR_LENGTH
	ld	b,1
	jp	UG_SET_ERR

    IFDEF UG_DSS_TIMED
    INCLUDE "ugwait.asm"
    ENDIF
	ENDIF ; UGPROTO_INC
