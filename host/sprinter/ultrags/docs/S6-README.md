# Ultra GS S6: resident RAW/WAV and independent FX

Software gate: **HOST_PASS / DSS-EXE_PASS / REAL_PENDING**. S6 remains
**IN_PROGRESS** until the physical measurements below pass. API 1.0 and Settings
are unchanged. MOD, legacy GS loading and playlists belong to later stages and
are rejected by the S6 CLI before hardware access.

Load an asset once, keep its printed object handle, play it repeatedly, then free
it explicitly. A handle identifies stored bytes in the printed session;
`play_id` and `fx_id` identify individual playback instances.

```text
UGLOAD T11025.RAW /TYPE:RAW /RATE:11025 /BITS:8 /CH:1 /FMT:U8 /VERIFY
UGPLAY HANDLE <printed-handle> /WAIT
UGPLAY HANDLE <printed-handle> /WAIT
UGLOAD S44100.WAV /TYPE:WAV /VERIFY
UGPLAY HANDLE <wav-handle> /LOOP
UGPLAY PAUSE
UGPLAY RESUME
UGPLAY STOP
UGMEM FREE <raw-handle>
UGMEM FREE <wav-handle>
```

RAW requires all four metadata options; 8-bit accepts U8/S8 and 16-bit accepts
S16LE. Rates are 8000–48000 Hz. WAV is uploaded whole and parsed on the card.
Default transfer is BULK FAST without host CRC. UGLOAD keeps `/SLOW`, `/VERIFY`
(frame/data/file CRC plus full byte readback) and `/CRC:hhhhhhhh` (known object
CRC, without a host CRC loop). Sizes and offsets are u32; memory admission checks
free bytes, largest extent and object capacity before ALLOC.

UGPLAY can also load a file directly:

```text
UGPLAY T11025.RAW /RATE:11025 /BITS:8 /CH:1 /FMT:U8 /WAIT
UGPLAY S44100.WAV /WAIT
UGPLAY S44100.WAV /LOOP /REPLACE
```

An active or paused foreground requires `/REPLACE`. The new object is validated
before PLAY replaces it. READY RAW/WAV assets survive EOF, STOP, ESC and program
exit. EOF, STOP and ESC release playback pins. After ordinary PLAY ACK and
program return, the card keeps playing and retains its pins until playback ends
or is stopped, as required by specification §1.1. A failed PLAY leaves the READY
handle available. FREE while playing or paused returns PINNED. An incomplete
upload is cancelled and only its own object is freed, after checking the session.
Setup rejects a session change before opening the file or allocating, so the
printed session always identifies the loaded handle's store.
File upload/readback rechecks the session after DSS file calls and before the
next card operation; a reused LOADING handle in a new store is never overwritten.

FX use dedicated lanes and keep foreground playback intact:

```text
UGPLAY FX SHOT.WAV
UGPLAY FXHANDLE <handle> /LOOP /GAIN:48 /PAN:64 /PRIORITY:100
UGPLAY FXHANDLE <stereo-handle> /VOICE:8 /STEAL /PRIORITY:200
UGPLAY FXPAUSE <fx-id>
UGPLAY FXRESUME <fx-id>
UGPLAY FXSTOP <fx-id>
UGPLAY FXSTOP ALL
UGMON /COUNT:20 /HZ:5
UGTEST PCM
UGTEST FX
```

Defaults: auto lane allocation, priority=128 (allowed 1–254), gain=64, pan=128. Stereo reserves an
atomic even pair; four mono or two stereo FX fit. NO_VOICE leaves foreground and
existing FX unchanged. `/STEAL` can replace only lower-priority FX. STOP/PAUSE/
RESUME optionally accept an explicit foreground play ID; FX controls require an
FX ID, except `FXSTOP ALL`. `/WAIT` follows the launched instance; ESC stops only
that instance. ESC in UGMON exits the monitor and leaves sound playing.

