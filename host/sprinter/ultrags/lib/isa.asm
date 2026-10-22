; SPDX-License-Identifier: GPL-2.0-or-later
;
; isa.asm - Sprinter ISA-8 window mechanics for the Ultra GS host library.
;
; The ISA bus is reached through memory window 3 (0C000h-0FFFFh):
;   * PAGE3 port 00E2h selects what WIN3 maps; the ISA-ports control byte
;     is D4h+slot*2 (D7=1 D6=1 D4=1 enable, D2/D1 = slot, D0=0).
;   * PORT_SYSTEM 1FFDh is write-only (reads return mapper data).
;     DSS uses 11h while mapped and 01h after closing.
;   * SYS_PORT.RAM 3Ch receives 2 before ISA (Turbo off), 3 after
;     closing (DSS default Turbo on). Actual entry speed is unknowable
;     without measurement; neither SYSTEM nor CONFIG_DE is a snapshot.
;   * PORT_ISA 9FBDh holds A19..A14/AEN/RESET; writing 2 or C0h pulses the
;     ISA RESET line and is never done here.
; While the window is open, CPU addresses 0C000h+isa_addr hit the ISA bus;
; RAM there is unreachable - code and stack must live below 0C000h.
;
; Context contract: preserve PAGE3 and IFF on every window. Return to
; DSS SYSTEM=01h / software Turbo enabled; hardware Turbo permission
; remains independent. No BIOS calls or CONFIG_DE accesses are needed.
; Code/stack stay below C000h, with DI across the complete mapping change.
;
; Valid slots on this platform are 0 and 1 only.  Public entries preserve
; IX/IY and return CF=1/A=UG_ERR_* on defined failures.

	IFNDEF ISA_INC
	DEFINE ISA_INC

	INCLUDE	"ugmem.inc"
	INCLUDE	"ug_wire.inc"

; Sprinter platform ports (16-bit, accessed via IN/OUT (C))
UG_PORT_PAGE3	EQU 0x00E2		; window-3 control
UG_PORT_SYSTEM	EQU 0x1FFD		; write-only mapping control
UG_PORT_ISA	EQU 0x9FBD		; ISA high address lines / RESET / AEN

UG_PORT_SYS_RAM EQU 0x003C	; SYS_PORT.RAM, Turbo command (2/3)
UG_SYSTEM_DSS EQU 0x01

UG_SYSTEM_ISA	EQU 0x11		; SYSTEM value enabling ISA in WIN3
UG_PAGE3_ISA	EQU 0xD4		; PAGE3 ISA-ports base byte; +slot*2
UG_MAX_SLOT	EQU 1			; slots 0 and 1 exist on this platform

; ------------------------------------------------------------ UG_ISA_OPEN
; in : A = ISA slot number, HL = card ISA base (e.g. 02A0h)
; out: CF=0 window open (context sampled); CF=1 A=UG_ERR_*:
;        BAD_ARGUMENT - slot > UG_MAX_SLOT, nothing touched
;        STATE        - window already open, nothing touched
; clobbers AF,BC,HL
UG_ISA_OPEN:
	ld	b,a			; slot
	cp	UG_MAX_SLOT+1
	jr	c,.slotok
	ld	a,UG_ERR_BAD_ARGUMENT
	scf
	ret				; reject invalid slot before any HW write
.slotok:
	ld	a,(UGCTX.ISOPEN)
	or	a
	ld	a,UG_ERR_STATE
	scf
	ret	nz			; refuse nested open
	ld	a,b
	ld	(UGCTX.SLOT),a
    IFDEF APP_PLAY
    ld a,(UGREQ.OP)
    cp UG_OP_STREAM_FEED
    ld a,8
    jr nz,.framecap
    ld a,32
