; SPDX-License-Identifier: GPL-2.0-or-later
;
; ugdiag.asm - Ultra GS S0b diagnostic utility (small DSS EXE, ORG 8000h).
;
; Vertical scenario: real DSS header, UG_OPEN (config discovery ->
; FW_ACTIVE=8 gate), INFO with FRAME_CRC, ALLOC, public UG_WRITE of a
; 256-byte block, OBJECT_INFO, public UG_READ, in-RAM compare, SNAP
; capture, one GS latch command (POOL_SIZE, 4-byte reply), FREE,
; UG_CLOSE, DSS EXIT.  All card traffic goes through the actual EXT
; frame transport on the ISA bus - nothing is faked host-side.
;
; Result record at UGRESULT (0BA00h), 32 bytes, written-before-read:
;   +0  u16  magic AA55h ("alive")
;   +2  u8   stage - last completed stage (STG_* below)
;   +3  u8   err   - 0, or the UG_ERR_* / status that ended the run
;   +4  u16  handle - allocated object handle
;   +6  u32  token - last BEGIN token (workspace, preserved over data)
;   +10 u16  compared - bytes compared
;   +12 u16  mismatches
;   +14 u16  first mismatch offset (FFFFh if none)
;   +16 u8   xerr  - X_ERROR sampled after a failed RPC (FFh = none)
;   +17 u8   xs    - last X_STATUS sample (post-write grant poll)
;   +18 u8   gs0   - first byte of the GS POOL_SIZE reply (FFh = none)
;   +19 u8   snap0 - SNAP_DATA[0] captured via UG_SNAPSHOT (FFh = none)
;   +20..31  reserved (0)

	ORG	0x8000
EXE_HDR:
	DB	"EXE"
	DB	1			; header version
	DW	0x80			; header size 128
	DW	0,0,0,0,0		; reserved words (offs 6..14)
	DW	ENTRY			; 16: entry point
	DW	ENTRY			; 18: entry point (duplicate)
	DW	STACK_TOP		; 20: initial SP
	DS	0x80 - ($ - EXE_HDR), 0	; reserved to 128

STACK_TOP	EQU 0xBFFE
UG_N		EQU 256			; block size for the vertical
UG_N_LO		EQU UG_N & 0xFF
UG_N_HI		EQU (UG_N >> 8) & 0xFF
UG_RESP_CAP	EQU 64			; caller IX capacity for UGRESP

; app-private fixed BSS (image stays free of zero buffers per project rule)
UGTX		EQU 0xB800		; 256B transmit pattern
UGRX		EQU 0xB900		; 256B readback buffer
UGRESULT	EQU 0xBA00		; 32B result record
UGD_HANDLE	EQU 0xBA20		; u16 object handle
UGD_MISM	EQU 0xBA26		; u16 mismatch counter
UGD_FIRST	EQU 0xBA28		; u16 first mismatch offset
UGD_OFF		EQU 0xBA2A		; u16 running compare offset
UGSNAP		EQU 0xBA30		; 128B SNAP capture buffer
UGRESP		EQU 0xBAB0		; 64B caller response buffer
UG_GSDESC	EQU 0xBAF0		; 9B GS command descriptor

DSS_EXIT	EQU 0x41
DSS_PCHARS	EQU 0x5C
DSS_PUTCHAR	EQU 0x5B

STG_INIT	EQU 1
STG_OPEN	EQU 2
STG_INFO	EQU 3
STG_ALLOC	EQU 4
STG_WRITE	EQU 5
STG_OBJINFO	EQU 6
STG_READ	EQU 7
STG_CMP		EQU 8
STG_SNAP	EQU 9
STG_GS		EQU 10
STG_FREE	EQU 11
STG_CLOSE	EQU 12
STG_DONE	EQU 13

	MACRO	STAGE n
	ld	a,n
	ld	(UGRESULT+2),a
	ENDM

