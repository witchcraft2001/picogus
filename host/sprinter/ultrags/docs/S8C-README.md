# S8c: source PCM formats and producer measurements

**HOST_PASS / REAL_PENDING for this extension; S8c IN_PROGRESS.**
The preceding SHORT.WAV result remains **REAL_FAIL**: 10 underruns at
BUFFER/PREFILL 256/128 KiB, 5 at 512/256 KiB. The required
44100/S16LE/stereo consumption is 176400 B/s; minimum useful producer speed
220500 B/s, optimization target 352800 B/s. Accepting lighter source formats
will not close that failure. Sustained 44100 optimization is the next step.

REAL 2026-10-21 13:16 update: the supplied screen shows stereo U8/22050
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
The issued UF2/EXEs/ZIP/IMG remain unchanged; this is a result update.

Install the **new `build/CURRENT.UF2`**, then replace the EXEs together from
`build/CURRENT.ZIP`. The decoder changed: replacing only EXEs is insufficient.
Use the normal BOOTSEL procedure, then `UGCFG ULTRAGS` and `UGMEM INFO`.
Builds and current delivery stay in `build/`; independent reproduction stays
in `build/reproducibility/`. `build/latest/` points to `build/`.
ZIP contains tools, instructions and WAV tests; UF2 and IMG are separate.
The 1.44 MiB IMG contains tools and PCM441.WAV smoke audio; copy the two
15-second original-format WAVs from the ZIP to the Sprinter disk.

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
Both retain 4 KiB disk read-ahead and single-RPC FEED, preserve PAGE3/IFF/SP,
and keep all file/keyboard calls between packets. Physical Turbo-write
stability and ISA wait-state/DI measurements remain pending.

## Benchmarks

```
UGPF STREAM MONO22.WAV /BENCH:ALL /BUFFER:512
UGPF STREAM MONO22.WAV /BENCH:DISK
UGPF STREAM MONO22.WAV /BENCH:FEED /BUFFER:512
UGPLAY STREAM MONO22.WAV /BENCH:ALL /BUFFER:512
```

DISK reads/discards the first min(PCM data length, 1 MiB), using the same
4 KiB buffer and complete-short-read handling. FEED creates without START,
feeds min(BUFFER, 1 MiB) from SRAM with the production STREAM_FEED path,
and closes. No file reading occurs in the measured FEED interval. ALL
runs DISK then FEED. `/VERIFY` with any benchmark is a syntax error; FAST
is the principal measurement. ESC prints the partial benchmark then closes.

Each line prints `bytes`, `delta_frames`, `READ_calls`, `packet_count`, `Bps`.
Elapsed seconds are delta SNAPSHOT.output_frames / CAPS.output_hz (48000).
Bps uses unsigned 64-bit multiplication/division after the end snapshot.
Below 125 ms, on stopped/unavailable counters, or an invalid interval, speed
is `unknown INSUFFICIENT_INTERVAL`; it is not a valid throughput result.
DISK counts actual READ calls including short reads; FEED READ_calls must be0.
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
For each file run all four configurations:

```
UGPF STREAM MONO22.WAV /BUFFER:128 /PREFILL:64
UGPF STREAM MONO22.WAV /BUFFER:256 /PREFILL:128
UGPF STREAM MONO22.WAV /BUFFER:512 /PREFILL:256
UGPF STREAM MONO22.WAV /BUFFER:192 /PREFILL:96 /LOW:32
```

Repeat with STEREO22.WAV. Expected: `required_Bps=44100`, continuous sound,
correct 15-second duration, EOF underruns=0, bytes=661500, RESULT PASS.
Then play the original files larger than PSRAM without conversion; repeat
with four mono FX and two stereo FX. ESC is enough to report a stall.
44100/S16LE/stereo SHORT.WAV remains a separate failing control, not accepted
by these tests. Thirty-minute FX/stability, measured latency headroom, I2S
capture/listening and S10 two-hour/leak tests remain REAL_PENDING.

## Repeatable host checks

```
make -f Makefile.ultrags s8c-check
make -f Makefile.ultrags s8c-arm UG_AUDIO_PYTHON=<python-with-unicorn-2.1.4>
```

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