.framecap:
    ELSE
    xor a
    ENDIF
    ld (UGTM.CHUNK),a
	ld	a,l
	ld	(UGCTX.BASE),a
	ld	a,h
	ld	(UGCTX.BASE+1),a
	; IFF snapshot BEFORE di.  LD A,I reports IFF2 in P/V; the erratum
	; can lose a read when an INT lands exactly on the instruction, so a
	; PO result is sampled once more (a genuine PE means IFF=1 for sure).
.iff1:	ld	a,i
	jp	pe,.iffGot
	ld	a,i
.iffGot:
	push	af
	di
	pop	af			; P/V = saved IFF2
	ld	a,0
	jp	po,.iffStore		; PO -> interrupts were disabled
	inc	a
.iffStore:
	ld	(UGCTX.IFFSAVE),a
	; Save PAGE3; disable Turbo directly while preserving the DSS RAM map.
	ld	bc,UG_PORT_PAGE3
	in	a,(c)
	ld	(UGCTX.PAGE3SAVE),a
	ld	bc,UG_PORT_SYS_RAM
	ld	a,2
    IFDEF UG_GS_TURBO_SLOT
    ld a,(UG_GS_TURBO_WINDOW)
    add a,2
    ENDIF
	out	(c),a
	ld	bc,UG_PORT_SYSTEM
	; switch SYSTEM to the ISA mapping mode
	ld	a,UG_SYSTEM_ISA
	out	(c),a
	; point WIN3 at the ISA port space of the requested slot
	ld	a,(UGCTX.SLOT)
	add	a,a
	add	a,UG_PAGE3_ISA		; D4h + slot*2
	ld	bc,UG_PORT_PAGE3
	out	(c),a
	; A19..A14 = 0, AEN = 0, RESET kept released - never pulse 2/C0h here
	ld	bc,UG_PORT_ISA
	xor	a
	out	(c),a
	inc	a
	ld	(UGCTX.ISOPEN),a
	or	a			; CF=0
	ret

; ----------------------------------------------------------- UG_ISA_CLOSE
    IFDEF UG_GS_TURBO_SLOT
UG_GS_TURBO_WINDOW: DB 0
    ENDIF
; Restores PAGE3/IFF and the canonical DSS mapping and Turbo permission.
; in : - ; out: CF=0 closed; CF=1 A=UG_ERR_STATE was not open
; clobbers AF,BC
UG_ISA_CLOSE:
	ld	a,(UGCTX.ISOPEN)
	or	a
	ld	a,UG_ERR_STATE
	scf
	ret	z
	; Close ISA before restoring PAGE3, then return to DSS Turbo.
	ld	bc,UG_PORT_SYSTEM
	ld	a,UG_SYSTEM_DSS
	out	(c),a
	ld	bc,UG_PORT_PAGE3
	ld	a,(UGCTX.PAGE3SAVE)
	out	(c),a
	ld	bc,UG_PORT_SYS_RAM
	ld	a,3
	out	(c),a
	xor	a
	ld	(UGCTX.ISOPEN),a
	; restore interrupt state
	ld	a,(UGCTX.IFFSAVE)
	or	a
	ret	z
	ei
	ret

; STREAM_FEED permits 32 service bytes; other commands retain eight.
; Register values and flags preserved. All service windows use Turbo OFF.
UG_FRAME_YIELD:
    push af
    IFDEF APP_PLAY
    ld a,(UGTM.CHUNK)
    or a
    jr nz,.count
    ELSE
    ld a,(UGTM.CHUNK)
    cp 8
    jr c,.count
    ENDIF
    push bc
    push de
    push hl
    call UG_ISA_CLOSE
    ld a,(UGCTX.SLOT)
    ld hl,(UGCTX.BASE)
    call UG_ISA_OPEN
    pop hl
    pop de
    pop bc
    IFDEF APP_PLAY
    ld a,(UGTM.CHUNK)
    ELSE
    xor a
    ENDIF
.count:
    IFDEF APP_PLAY
    dec a
    ELSE
    inc a
    ENDIF
    ld (UGTM.CHUNK),a
    pop af
    ret

