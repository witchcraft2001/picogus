; SPDX-License-Identifier: GPL-2.0-or-later
;
; ugmem.inc - Ultra GS host library workspace map.
; All lib buffers live at fixed addresses below the C000h ISA window,
; never inside the .EXE image (zero-filled DS in image is forbidden by
; project rule).  Workspace is single-instance per process; the library
; is non-recursive and must not be called from ISR (spec 12.1).
;
; Region: 0xBC00..0xBFFF (1 KiB) - above typical small-app image end,
; below stack top / ISA window.  An app may move UGMEM_BASE before
; including this file if it needs the area for itself.
;
; Layout invariant: every field owns disjoint bytes; the ASSERT block at
; the end of this file is the static bound/overlap check (spec 12.1).

	IFNDEF UGMEM_INC
	DEFINE UGMEM_INC

	IFNDEF UGMEM_BASE
	DEFINE UGMEM_BASE 0xBC00
	ENDIF

; ---- CRC32 state ----
UGCRC.ACC	EQU UGMEM_BASE+0	; u32 LE crc accumulator (streaming)
UGCRC.N		EQU UGMEM_BASE+4	; u16 remaining length (fold state)
UGCRC.OUT	EQU UGMEM_BASE+6	; u32 LE last completed crc

; ---- frame serializer / protocol state ----
UGFRAME.CRCF	EQU UGMEM_BASE+10	; UG_FRAME_CRC flag: 0/1
UGFRAME.SV	EQU UGMEM_BASE+11	; saved payload length byte

; ---- public ABI state (spec 12.1) ----
UG_LAST_ERROR	EQU UGMEM_BASE+12	; u8, last error code (UG_ERR_*)
UG_LAST_SOURCE	EQU UGMEM_BASE+13	; u8, 0=NONE 1=HOST 2=X 3=GS
UG_OFFSET	EQU UGMEM_BASE+14	; u32 LE, UG_WRITE/UG_READ object offset
UG_CURSLOT	EQU UGMEM_BASE+18	; u8, slot opened by UG_OPEN
UG_CURBASE	EQU UGMEM_BASE+19	; u16, ISA base opened by UG_OPEN
UG_PROFILE	EQU UGMEM_BASE+21	; u8, detected CPU profile id
UG_CHUNK	EQU UGMEM_BASE+22	; u16, DI-budget chunk size (bytes)

; ---- ISA/MMU saved context (per open window, not nested) ----
UGCTX.SYSSAVE	EQU UGMEM_BASE+24	; reserved legacy byte; SYSTEM is write-only
UGCTX.PAGE3SAVE	EQU UGMEM_BASE+25	; u8, PAGE3 value at ISA_OPEN
UGCTX.IFFSAVE	EQU UGMEM_BASE+26	; u8, IFF state at ISA_OPEN (0/1)
UGCTX.ISOPEN	EQU UGMEM_BASE+27	; u8, nonzero while ISA window open
UGCTX.SLOT	EQU UGMEM_BASE+28	; u8, slot currently mapped
UGCTX.BASE	EQU UGMEM_BASE+29	; u16, ISA base currently mapped
UGCTX.SESS	EQU UGMEM_BASE+31	; u8, nonzero while session owns the card

; ---- request/response scratch for UG_RPC internals ----
UGREQ.HDR	EQU UGMEM_BASE+32	; 2 bytes header during RPC
UGREQ.LEN	EQU UGMEM_BASE+34	; u16 response payload length on the wire
UGREQ.CAP	EQU UGMEM_BASE+36	; u16 caller response capacity (IX copy)
UGREQ.PTR	EQU UGMEM_BASE+38	; u16 caller response pointer (DE copy)
UGREQ.TOKEN	EQU UGMEM_BASE+40	; u32 LE, last BEGIN token (DISJOINT
					;      from UGXFER.ID - moved 2026-10-07)
UGREQ.ST	EQU UGMEM_BASE+44	; u8, last wire status byte
UG_NMI_PROFILE	EQU UGMEM_BASE+45	; u8, 0=UNKNOWN 1=NMI-SAFE proven
UG_METHOD	EQU UGMEM_BASE+46	; u8, write method 0=FIXED 1=ALIAS 2=STACK
UGREQ.OP	EQU UGMEM_BASE+47	; u8, opcode stash during RPC

; ---- transfer state ----
UGXFER.ID	EQU UGMEM_BASE+48	; u32 LE active transfer token
UGXFER.N	EQU UGMEM_BASE+52	; u16 grant length
UGXFER.DIR	EQU UGMEM_BASE+54	; u8 0=none 1=write 2=read
UGXFER.KEYHI EQU UGMEM_BASE+55 ; last high byte of SENT polled for ESC
UGXFER.CRC	EQU UGMEM_BASE+56	; u32 LE crc for VERIFIED
UGXFER.TRANS	EQU UGMEM_BASE+60	; u8 transport value
UGXFER.OFF	EQU UGMEM_BASE+61	; u32 LE block object offset
UGXFER.BUF	EQU UGMEM_BASE+65	; u16 caller data buffer
UGXFER.SENT	EQU UGMEM_BASE+67	; u16 bytes moved so far
UGXFER.STAGE EQU UGMEM_BASE+69 ; diagnostic: 0 validation, 1..4 write, 5..8 read

