# Ultra GS S6 PCM engineering increment

This build adds RAW/WAV PCM metadata, cooperative RIFF parsing during SEAL, PCM
foreground control, atomic mono/stereo dedicated FX allocation and production use of
the card-side renderer. The host tests exercise parser, storage, pin and basic
render paths under UBSan. Status: HOST_PARTIAL / DSS-EXE_PENDING / REAL_PENDING.

This increment is not S6 accepted. UGLOAD RAW/WAV, UGPLAY, UGMON and UGTEST
PCM/FX applications and their actual-EXE harness are still outstanding. The
current standalone UF2 is for firmware review and has not been measured on a
physical PicoGUS/Sprinter setup.

## Current host checks

```text
make -f Makefile.ultrags s6-host BUILD=build/S6-main
```

The suite checks RAW descriptor constraints, WAV chunk boundaries and padding,
unknown chunks, data-before-fmt, malformed/duplicate chunks, WAV metadata after
SEAL, foreground PCM PLAY/PAUSE/RESUME/STOP, four mono or two stereo FX, paused
ownership and atomic steal, a 16-event quantum-boundary queue, >65535 FX starts,
reset/fault pin cleanup and background upload/SEAL/readback. An independent scalar
oracle checks 1890 combinations of nine rates (the eight normative rates plus
12345 Hz), three formats, channels, pan, repeats and loops, exact samples and
duration, source offsets beyond 4 MiB, clipping and 20 ms peaks. DMA mocks check
both completion IRQs, immutable READY/DMA ownership and starvation/maintenance
recovery.

See [S6-REVIEW.md](S6-REVIEW.md) for review findings, executed checks and remaining
plan items. The engineering package contains four executed host binaries and
logs. Its verifier compares every payload with current build artifacts and
fresh generated fixtures; negative checks reject rehashed substitutions and empty
provenance. This is still a subset package, without S6 DSS EXE/ZIP/IMG acceptance.

## Tester Notes for the remaining DSS/REAL gate

Once the DSS programs are delivered, run the planned commands with the S6
HANDSHAKE image and collect console transcripts plus audio captures:

```text
UGLOAD T11025.RAW /TYPE:RAW /RATE:11025 /BITS:8 /CH:1 /FMT:U8 /VERIFY
UGPLAY T11025.RAW /RATE:11025 /BITS:8 /CH:1 /FMT:U8 /WAIT
UGPLAY S44100.WAV /WAIT
UGMON /COUNT:20
UGPLAY FX SHOT.WAV
UGPLAY FX STEREO.WAV
UGPLAY FXSTOP ALL
UGLOAD FX8.WAV /TYPE:WAV /VERIFY
UGDUMP <playing-handle> READBACK.WAV /VERIFY
UGTEST PCM
UGTEST FX
```

Expected results: correct 11025/44100 source duration and channel polarity;
four mono or two atomic stereo FX independent of foreground; NO_VOICE leaves
foreground intact; UGMON shows advancing source frames; concurrent verified
upload/readback produces no clicks or underruns; malformed WAV returns FORMAT;
pins clear after STOP/EOF. Physical LRCLK, quantum timing, underruns and audible
channel results must be recorded before REAL can pass.
