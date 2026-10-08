; SPDX-License-Identifier: GPL-2.0-or-later
;
; z80-vectors.asm - standalone vector producer for the pinned Z80 core.
; NOT a DSS EXE: raw ORG 8000h binary executed directly by the harness
; runner (no header/DSS needed). Calls the production library routines
; UG_CRC32*, UG_BUILD_FRAME, PUT_LE*/GET_LE* and deposits raw results in
; the fixed OUT area for the host runner to compare with the HANDWRITTEN
; vectors.json expectations (never with generated equates).
;
; Build: sjasmplus -I<lib> -I<include> -I<gen> --raw=zvec.bin --lst=zvec.lst

	ORG	0x8000

	INCLUDE	"ugmem.inc"
	INCLUDE	"ug_wire.inc"

OUT	EQU	0xA000		; result deposit area
FRM	EQU	OUT+96		; frame slots, stride 140: [0]=err [1]=len [2..]bytes
FRMSTR	EQU	140

	; ---- helpers ----
	MACRO	CRCTST	data,len,dst
	ld	hl,data
	ld	bc,len
	call	UG_CRC32
	ld	hl,UGCRC.OUT
	ld	de,dst
	ld	bc,4
	ldir
	ENDM

	MACRO	FRMTST	opcode,plsrc,plen,slot
	ld	a,opcode
	ld	de,FRM+slot*FRMSTR+2
	ld	hl,plsrc
	ld	bc,plen
	call	UG_BUILD_FRAME
	ld	a,0
	adc	a,0			; A = CF after call
	ld	(FRM+slot*FRMSTR),a
	ld	a,c
	ld	(FRM+slot*FRMSTR+1),a	; total frame length (<256)
	ENDM

START:
	di
	; ===== CRC32 vectors =====
	CRCTST	D_123456789,9,OUT+0	; expect CBF43926
	CRCTST	D_00010203,4,OUT+4	; expect 8BB98613
	CRCTST	D_8000,2,OUT+8		; expect 7A5A8AB4
	CRCTST	D_FF,1,OUT+12		; expect FF000000
	CRCTST	D_123456789,0,OUT+16	; expect 00000000 (empty)
	; streaming: INIT + fold("1234") + fold("56789") + END -> CBF43926
	call	UG_CRC32_INIT
	ld	hl,D_123456789
	ld	bc,4
	call	UG_CRC32_FOLD
	ld	hl,D_123456789+4
	ld	bc,5
	call	UG_CRC32_FOLD
	call	UG_CRC32_END
	ld	hl,UGCRC.OUT
	ld	de,OUT+20
	ld	bc,4
	ldir

	; ===== PUT_LE16 =====
	ld	de,OUT+32
	ld	hl,0x0001
	call	PUT_LE16
	ld	hl,0x00FF
	call	PUT_LE16
	ld	hl,0x0100
	call	PUT_LE16
	ld	hl,0x7FFF
	call	PUT_LE16
	ld	hl,0x8000
	call	PUT_LE16
	ld	hl,0xFFFF
	call	PUT_LE16

	; ===== PUT_LE32 =====
	ld	de,OUT+48
	ld	hl,0x0000
	ld	bc,0x0000
	call	PUT_LE32
	ld	hl,0x0000
	ld	bc,0x0001
	call	PUT_LE32		; 0x00010000
	ld	hl,0x0000
	ld	bc,0x0010
	call	PUT_LE32		; 0x00100000
	ld	hl,0xFFFF
	ld	bc,0x007F
	call	PUT_LE32		; 0x007FFFFF
	ld	hl,0xFFFF
	ld	bc,0xFFFF
	call	PUT_LE32		; 0xFFFFFFFF

	; ===== PUT_LE64 (copy of LE value) =====
	ld	de,OUT+72
	ld	hl,D_U64LE
	call	PUT_LE64

	; ===== GET_LE16 / GET_LE32 =====
	ld	hl,D_LE16SRC
	call	GET_LE16		; -> HL
	ld	a,l
	ld	(OUT+80),a
	ld	a,h
	ld	(OUT+81),a
	ld	hl,D_LE32SRC
	call	GET_LE32		; -> DE:HL (HL=low)
	ld	a,l
	ld	(OUT+82),a
	ld	a,h
	ld	(OUT+83),a
	ld	a,e
	ld	(OUT+84),a
	ld	a,d
	ld	(OUT+85),a

	; ===== frame serializer vectors =====
	xor	a
	ld	(UGFRAME.CRCF),a	; FAST
	FRMTST	0x00,D_PL0,0,0		; INFO fast -> 00 00
	FRMTST	UG_OP_WRITE_BEGIN,P_WB,9,1	; 20 09 34 12 ...
	FRMTST	UG_OP_WRITE_BEGIN,P_WBV,13,2	; verified 13B payload
	FRMTST	UG_OP_WRITE_END,P_TOK,4,3	; 21 04 tok1
	FRMTST	UG_OP_READ_BEGIN,P_WB,9,4	; 22 09 ...
	FRMTST	UG_OP_READ_BEGIN,P_RBV,9,5	; verified req (9B)
	FRMTST	UG_OP_READ_END,P_TOK,4,6	; 23 04 tok1
	FRMTST	UG_OP_READ_END,P_REV,8,7	; verified 8B (tok+hostcrc)
	FRMTST	UG_OP_ALLOC,P_ALLOC,5,8	; 10 05 raw 4k
	FRMTST	UG_OP_SEAL,P_SEAL,7,9	; 13 07 ...
	FRMTST	UG_OP_PCM_CONFIG,P_PCM,26,10	; 14 1A ...
	FRMTST	UG_OP_OBJECT_INFO,P_H1,2,11	; 12 02 01 00
	FRMTST	UG_OP_MEM_INFO,D_PL0,0,12	; 02 00
	FRMTST	UG_OP_CAPS,D_PL0,0,13	; 01 00
	FRMTST	UG_OP_STATS,D_PL0,0,14	; 03 00
	FRMTST	UG_OP_SNAPSHOT,D_PL0,0,15	; 50 00
	FRMTST	UG_OP_TRANSFER_CANCEL,P_TC,4,16	; 24 04 DEADBEEF
	FRMTST	UG_OP_QUEUE_ADD,P_QA,6,17	; 41 06 ...
	; FRAME_CRC mode on
	ld	a,1
	ld	(UGFRAME.CRCF),a
	FRMTST	UG_OP_INFO,D_PL0,0,18	; 80 00 B4 8A 5A 7A
	FRMTST	UG_OP_STATS,D_PL0,0,19	; 83 00 77 D9 77 51
	FRMTST	UG_OP_WRITE_BEGIN,P_WB,9,20	; A0 09 ... +crc
	; 128-byte payload + CRC: pattern 00..7F generated into PLBUF
	ld	hl,PLBUF
	ld	b,128
	xor	a