; ------------------------------------------------- window port addressing
; UG_WINADDR: in HL = absolute ISA address (<4000h);
;             out HL = window address (0C000h + ISA address)
; clobbers AF,HL
UG_WINADDR:
	set	6,h			; +4000h
	set	7,h			; +8000h -> 0C000h base of window
	ret

; UG_REG_ADDR: in A = register offset; out HL = window address
;   (0C000h + UGCTX.BASE + reg); clobbers AF,HL
UG_REG_ADDR:
	ld	hl,(UGCTX.BASE)
	add	a,l
	ld	l,a
	jr	nc,.hi
	inc	h
.hi:	set	6,h			; +4000h
	set	7,h			; +8000h -> 0C000h base of window
	ret

; UG_PORT_R: in HL = absolute ISA port; out A = value; clobbers AF,HL
UG_PORT_R:
	call	UG_WINADDR
	ld	a,(hl)
	ret

; UG_PORT_W: in HL = absolute ISA port, A = value; clobbers AF,HL
UG_PORT_W:
	push	af
	call	UG_WINADDR
	pop	af
	ld	(hl),a
	ret

; UG_REG_R: in A = register offset; out A = value read; clobbers AF,HL
UG_REG_R:
    IFDEF UG_BENCH_TIMING
    call BENCH_STATUS_COUNT
    ENDIF
	call	UG_REG_ADDR
	ld	a,(hl)
	ret

; UG_REG_W: in E = register offset, A = value; clobbers AF,HL
UG_REG_W:
	push	af
	ld	a,e
	call	UG_REG_ADDR
	pop	af
	ld	(hl),a
	ret

UG_BULK_WRITE:
    ld de,(UGCTX.BASE)
    set 6,d
    set 7,d
    ld a,b
    or a
    jr nz,.general
    ld a,c
    cp 8
    jr nz,.general
    DUP 8
    ld a,(hl)
    ld (de),a
    inc hl
    EDUP
    ret
.general:
    ld a,c
    and 7
    ld (UGTM.LO),a
    srl b
    rr c
    srl b
    rr c
    srl b
    rr c
    ld b,c
    ld a,b
    or a
    jr z,.tail
.loop:
    DUP 8
    ld a,(hl)
    ld (de),a
    inc hl
    EDUP
    djnz .loop
.tail:
    ld a,(UGTM.LO)
    ld b,a
    or a
    ret z
.bytes:
    ld a,(hl)
    ld (de),a
    inc hl
    djnz .bytes
    ret

; Eight unrolled reads per iteration; only the SRAM destination advances.
UG_BULK_READ:
    ld de,(UGCTX.BASE)
    set 6,d
    set 7,d
    ld a,b
    or a
    jr nz,.general
    ld a,c
    cp 8
    jr nz,.general
    DUP 8
    ld a,(de)
    ld (hl),a
    inc hl
    EDUP
    ret
.general:
    ld a,c
    and 7
    ld (UGTM.LO),a
    srl b
    rr c
    srl b
    rr c
    srl b
    rr c
    ld b,c
    ld a,b
    or a
    jr z,.tail
.loop:
    DUP 8
    ld a,(de)
    ld (hl),a
    inc hl
    EDUP
    djnz .loop
.tail:
    ld a,(UGTM.LO)
    ld b,a
    or a
    ret z
.bytes:
    ld a,(de)
    ld (hl),a
    inc hl
    djnz .bytes
    ret

; UG_REQ_WRITE: stream BC bytes from HL to X_REQUEST (reg 3)
; clobbers AF,BC,DE,HL
UG_REQ_WRITE:
    IFDEF UG_BENCH_TIMING
    call BENCH_COMMAND_COUNT
    ENDIF
	ld	de,(UGCTX.BASE)
	inc	de
	inc	de
	inc	de			; +UG_REG_X_REQUEST
	set	6,d
	set	7,d
