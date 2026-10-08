; SPDX-License-Identifier: GPL-2.0-or-later
; NEGATIVE: a genuine infinite machine-code loop must hit the runner budget.
	INCLUDE "st-head.inc"
.loop:	jr .loop
	INCLUDE "st-tail.inc"