; ---- timeout/utility ----
UGTM.LO		EQU UGMEM_BASE+70	; u16 delay/timeout counters
UGTM.HI		EQU UGMEM_BASE+72	; u16
UG_ALIASCFG	EQU UGMEM_BASE+74	; u16, bulk alias base read at UG_OPEN
UGREQ.GPRE	EQU UGMEM_BASE+76	; u8, GS descriptor has_pre stash
UGREQ.STACKMETHOD EQU UGMEM_BASE+77 ; u8, caller method across STACK RPCs
UGTM.LIMIT EQU UGMEM_BASE+78
UGTM.SEC EQU UGMEM_BASE+79
UGTM.ELAPSED EQU UGMEM_BASE+80
UGTM.STAGNANT EQU UGMEM_BASE+81 ; u24
UGTM.CHUNK EQU UGMEM_BASE+84
UGXFER.SLOWCOUNT EQU UGMEM_BASE+85 ; u16, finite non-DSS latch wait
UGTM.NOESC EQU UGMEM_BASE+87 ; cleanup/recovery ignore a held ESC; deadlines remain
; Shared configuration selection diagnostics; no public ABI offsets move.
UGCFG.SEL EQU UGMEM_BASE+88
UGCFG.OBS EQU UGMEM_BASE+89
UGCFG.SEC EQU UGMEM_BASE+90
UGCFG.COUNT EQU UGMEM_BASE+91 ; u16, stopped-clock watchdog
UGCFG.STAGE EQU UGMEM_BASE+93 ; 1 unlock, 2 select, 3 echo, 4 confirmed
UGCFG.TARGET EQU UGMEM_BASE+94
UGCFG.OUTERFAIL EQU UGMEM_BASE+95
UG_ARGBUF	EQU UGMEM_BASE+96	; DSS command-line copy area (<=160B)

; scratch buffers used by UG_RPC internals (write-before-read; never in
; the EXE image).  Caller response payload goes directly into the
; caller-supplied (DE,IX) buffer - never bounced through here.
UGREQ.FRAME	EQU UGMEM_BASE+256	; 140B request frame scratch
; Private streaming RPC state, outside the maximum frame (2+128+4).
UGTM.FASTPOLLS EQU UGMEM_BASE+396
UGTM.STARTED EQU UGMEM_BASE+397
    ASSERT UGREQ.FRAME+140 <= UGTM.FASTPOLLS
    ASSERT UGTM.STARTED+1 <= UGMEM_END

UGMEM_END	EQU UGMEM_BASE+400	; reserved workspace end (< 0xC000)

; ---- static workspace checks (assemble-time) ----
; each field must own disjoint bytes: sum of pairwise ordering conditions
; must be true for every overlapping-suspect pair.
	ASSERT UGREQ.PTR + 2 <= UGREQ.TOKEN	; ptr(2) precedes token
	ASSERT UGREQ.TOKEN + 4 <= UGREQ.ST	; token(4) precedes status
	ASSERT UGREQ.ST + 3 <= UGXFER.ID	; st/nmi/method/op before xfer
	ASSERT UGXFER.ID + 4 <= UGXFER.N	; id(4) precedes n
    ASSERT UGXFER.DIR + 1 <= UGXFER.KEYHI
    ASSERT UGXFER.KEYHI + 1 <= UGXFER.CRC
	ASSERT UGXFER.OFF + 4 <= UGXFER.BUF	; off(4) precedes buf
	ASSERT UGXFER.SENT + 2 <= UGXFER.STAGE
    ASSERT UGXFER.STAGE + 1 <= UGTM.LO
	ASSERT UGTM.HI + 2 <= UG_ALIASCFG	; timers precede alias cfg
	ASSERT UG_ALIASCFG + 2 <= UGREQ.GPRE	; alias cfg precedes gpre
	ASSERT UG_ARGBUF + 160 <= UGREQ.FRAME	; arg area precedes frame
	ASSERT UGREQ.FRAME + 140 <= UGMEM_END	; frame fits the region
	ASSERT UGXFER.SLOWCOUNT + 2 <= UGTM.NOESC
	ASSERT UGTM.NOESC + 1 <= UGCFG.SEL
    ASSERT UGCFG.OUTERFAIL + 1 <= UG_ARGBUF
	ASSERT UGMEM_END <= 0xC000		; workspace below ISA window

	ENDIF ; UGMEM_INC
