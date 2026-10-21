; SPDX-License-Identifier: GPL-2.0-or-later
; Deterministic 8CHN smoke: eight pitches, one short loop, low source volume.
S8MOD_DATA:
    DS 20,0
    DS 22,0
    DB 0,16,0,12,0,0,0,16
    DS 30*30,0
    DB 1,0
    DS 128,0
    DB "8CHN"
    DB 3,88,16,0
    DB 3,40,16,0
    DB 2,250,16,0
    DB 2,208,16,0
    DB 2,166,16,0
    DB 2,128,16,0
    DB 2,92,16,0
    DB 2,58,16,0
    DS 2048-32,0
    DS 16,64
    DS 16,192
S8MOD_END:
