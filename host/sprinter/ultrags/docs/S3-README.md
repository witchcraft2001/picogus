# Ultra GS S3: memory tools

Software evidence is HOST / DSS-EXE only. Physical PSRAM, SCK, temperature,
ISA/IOCHRDY/DACK, RESET DRV and audio gates remain REAL_PENDING.
This stage does not implement upload, ROUNDTRIP, SEAL, GS music or playback.

## Tester Notes

Install the supplied PGMULTI.UF2 by the established BOOTSEL/SWD procedure.
On Sprinter DSS (default slot 0, no automatic scan):

```text
UGCFG MODE ULTRAGS
UGMEM INFO
UGMEM TEST QUICK
UGMEM TEST FULL
UGMEM LIST
UGMEM RESET WARM
UGMEM RESET COLD
UGMEM INFO
```

On a working APS6404L board expect `physical=8388608 pool=8388608`, initially
`free=8388608 largest=8388608 objects=0 limit=128`, and `first_bad=0xFFFFFFFF`.
QUICK compares 92 bytes on the 8 MiB pool; FULL compares 125829120 bytes.
The startup identification/alias matrix compares an additional 8 bytes.
`tested` counts actual byte comparisons, including repeated passes and the
failing comparison. SPI I/O failures do not increment it for unread bytes.
FULL uses 15 separate write/read passes: 00/FF/55/AA, three address bytes and
eight walking-one bits. QUICK writes distinct address-line/boundary markers
before reading, then repeats with their complement. It includes the last byte.

TEST requires an empty store; a BUSY result preserves objects and does not
silently reset transport or storage. RESET deliberately destroys every object,
changes session, preserves port settings and volatile GS aliases, and writes no
Flash. COLD also runs QUICK. Failure is reported; INFO gives the new session.
A memory error blocks allocation until a successful memory test. Cancellation
alone does not clear that error. Handles are never reused within a session.

`FREE 65535` and `FREE 0xFFFF` are equivalent; handles outside u16 are rejected.
`/SLOT:1`, `/BASE:0280`, `/QUIET`, `/?` and optional frame CRC `/VERIFY` are
supported. Names and options are case insensitive. INFO prints byte counts in
decimal, handles/session/error addresses in hexadecimal, and every run ends
with RESULT PASS/FAIL and a DSS exit code. RESET warnings remain visible in
QUIET mode. No extra confirmation is required.

ESC and the DSS clock are checked with the ISA window closed. UGMEM uses at
most eight frame bytes per window. Its timed RPC profile waits one DSS clock
second for ordinary commands and 120 seconds for tests/cold reset, accumulates
second changes across minute/day boundaries, and bounds polling if the clock
stops. The DSS clock has one-second resolution; these are not subsecond timing
measurements. Interrupt state, PAGE3, system mapping and stack are restored.

PGULTRA.UF2 is standalone ULTRAGS at Flash origin; PGSLOW.UF2 is standalone with
a nominal 50 MHz SCK profile. Both support UGMEM without a multifw catalogue.
UGCFG MODE requires PGMULTI. Standalone images replace the bootloader.
Diagnostic images and UGTEST/UGBENCH remain separate S1 tools; ST-*.EXE are
intentionally defective harness fixtures and must not run on hardware.

## Memory/backend evidence

Backend gitlink remains `419375d5af2af2c72af63cdab6c6df2c558a3a9c`.
Ultra GS alone force-includes bounded DMA waits; upstream source and every
other mode retain their original backend behavior. Adapter transactions finish
only after all DMA, empty TX FIFO, PIO at begin and deasserted CS. Transactions
split at backend 31-byte read / 27-byte write limits and 1 KiB page boundaries.
Timeout aborts the DMA; a retry reinitializes the same locked profile. No heap
is used for the 128-entry object table. Free gaps coalesce implicitly when an
entry is removed from the address-sorted table.

Identification uses command 9Fh with three address bytes, AP Memory MFID=0Dh
and KGD=5Dh; EID density 0/1/2 is cross-checked against 2/4/8 MiB alias results.
A legacy all-ones EID carries no usable density hint: the 1/2/4/8 MiB result
must still pass the alias matrix and address-line tests. This is model coverage,
not a claim that a particular 1 MiB physical part was tested. Unknown IDs or
unsupported density are rejected. A known density with mismatched aliasing is
PSRAM failure. With legacy EID, the last-written marker is checked before
decoding the alias period: corrupt data is PSRAM failure, while regular
unsupported 3/5/6/7 MiB periods return UNSUPPORTED_MEMORY.
ID reference: [AP Memory APS6404L datasheet, Read ID](https://www.apmemory.com/en/downloadFiles/0324112120mm608993).

At nominal clk_sys=370 MHz, baseline div256=473 gives calculated SCK
100126849 Hz; slow div256=947 gives 50010559 Hz. Both normal and fudge use two
instructions per steady-state bit. PicoGUS 2 tries normal then fudge;
Pico-based tries fudge then normal. The first passing profile is locked until
reboot; RESET_STORE does not change it. The two attempt records remain in SRAM
(`ug_psram_attempts`, `ug_psram_attempt_count`) and are printed by PGDEBUG builds.
No new wire fields or protocol version are introduced for these diagnostics.
Record the board marking, measured clocks, temperature and error counts for
both firmware profiles on the physical bench; no frequency is hardware-approved.

PIO registry writes by core0 finish before core1 starts resource initialization.
ISA is PIO0 SM0/1; M62429 PIO1 SM0; PSRAM PIO1 SM1/DMA2/3/4; I2S PIO1 SM3/DMA0/1;
DMA5 reserved. Runtime audits and instruction accounting cover these resources.

## Review verification

The HOST gate additionally executes the pinned `psram_spi.c/.h` with only
SDK/peripheral boundaries mocked. It covers reset-command DMA waits, both PIO
variants, synchronous and async command packing, 1 KiB splits, transaction tails,
independent DMA/last-bit/CS completion, stuck DMA/CS, a stopped timer, teardown
and reinitialization. Recovery revalidates DMA claims and reserves DMA5 even if
startup failed before its resource audit. It complements the 1/2/4/8 MiB job/store/dispatcher tests;
neither model replaces electrical bench measurements.

CAPS reads the volatile GS alias setting atomically across cores. A failed
adapter initialization still returns the 14-byte PSRAM MEM_TEST diagnostic:
`tested=0 first_bad=0xFFFFFFFF`; no comparison was possible. The model preserves
memory failures through WARM and cancellation, blocks allocations until a
successful test, and completes memory jobs only when their reply becomes ready.
Shared C/model fixtures compare status, payload size and all diagnostic bytes
except `elapsed_ms`, which depends on each model's clock/peripheral duration.
The byte-comparison counts and failure address/values must agree exactly.

The standard make targets explicitly select the 100 MHz profile, including both
multifw entry points; only PGSLOW selects 50 MHz. Build evidence rejects stale
HOST summaries/backend results and stale executed UGMEM bytes. Software gates
remain HOST_PASS / DSS-EXE_PASS with REAL_PENDING; ASan may be SKIP when the
standalone runtime probe cannot start on the host.