.fill:	ld	(hl),a
	inc	hl
	inc	a
	djnz	.fill
	FRMTST	UG_OP_SNAPSHOT,PLBUF,128,21	; D0 80 00..7F +crc
	xor	a
	ld	(UGFRAME.CRCF),a
	; negative: opcode >= 80h
	FRMTST	0x80,D_PL0,0,22		; expect err=1
	; negative: len 129
	FRMTST	UG_OP_INFO,D_PL0,129,23	; expect err=1

	halt
	jr	$-1			; parked

	; ---- constant payloads (verified independently in vectors.json) ----
D_123456789:	DB	"123456789"
D_00010203:	DB	0x00,0x01,0x02,0x03
D_8000:		DB	0x80,0x00
D_FF:		DB	0xFF
D_U64LE:	DB	0x08,0x07,0x06,0x05,0x04,0x03,0x02,0x01	; =0102030405060708h LE
D_LE16SRC:	DB	0x01,0x00
D_LE32SRC:	DB	0x00,0x00,0x10,0x00
D_PL0:		DB	0x00				; unused when len=0

P_WB:		DB	0x34,0x12,0x00,0x00,0x00,0x00,0x00,0x04,0x00
P_WBV:		DB	0x34,0x12,0x00,0x00,0x00,0x00,0x00,0x04,0x80
		DB	0x78,0x56,0x34,0x12
P_RBV:		DB	0x34,0x12,0x00,0x00,0x00,0x00,0x00,0x04,0x80
P_TOK:		DB	0x01,0x00,0x00,0x00
P_REV:		DB	0x01,0x00,0x00,0x00,0x13,0x86,0xB9,0x8B
P_ALLOC:	DB	0x01,0x00,0x10,0x00,0x00
P_SEAL:		DB	0x01,0x00,0x00,0x00,0x00,0x00,0x00
P_PCM:		DB	0x01,0x00,0x44,0xAC,0x00,0x00,0x02,0x10,0x02,0x00
		DB	0x00,0x00,0x00,0x00,0x00,0x80,0x00,0x00
		DB	0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00
P_H1:		DB	0x01,0x00
P_TC:		DB	0xEF,0xBE,0xAD,0xDE
P_QA:		DB	0x34,0x12,0x03,0x00,0x40,0x20

PLBUF	EQU	0xB000	; scratch payload area (below stack)

	INCLUDE	"ugcrc.asm"
	INCLUDE	"ugle.asm"
	INCLUDE	"ugframe.asm"

	END	START