; ==================================================================== code
ENTRY:
	call	UG_LIB_INIT
	; mark the record alive so a dead run is distinguishable from no-run
	ld	hl,0xAA55
	ld	(UGRESULT),hl
	xor	a
	ld	(UGRESULT+2),a		; stage = 0
	ld	(UGRESULT+3),a		; err = 0
	ld	(UGD_HANDLE),a
	ld	(UGD_HANDLE+1),a
	ld	a,0xFF
	ld	(UGRESULT+16),a		; xerr = not sampled
	ld	(UGRESULT+18),a		; gs0 = not sampled
	ld	(UGRESULT+19),a		; snap0 = not sampled
	STAGE	STG_INIT

	; ---- UG_OPEN(slot=0, base=02A0h): config gate before BASE regs ----
	xor	a			; slot 0
	ld	hl,0x02A0
	call	UG_OPEN
	jp	c,.fail_open
	; verify CURBASE bookkeeping: CURSLOT must be 0, CURBASE must equal
	; the base's low byte (A0h) - regression for the slot/base mixup
	ld	a,(UG_CURSLOT)
	or	a
	jp	nz,.fail_ctx
	ld	a,(UG_CURBASE)
	cp	0xA0
	jp	nz,.fail_ctx
	STAGE	STG_OPEN

	; ---- INFO with FRAME_CRC: exercises request+response trailer path --
	ld	a,1
	call	UG_FRAME_CRC
	ld	a,UG_OP_INFO
	ld	hl,UG_ARGBUF
	ld	bc,0
	ld	de,UGRESP
	ld	ix,UG_RESP_CAP
	call	UG_RPC
	jp	c,.fail_transport
	xor	a
	call	UG_FRAME_CRC		; remaining traffic is FAST
	; magic "UGS1" expected at resp payload[0..3]
	ld	a,(UGRESP)
	cp	0x55			; 'U'
	jp	nz,.fail_magic
	ld	a,(UGRESP+1)
	cp	0x47			; 'G'
	jp	nz,.fail_magic
	ld	a,(UGRESP+2)
	cp	0x53			; 'S'
	jp	nz,.fail_magic
	ld	a,(UGRESP+3)
	cp	0x31			; '1'
	jp	nz,.fail_magic
	STAGE	STG_INFO

	; ---- ALLOC BLOB, UG_N bytes -----------------------------------------
	ld	de,UG_ARGBUF
	xor	a			; kind BLOB
	ld	(de),a
	inc	de
	ld	hl,UG_N
	ld	bc,0
	call	PUT_LE32		; size u32
	ld	a,UG_OP_ALLOC
	ld	hl,UG_ARGBUF
	ld	bc,5
	ld	de,UGRESP
	ld	ix,UG_RESP_CAP
	call	UG_RPC
	jp	c,.fail_transport
	ld	hl,(UGRESP)		; handle u16 at payload+0
	ld	(UGD_HANDLE),hl
	ld	(UGRESULT+4),hl
	STAGE	STG_ALLOC

	; ---- fill TXBUF with pattern (i*13+7)&0FFh ---------------------------
	ld	hl,UGTX
	ld	bc,UG_N
	ld	e,7
.fill:	ld	a,e
	ld	(hl),a
	inc	hl
	add	a,13
	ld	e,a
	dec	bc
	ld	a,b
	or	c
	jr	nz,.fill

	; ---- public UG_WRITE(h, UGTX, N, BULK_FAST, off=0) -------------------
	xor	a
	ld	(UG_OFFSET),a
	ld	(UG_OFFSET+1),a
	ld	(UG_OFFSET+2),a
	ld	(UG_OFFSET+3),a
	ld	hl,(UGD_HANDLE)
	ld	de,UGTX
	ld	bc,UG_N
	ld	a,UG_TRANSPORT_BULK_FAST
	call	UG_WRITE
	jp	c,.fail_transport
	; token preservation was checked inside UG_WRITE; copy it out for
	; the record (UGREQ.TOKEN holds the last BEGIN token)
	ld	hl,(UGREQ.TOKEN)
	ld	(UGRESULT+6),hl
	ld	hl,(UGREQ.TOKEN+2)
	ld	(UGRESULT+8),hl
	; post-write grant poll (bounded window) for the xs field
	call	UG_POLL_STATUS
	jp	c,.fail_transport
	ld	(UGRESULT+17),a
	STAGE	STG_WRITE

	; ---- OBJECT_INFO(h): uploaded must equal N -----------------------------
	ld	de,UG_ARGBUF
	ld	hl,(UGD_HANDLE)
	call	PUT_LE16
	ld	a,UG_OP_OBJECT_INFO
	ld	hl,UG_ARGBUF
	ld	bc,2
	ld	de,UGRESP
	ld	ix,UG_RESP_CAP
	call	UG_RPC
	jp	c,.fail_transport
	; uploaded u32 at payload+10; require == UG_N
	ld	a,(UGRESP+12)
	or	a
	jp	nz,.fail_status		; byte2 of uploaded must be 0
	ld	a,(UGRESP+13)
	or	a
	jp	nz,.fail_status		; byte3 must be 0
	ld	a,(UGRESP+10)
	cp	UG_N_LO
	jp	nz,.fail_status
	ld	a,(UGRESP+11)
	cp	UG_N_HI
	jp	nz,.fail_status
	STAGE	STG_OBJINFO

	; ---- public UG_READ(h, UGRX, N, BULK_FAST, off=0) ----------------------
	xor	a
	ld	(UG_OFFSET),a
	ld	(UG_OFFSET+1),a
	ld	(UG_OFFSET+2),a
	ld	(UG_OFFSET+3),a
	ld	hl,(UGD_HANDLE)
	ld	de,UGRX
	ld	bc,UG_N
	ld	a,UG_TRANSPORT_BULK_FAST
	call	UG_READ
	jp	c,.fail_transport
	STAGE	STG_READ

	; ---- compare UGTX vs UGRX ---------------------------------------------
	xor	a
	ld	(UGD_MISM),a
	ld	(UGD_MISM+1),a
	ld	a,0xFF
	ld	(UGD_FIRST),a
	ld	(UGD_FIRST+1),a
	xor	a
	ld	(UGD_OFF),a
	ld	(UGD_OFF+1),a
	ld	de,UGTX
	ld	hl,UGRX
	ld	bc,UG_N
