# S8c: WAV/RAW throughput and PIPE benchmark

**REAL_FAIL — owner result2026-10-22 21:26; further optimization deferred.**
The owner confirmed these commands in photograph order:

| Command | Source bytes | Underruns |
|---|---:|---:|
| UGPF STREAM SHORT.WAV /BUFFER:128 /PREFILL:64 |2646000|17|
| UGPF STREAM SHORT.WAV /BUFFER:256 /PREFILL:128 |2646000|7|
| UGPF STREAM SHORT.WAV /BUFFER:192 /PREFILL:96 /LOW:32 |2646000|15|

All three are44100/S16LE/stereo (15 source seconds), EOF, RESULT PASS code=0.
The owner heard interruptions roughly every1.5-2 seconds lasting about1 second.
Command completion does not meet the continuous-playback requirement. The host
model result below does not establish real producer throughput. This photo
contains no DISK/FEED/PIPE timing or installed binary hashes;512/256 was not
retested. Evidence: `build/host/s8c/real-20261022-212630.json` and its photo.
Further throughput work is deferred at the owner's request. S8c remains an
open MVP requirement. S9 (autonomous preloaded PCM queues) is the next functional
stage; its playback does not need continuous disk feeding. CURRENT archives
remain unchanged; the remainder describes their original host validation.


**Historical release status: HOST_PASS / REAL_PENDING; now REAL_FAIL as above.**
The preceding SHORT.WAV result remains **REAL_FAIL**: 10 underruns at
BUFFER/PREFILL 256/128 KiB, 5 at 512/256 KiB. The required
44100/S16LE/stereo consumption is 176400 B/s; minimum useful producer speed
220500 B/s, optimization target 352800 B/s. This delivery accelerates the producer; new physical measurements are still
required. Lighter formats do not close the 44100/S16LE/stereo failure.

Historical REAL 2026-10-21 13:16 update: the supplied screen shows stereo U8/22050
EOF with661500 bytes and0 underruns (15 source seconds). The 44100/S16LE/stereo
control has176400 bytes and1 underrun (only1 source second); its command,
filename and buffer are not shown. This does not establish improvement over
15-second SHORT.WAV. No listening/complete four-buffer acceptance is inferred.

The owner confirmed these benchmark commands, in screen order:
`UGPF ... /BENCH:ALL /BUFFER:512`, `UGPF ... /BENCH:DISK`,
`UGPF ... /BENCH:FEED /BUFFER:512`, `UGPLAY ... /BENCH:ALL /BUFFER:512`,
all with `STREAM MONO22.WAV`.

| Measured path | Bytes | Delta frames | READ calls | Packets | B/s |
|---|---:|---:|---:|---:|---:|
| DISK (all3 measurements) |661500|111616|162|0|284475|
| UGPF FEED inside ALL |524288|177408|0|512|141852|
| UGPF standalone FEED |524288|177024|0|512|142160|
| UGPLAY FEED inside ALL |524288|289280|0|512|86994|

All displayed rates match floor(bytes*48000/delta_frames). These are physical
runs timed by the card frame clock; LRCLK itself was not independently measured.
UGPF's disk-free FEED is already below176400 B/s and the220500 B/s minimum.
For serial disk+feed work, combining the separate rates estimates about94700 B/s
for UGPF and66600 B/s for UGPLAY; these are inferences, not measured streaming
rates. FEED includes host/protocol/commit costs; their individual shares are
not isolated. `RESULT PASS` reports command completion, not zero underruns or
meeting the speed gate. Hardware optimization of44100 remains open.
Evidence and copied photos: `build/real/s8c/real-20261021-1316.json`.
These figures describe the preceding delivery, before the optimizations below.

Replace the EXEs together from `build/CURRENT.ZIP`; `build/CURRENT.UF2`
is the matching COMPAT R17 firmware with the existing FLT8/FLT4/MOD1..32 and
Gidion fixes. This S8c change does not alter firmware, gain, ring logic or
resampling. Configuration protocol4/API1.0, opcodes and response sizes stay
unchanged. Use the normal BOOTSEL procedure if needed, then `UGCFG ULTRAGS`
and `UGMEM INFO`. Independent copies are in `build/reproducibility/`;
`build/latest/` points to `build/`. UF2 and IMG are separate from the ZIP.
The ZIP also contains two 15-second source-format WAV clips; these large clips
are omitted from the 1.44 MiB IMG. Supply your own 44100/S16LE/stereo WAV.

Every integer rate 8000..48000 Hz, mono/stereo, 8/16-bit is supported.
WAV is ordinary RIFF PCM: U8 or S16LE. Compressed/float/24/32-bit/extensible
are rejected. RAW accepts U8/S8/S16LE; the default is 44100/S16LE/stereo.
An explicit RAW descriptor requires all four `/RATE /BITS /CH /FMT` fields:

```
UGPF STREAM TRACK.WAV /BUFFER:128 /PREFILL:64
UGPF STREAM TRACK.RAW /RATE:22050 /BITS:8 /CH:2 /FMT:U8 /BUFFER:192 /PREFILL:96 /LOW:32
```