UGMON prints coherent SNAPSHOT and FX_STATUS records, source position, eight
musical channel records, memory, peaks, clips, transfer and error counters. Its
interval uses the card's output_frames (default 5 Hz, allowed 1–10 Hz); a stalled
counter has a bounded watchdog. A lost PLAY response triggers TRANSPORT_RESET and
session/state reconciliation. A newly observed token for the requested handle
can confirm the start; an already-ended short FX may be unconfirmable and returns
TIMEOUT / PLAY_RESULT_UNKNOWN_NOT_RETRIED. ALLOC and PLAY are never blindly retried.
Lost SEAL responses are reconciled in the original session too: a READY PCM is
kept and its handle printed with TIMEOUT / SEAL_RESULT_READY_NOT_RETRIED. No PLAY
is issued after that timeout. FX WAIT checks for new PSRAM errors when the token
disappears, so a render fault reports AUDIO_PLAYBACK_ERROR rather than normal EOF;
an old sticky error does not turn a later successful run into a failure.
Playback options are checked against the command before hardware access; for
example `STOP /GAIN:1` is a syntax error. `/TYPE` belongs to UGLOAD; UGPLAY selects
RAW/WAV from the file extension. `/SLOW` and `/CRC` require a file upload.
UGTEST cleanup also reconciles lost PLAY replies by its own temporary handle,
stops only matching instances and frees its test asset without stopping a foreign
foreground used during the FX suite.

All ISA sections retain the [ISA/Turbo contract](ISA-TURBO.md): SYS_PORT.RAM=2
inside, SYS_PORT.RAM=3 after close, restored PAGE3/IFF and at most eight payload
bytes per window. Buffers, metadata, requests and stack have assembly bounds
below C000h. File and console operations run outside windows and grants.

## Reproduce and inspect

Use the pinned toolchain/environment described in the main specification:

```sh
make -f Makefile.ultrags s6-package BUILD=build/S6-complete-a
make -f Makefile.ultrags s6-package BUILD=build/S6-complete-b
python3 tools/ultrags/s6-compare.py --build build/S6-complete-a --review build/S6-complete-b
```

The package is `build/<name>/ultrags/s6-package/`: current EXEs, `ug-s6.zip`,
DSS-readable FAT12 `ug-s6.img`, eleven firmware profiles, provenance, full
regression evidence, shared C/model vectors and indexed S16LE audio goldens.
Container extraction is independently compared with the executed EXE bytes.
`MANIFEST.TXT` maps the synthetic fixture names to their 8.3 disk names. Large
PCM/goldens are supplied beside the disk image. `PGMULTI.UF2` contains all seven
modes; standalone `PGULTRA.UF2` replaces the bootloader and other modes. POSTED
images remain experimental. ST-*.EXE include deliberately defective harness tests.

HOST checks cover 1890 exact scalar cases at the eight normative rates plus 12345
Hz, U8/S8/S16LE, mono/stereo, gains/pan, repeats/loops, clipping, exact frame
accounting, source phase across 1/2/4 MiB and the exact 8 MiB EOF. The independent
DSS model has rational time, queue16, pins, EOF, controls, atomic allocation/steal,
cyclic IDs and error injection, and replays vectors emitted by production C.
Actual-EXE checks cover the CLI, both slots, EI/DI, software Turbo on/off, hardware
inhibit, PAGE3, file/format/CRC errors, lost responses, session changes and targeted
WAIT/ESC. Full S0–S5 regressions include both 8 MiB ROUNDTRIPs and separate ISA/DI
budgets. See REPORT-S6.txt and the comparison report for executed counts/hashes.

## Tester Notes: physical gate

On the Sprinter/PicoGUS bench, run the command sequences above using the same
packaged EXE/UF2 hashes. Record correct source duration, channel polarity and
stereo balance at all normative rates. Test four mono and two stereo FX, paused
pins, repeated use of the same asset and NO_VOICE without foreground interruption.
While PCM and FX play, run verified upload of a second WAV and `UGDUMP
<playing-handle> READBACK.RAW /VERIFY`; require matching original bytes, no clicks
and zero underruns. Verify that malformed WAV reports FORMAT and that FREE works
after EOF/STOP, with the READY asset still listed beforehand.

Measure LRCLK (nominal 48000 Hz), uninterrupted BCLK/I2S through pause/stop/EOF,
worst render quantum <=75%, bus timing and separate ISA/DI sections. Record board,
clock, PSRAM profile, temperature, underruns and audio captures. HOST/DSS evidence
cannot establish those measurements. MAME is not claimed; REAL remains pending.