.cmp:	ld	a,(de)
	cp	(hl)
	jr	z,.eq1
	push	hl
	ld	hl,(UGD_MISM)
	inc	hl
	ld	(UGD_MISM),hl
	; record offset on first mismatch only (first==FFFFh sentinel)
	ld	hl,(UGD_FIRST)
	inc	hl			; FFFFh+1 wraps to 0 only when unset
	ld	a,h
	or	l
	jr	nz,.haveFirst
	ld	hl,(UGD_OFF)
	ld	(UGD_FIRST),hl
.haveFirst:
	pop	hl
.eq1:	inc	de
	inc	hl
	push	hl
	ld	hl,(UGD_OFF)
	inc	hl
	ld	(UGD_OFF),hl
	pop	hl
	dec	bc
	ld	a,b
	or	c
	jr	nz,.cmp
	ld	hl,UG_N
	ld	(UGRESULT+10),hl
	ld	hl,(UGD_MISM)
	ld	(UGRESULT+12),hl
	ld	hl,(UGD_FIRST)
	ld	(UGRESULT+14),hl
	STAGE	STG_CMP
	ld	hl,(UGD_MISM)
	ld	a,h
	or	l
	jr	z,.snap
	ld	a,0xEE			; data mismatch pseudo-error
	ld	(UGRESULT+3),a
	jp	.fail_common

	; ---- UG_SNAPSHOT into UGSNAP ------------------------------------------
.snap:	ld	hl,UGSNAP
	call	UG_SNAPSHOT
	jp	c,.fail_transport
	ld	a,(UGSNAP)
	ld	(UGRESULT+19),a		; snap0 = SNAP_DATA[0]
	STAGE	STG_SNAP

	; ---- GS latch: F00_MODE (6Ah), pre byte + 1-byte reply ----------------
	; Two commands prove the handshake end-to-end: first call sets reg6A
	; to 5Ah and returns the OLD value (0), second returns 5Ah.
	; descriptor: cmd,has_pre,pre,postc,postp(u16),repc,repp(u16)
	ld	hl,UG_GSDESC
	ld	a,UG_GS_GS_F00_MODE
	ld	(hl),a
	inc	hl
	ld	a,1
	ld	(hl),a			; has_pre = 1
	inc	hl
	ld	a,0x5A
	ld	(hl),a			; pre = 5Ah
	inc	hl
	xor	a
	ld	(hl),a			; post_count = 0
	inc	hl
	ld	(hl),a			; post_ptr lo
	inc	hl
	ld	(hl),a			; post_ptr hi
	inc	hl
	ld	a,1
	ld	(hl),a			; reply_count = 1
	inc	hl
	ld	a,UGRESP & 0xFF
	ld	(hl),a			; reply_ptr lo = UGRESP
	inc	hl
	ld	a,UGRESP >> 8
	ld	(hl),a			; reply_ptr hi
	; call 1: returns old reg6A (=0), sets it to 5Ah
	ld	hl,UG_GSDESC
	call	UG_GS_COMMAND
	jp	c,.fail_transport
	ld	a,(UGRESP)
	or	a
	jp	nz,.fail_status		; first read must return old=0
	; call 2: pre=0, must read back old=5Ah
	ld	hl,UG_GSDESC+2
	xor	a
	ld	(hl),a			; pre = 0
	ld	hl,UG_GSDESC
	call	UG_GS_COMMAND
	jp	c,.fail_transport
	ld	a,(UGRESP)
	cp	0x5A
	jp	nz,.fail_status		; second read must return old=5Ah
	ld	(UGRESULT+18),a		; gs0 = latched value 5Ah
	STAGE	STG_GS

	; ---- FREE(h) ----------------------------------------------------------