Source PCM bytes are transmitted unchanged; the card decodes, interpolates
and resamples to stereo S16/48000. Mono uses one voice and ordinary pan;
stereo uses two. Independent FX continue through stream pause/starvation.
BUFFER, PREFILL and LOW are KiB, arbitrary sizes rather than fixed profiles.
Defaults: BUFFER=512, PREFILL=BUFFER/2, LOW=PREFILL/2. No automatic resizing.
API byte sizes and FEED lengths must align to channels*bits/8; packets are
one source frame through 1024 bytes. Invalid descriptors/sizes fail.
WAV checks descriptor, byte rate, block align, RIFF/chunk bounds and padding;
LIST/JUNK and data-before-fmt work. Duplicate/truncated chunks and partial
source frames fail. Empty RAW drains at EOF. WAV data must be nonempty.

The first line shows rate/channels/bits/format and `required_Bps`.
EOF and ESC print confirmed underruns and acknowledged PCM bytes; unavailable
STATE prints `unknown`. A diagnostic failure cannot replace the primary
error or skip resource cleanup. EOF drains below PREFILL. Starvation retains
phase and taps and resumes at PREFILL. CLOSE/STOP release the ring.
`/VERIFY` enables CRC; FAST omits host PCM CRC.

`UGPLAY.EXE`: Turbo OFF, ISA data windows <=256 bytes.
`UGPF.EXE`: experimental Turbo only during BULK writes, <=1024-byte packet
per window. Commands/reads remain Turbo OFF; no alternate stack writer.
Both use 6 KiB disk read-ahead at 4000h..57FFh after WAV parsing, retain
single-RPC FEED, preserve PAGE3/IFF/SP,
and keep all file/keyboard calls between packets. Physical Turbo-write
stability and ISA wait-state/DI measurements remain pending. Ordinary UGPLAY
at 3.5 MHz has a payload-loop ceiling around162000 B/s before protocol costs;
use UGPF for the 220500 B/s acceptance requirement.

STREAM_FEED allows at most four short status polls per READY/grant/commit
phase before using the existing DSS timer. Once started, that timer is never
restarted; timeout, stopped-clock watchdog and lost-ACK recovery remain.
Only STREAM_FEED service frames use windows up to32 bytes, at Turbo OFF.
Other commands keep their previous eight-byte limit. A packet is acknowledged
only after PSRAM commit; recovery checks next_sequence and never blindly retries.

## Benchmarks

```
UGPF STREAM TRACK.WAV /BENCH:DISK
UGPF STREAM TRACK.WAV /BENCH:FEED /BUFFER:512
UGPF STREAM TRACK.WAV /BENCH:PIPE /BUFFER:512
UGPF STREAM TRACK.WAV /BENCH:ALL /BUFFER:512
UGPLAY STREAM TRACK.WAV /BENCH:ALL /BUFFER:512
```

DISK reads/discards the first min(PCM data length, 1 MiB), using the same
6 KiB buffer and complete-short-read handling. FEED creates without START,
feeds min(BUFFER, 1 MiB) from SRAM with the production STREAM_FEED path,
and closes. No file reading occurs in the measured FEED interval. PIPE reads
and feeds min(data_length, BUFFER, 1 MiB) through the production disk/FEED path
without START; it measures disk plus submission/commit with a free ring.
ALL runs DISK, FEED, PIPE, seeking back to PCM data before each file phase.
An unconfirmed CLOSE stops ALL with an error before the next CREATE; it is
never overwritten by a later successful phase. `/VERIFY` with any benchmark is a syntax error; FAST
is the principal measurement. ESC prints the partial benchmark then closes.

Each line prints `bytes`, `delta_frames`, `READ_calls`, `packet_count`, `Bps`.
Elapsed seconds are delta SNAPSHOT.output_frames / CAPS.output_hz (48000).
Bps uses unsigned 64-bit multiplication/division after the end snapshot.
Below 125 ms, on stopped/unavailable counters, or an invalid interval, speed
is `unknown INSUFFICIENT_INTERVAL`; it is not a valid throughput result.
DISK and PIPE count actual READ calls including short reads; FEED READ_calls
must be0. PIPE bytes/packets count acknowledged payload, not speculative
read-ahead. `RESULT PASS` means command completion; speed acceptance requires
a known PIPE rate >=220500 B/s, with352800 B/s as the target.
Report the complete lines, buffer values, file format, BIOS/DSS and hashes.

The supplied WAVPLAY EXE (SHA256
`18e532ff2aa0bfd5a559c84599ac7d29829593905293a7e82f4e542d5b71c0d6`)
uses DSS READ groups of 8 KiB (routine8770h, DE=2000h at8771h), configures
CBL ports004Eh/004Fh and services audio through an IM2 interrupt at85F0h.
This is a different service path. Our SYSTIME/CMOS polling, disk latency,
packet ACK and actual ISA costs require physical measurement; the host
instruction model cannot establish their real costs or disk headroom.

## Hardware checks