.wr:	ld	a,b
	or	c
	ret	z
    call UG_FRAME_YIELD
	ld	a,(hl)
	ld	(de),a
	inc	hl
	dec	bc
	jr	.wr

; UG_RESP_READ: read BC response bytes from X_REQUEST (reg 3) to DE
; clobbers AF,BC,HL; DE advances
UG_RESP_READ:
    IFDEF UG_BENCH_TIMING
    call BENCH_RESPONSE_COUNT
    ENDIF
	ld	hl,(UGCTX.BASE)
	inc	hl
	inc	hl
	inc	hl
	set	6,h
	set	7,h
.rd:	ld	a,b
	or	c
	ret	z
    call UG_FRAME_YIELD
	ld	a,(hl)
	ld	(de),a
	inc	de
	dec	bc
	jr	.rd

; UG_RESP_SKIP: consume and discard BC response bytes from X_REQUEST
; clobbers AF,BC,HL
UG_RESP_SKIP:
	ld	hl,(UGCTX.BASE)
	inc	hl
	inc	hl
	inc	hl
	set	6,h
	set	7,h
.rd:	ld	a,b
	or	c
	ret	z
    call UG_FRAME_YIELD
	ld	a,(hl)
	dec	bc
	jr	.rd

; ---------------------------------------------- optional write methods
UG_BULK_WRITE_ALIAS:
    ld de,(UG_ALIASCFG)
    set 6,d
    set 7,d
    jp UG_ALIAS_COPY
UG_BULK_READ_ALIAS:
    ex de,hl
    ld hl,(UG_ALIASCFG)
    set 6,h
    set 7,h
UG_ALIAS_COPY:
    ld a,c
    cp 8
    jr c,.tail
.loop:
    DUP 8
    ldi
    EDUP
    ld a,c
    cp 8
    jr nc,.loop
.tail:
    ld a,b
    or c
    ret z
    ldi
    jr .tail

; UG_BULK_WRITE_STACK: switched-SP burst (spec 11.4).  SP <- source for
; the duration of the burst; pairs are POPped and written as two bytes
; to BULK_DATA.  Precondition (verified by the caller): UG_NMI_PROFILE
; == 1, because DI does not mask NMI.  CALL/PUSH are absent inside the
; burst.  The odd tail byte is written the ordinary way AFTER SP is
; restored.  in HL=src, BC=n.  clobbers AF,BC,DE,HL; SP restored.
UG_BULK_WRITE_STACK:
	ld	a,c
	and	1
	ld	(UGTM.LO),a		; odd-tail flag
	ld	(UGTM.HI),sp		; save the real stack pointer
	ld	sp,hl			; SP <- source bytes
	ld	hl,(UGCTX.BASE)
	set	6,h
	set	7,h			; HL -> window BULK_DATA
    srl b
    rr c
    ld a,c
    and 7
    ld (UGTM.LO+1),a
    srl b
    rr c
    srl b
    rr c
    srl b
    rr c
    ld b,c
    ld a,b
    or a
    jr z,.pairs
.sw:
    DUP 8
    pop de
    ld (hl),e
    ld (hl),d
    EDUP
    djnz .sw
.pairs:
    ld a,(UGTM.LO+1)
    ld b,a
    or a
    jr z,.sw_done
.pair:
    pop de
    ld (hl),e
    ld (hl),d
    djnz .pair
.sw_done:
	ld	hl,0
	add	hl,sp			; HL = odd-byte address (src+2k)
	ld	sp,(UGTM.HI)		; real SP restored BEFORE the tail
	ld	a,(UGTM.LO)
	or	a
	ret	z			; even n: done
	ld	a,(hl)			; odd tail byte, ordinary path
	ld	de,(UGCTX.BASE)
	set	6,d
	set	7,d
	ld	(de),a
	ret

	ENDIF ; ISA_INC