.free:	ld	de,UG_ARGBUF
	ld	hl,(UGD_HANDLE)
	call	PUT_LE16
	ld	a,UG_OP_FREE
	ld	hl,UG_ARGBUF
	ld	bc,2
	ld	de,UGRESP
	ld	ix,UG_RESP_CAP
	call	UG_RPC
	jp	c,.fail_transport
	STAGE	STG_FREE

	; ---- close ISA, report, exit ------------------------------------------
	call	UG_CLOSE
	STAGE	STG_CLOSE
	STAGE	STG_DONE
	ld	hl,msg_ok
	call	print
	xor	a
	ld	b,a
	jr	.exit

; ================= failure paths =================
.fail_open:
	ld	(UGRESULT+3),a		; UG_ERR_* from UG_OPEN
	ld	hl,msg_open
	call	print
	ld	b,STG_OPEN
	jr	.exit

.fail_ctx:
	ld	a,0xF2			; context bookkeeping pseudo-error
	ld	(UGRESULT+3),a
	jr	.fail_common

.fail_transport:			; UG_LAST_ERROR set by the lib
	ld	a,(UG_LAST_ERROR)
	ld	(UGRESULT+3),a
	; sample X_ERROR in one bounded window for the record
	call	UG_WIN_OPEN
	jr	c,.noerr
	ld	a,UG_REG_X_ERROR
	call	UG_REG_R
	push	af
	call	UG_ISA_CLOSE
	pop	af
	ld	(UGRESULT+16),a
	jr	.fail_common
.noerr:	call	UG_ISA_CLOSE
	jr	.fail_common

.fail_magic:
	ld	a,0xF1			; bad INFO magic pseudo-error
	ld	(UGRESULT+3),a
	jr	.fail_common

.fail_status:
	ld	a,UG_ERR_INTERNAL	; unexpected field value
	ld	(UGRESULT+3),a
.fail_common:
	call	UGD_CLEANUP
	ld	hl,msg_fail
	call	print
	ld	b,1
	jr	.exit

.exit:	ld	c,DSS_EXIT
	rst	0x10
	halt				; unreachable; trap for the harness

; cleanup helper: FREE when a handle is known, then UG_CLOSE (which
; itself cancels a live transfer via UG_XFER_CANCEL).  Cleanup errors
; are intentionally ignored - the primary error is already recorded.
UGD_CLEANUP:
	call	UG_XFER_CANCEL		; release grant before FREE or DSS
	ld	hl,(UGD_HANDLE)
	ld	a,h
	or	l
	jr	z,.noObj
	ld	de,UG_ARGBUF
	ld	hl,(UGD_HANDLE)
	call	PUT_LE16
	ld	a,UG_OP_FREE
	ld	hl,UG_ARGBUF
	ld	bc,2
	ld	de,UGRESP
	ld	ix,UG_RESP_CAP
	call	UG_RPC			; result ignored
.noObj:	call	UG_CLOSE
	ret

print:	ld	c,DSS_PCHARS
	rst	0x10
	ret

msg_ok:		DB	"UGDIAG: roundtrip OK",13,10,0
msg_fail:	DB	"UGDIAG: FAIL",13,10,0
msg_open:	DB	"UGDIAG: card absent",13,10,0
msg_close:	DB	"UGDIAG: ISA close failed",13,10,0

	INCLUDE	"ugproto.asm"		; library tail keeps ENTRY at image start

	END	ENTRY
