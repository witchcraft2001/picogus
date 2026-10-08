; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-head.inc - shared prologue for the S0b self-test EXEs.
; Real 128-byte DSS header at ORG 8000h; ENTRY does UG_LIB_INIT and
; stamps the result record.  Result record at 0BA00h:
;   +0 u16 magic AA55h | +2 u8 stage | +3 u8 err | +4..+7 scratch u32
; The library text is pulled in by st-tail.inc at the END of each file
; so ENTRY stays the first byte after the header.

	ORG	0x8000
EXE_HDR:
	DB	"EXE"
	DB	1
	DW	0x80
	DW	0,0,0,0,0
	DW	ENTRY
	DW	ENTRY
	DW	ST_TOP
	DS	0x80 - ($ - EXE_HDR), 0

ST_TOP		EQU 0xBFFE
ST_RESULT	EQU 0xBA00		; +0 magic | +2 stage | +3 err | +4..7 scratch
ST_RESP		EQU 0xBA40		; 64B caller response buffer
ST_RESP_CAP	EQU 64
ST_TX		EQU 0xB800		; 256B scratch data buffer

DSS_EXIT	EQU 0x41
DSS_PCHARS	EQU 0x5C

ENTRY:
	call	UG_LIB_INIT
	ld	hl,0xAA55
	ld	(ST_RESULT),hl
	xor	a
	ld	(ST_RESULT+2),a
	ld	(ST_RESULT+3),a