MONO22.WAV and STEREO22.WAV are 15-second prefixes of the user's original
mono16/22050 and stereo8/22050 GorkyPrk.wav. PCM bytes and formats are unchanged;
provenance/hashes are in `build/s8c-test-audio/original-clips.json`.
First run DISK, FEED, PIPE on a 44100/S16LE/stereo file large enough to
fill the benchmark interval; record all complete lines. Then test that same
format in all four configurations:

```
UGPF STREAM TRACK.WAV /BUFFER:128 /PREFILL:64
UGPF STREAM TRACK.WAV /BUFFER:256 /PREFILL:128
UGPF STREAM TRACK.WAV /BUFFER:512 /PREFILL:256
UGPF STREAM TRACK.WAV /BUFFER:192 /PREFILL:96 /LOW:32
```

Expected: required_Bps=176400, correct duration, no data errors, no unplanned
underruns, clean EOF/ESC and DSS return. Also repeat with a file larger than
8 MiB PSRAM, then30 minutes with four mono FX and separately two stereo FX.
Exercise both slots and FAST/VERIFY; record BIOS/DSS, file and firmware hashes,
ring sizes and the maximum disk stall. The supplied lighter clips are extra
regressions, not replacements for this control. Historical SHORT.WAV failures
remain REAL_FAIL until the owner supplies new results. Physical timing/DI,
I2S capture/listening, latency headroom and S10 two-hour/leak tests are pending.
After S8c the next functional stage is S9: autonomous PCM sequences.

## Current host result (2026-10-22)

Both independent builds pass:1914 general DSS checks,220 UGPLAY streaming
cases (including9 MiB),219 UGPF cases,400 S8b cases,56 GS Turbo cases,
C/UBSan streaming and12 exact linked ARM streaming/FX profiles. R17 and S8b
negative evidence checks plus S8c reject27 stale/incomplete/corrupt cases per
build. No gain, resampling or firmware code changed: the seven mode images
match the previous delivery except Ultra GS's build-identity string.

For the same131072 RAW bytes with3 ms added to each READ and50 us added to
SYSTIME/key services, baseline94447e0 versus current UGPF gives:

| Host model counter | Before | After |
|---|---:|---:|
| READ calls |32|22|
| SYSTIME calls |298|171|
| All DSS calls |666|530|
| ISA windows |2985|2741|
| Z80 T-states, excluding injected service delays |8808833|8696310|
| Free-ring producer B/s |239200|273349|

The current PIPE command reports131072 bytes,23368 frames,22 READs,
128 packets,269233 B/s. This is above the220500 minimum in the model and
below the352800 target; physical speed is still unmeasured for these EXEs.
The ordinary UGPLAY model gives PIPE105074 B/s. Neither a benchmark command
PASS nor these host figures close the previous hardware REAL_FAIL.

Nominal modeled maximum DI: UGPLAY1.75 ms, UGPF1.14 ms. Hardware-denied Turbo
control: UGPF6.54 ms, below the10 ms limit but above the2 ms target.
These figures exclude physical ISA wait states; measure them on hardware.
Immediate-completion FEED performs zero SYSTIME calls. ALL preserves a failed
CLOSE and stops before PIPE; all original watchdog/session/CRC gates pass.

## Repeatable host checks

```
make -f Makefile.ultrags s8c-check
make -f Makefile.ultrags s8c-check REPRODUCIBILITY=1
make -f Makefile.ultrags s8c-package
```

Provide the SDK/compiler, Python/Unicorn and original PROPLAY/MOD paths as
for `s8b-check`. `s8c-check` includes those R17/S8b regressions. Performance
comparison rebuilds baseline94447e0 in `build/host/s8c-performance/baseline`,
executes old/new EXEs on identical inputs and saves instruction, DSS READ,
SYSTIME, ISA-window and elapsed-time counters. Long playback is ring-consumer
limited; its polling instruction count can rise when the producer is faster.
Only free-ring submission measures producer capacity. The model cannot
certify real disk/ISA throughput. Reports are in `host/s8c-performance/` and
`evidence/actual-exe*.json` in each build root. Packaging checks both roots,
R17/S8b/streaming evidence freshness, rejects deliberately stale reports and
binaries, and extracts ZIP/IMG to verify every byte before publication.

Production C/UBSan compares exact samples, rational phase and duration against
an independent scalar reference: all eight standard rates plus12345/47999,
U8/S8/S16LE, mono/stereo, minimum/arbitrary rings, 1/2/4-byte packets, cache
laps, starvation/refill, EOF and counters crossing2^32. Storage checks cover
mono pan, PAUSE/STOP, four mono/two stereo FX, lost ACK/CRC/cancel/timeout,
fragmentation and1000 lifecycles. Actual EXEs run against production C with
byte identity/CREATE assertions, >PSRAM input, disk delays and short reads,
benchmark/ESC/unknown diagnostics, PAGE3/IFF/SP/DI guards. Linked Cortex-M0
checks six source profiles with both FX arrangements and no64-bit division
in streaming render. Host results do not certify physical throughput.
