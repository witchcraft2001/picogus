; SPDX-License-Identifier: GPL-2.0-or-later
;
; st-tail.inc - shared exits + library tail for the S0b self-tests.
;   st_pass : exit code 0
;   st_failA: A = error byte -> record +3, exit code 1
;   st_fail : exit code 1 (err byte already stored)

st_pass:
	xor	a
	ld	b,a
	jr	st_exit
st_failA:
	ld	(ST_RESULT+3),a
st_fail:
	ld	b,1
	jr	st_exit
st_exit:
	ld	c,DSS_EXIT
	rst	0x10
	halt				; unreachable; trap for the harness

	INCLUDE	"ugproto.asm"		; library text after the app tail

	END	ENTRY
