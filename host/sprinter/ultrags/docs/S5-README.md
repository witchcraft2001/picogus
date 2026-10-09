# Ultra GS S5

Release uses HANDSHAKE IOW. POSTED is an experimental build, pending C00/P06/B05/B06 on the physical card and Sprinter. Music, legacy LOAD and playback belong to later stages. Protocol4, API1.0 and Settings v6 remain unchanged.

UGLOAD, UGDUMP and UGMEM ROUNDTRIP select BULK from CAPS. `/SLOW` requires GS_DATA. FAST does not calculate host CRC; `/VERIFY` checks frames/data and readback. A known `/CRC:hhhhhhhh` is checked by SEAL without a host payload CRC loop. Files and printing are outside grants.

UGBENCH allocates its own temporary BLOB and frees it on exit. Defaults: 65536 bytes, four loops, block256, ALL/BOTH/BOTH. It never changes PORTS, MODE or the store. METHOD supports SLOW/FIXED/ALIAS/STACK; DIRECTION supports WRITE/READ/BOTH; CHECK supports NONE/CRC/BOTH. NONE compares bytes outside the timed pass; CRC includes CRC work in setup/END. Separate setup, payload, END and total seconds, command/response/data/status counts and block/chunk are printed. Chunk is the ISA window ceiling actually used by the method (SLOW=1; ALIAS<=32). The DSS clock has one-second resolution; each phase sum has a conservative error of two seconds per timed block. Zero intervals print INSUFFICIENT_INTERVAL. CHECK=BOTH also prints the signed CRC-minus-NONE time for each direction; a small negative delta can occur within clock uncertainty. Counters saturate on overflow, print measurement_overflow=SATURATED and suppress the speed ratio. Timing hooks and counters are part of this benchmark's cost. SOAK repeats until its requested seconds or ESC; a finite stagnant-clock watchdog returns TIMEOUT. `/LOOPS` accepts 1..65535, `/BLOCK` 1..1024, sizes are u32.

Default CPU/NMI profiles are unknown: BULK chunk8, GS_DATA one-byte latch windows, STACK unsafe. The library's explicit CPU21 profile uses chunk32. Larger chunks are harness experiments only. ALIAS uses unrolled LDI and returns to the configured start after each chunk (at most32 bytes). STACK WRITE restores SP before the odd tail and ISA_CLOSE; STACK READ is NOT_APPLICABLE. ALL prints SKIP NOT_CONFIGURED or SKIP UNSAFE_NMI. Explicit unsafe STACK fails before ISA access. No utility automatically declares the NMI profile safe.

`PGMULTI.UF2` is the seven-mode handshake bundle. `PGULTRA.UF2`, `PGSLOW.UF2` and `PGDEBUG.UF2` are standalone images that replace the bootloader. Restore PGMULTI through the normal BOOTSEL/SWD process afterwards. `PGPOST.UF2`, `PGPMULT.UF2`, `PGPDIAG.UF2` and `PGPNOD.UF2` are experimental posted standalone, bundle, diagnostic and diagnostic without DACK. They are supplied separately; no utility flashes them.

Posted IOW uses RX8, explicit PUSH after ADS restoration, no write TX/IOCHRDY and retains DACK. Core0 drains every address. Read fencing includes the preceding capture and queued writes, previews queued PORTS for ownership, asserts its read handshake before applying the remaining queue, and never waits for PSRAM/core1. The finite queue uses the preview's idle/BUSY decisions, so asynchronous command or SAVE completion cannot change its predicted map. GS idle, GS aliases, DEFAULTS and rejected selectors are included. Legacy CONFIG FLASH is rejected in POSTED (firmware status ERROR, CONFIG result BAD_REGISTER); it cannot stop or wait for core1 inside a fence. Update experimental images through BOOTSEL/SWD. HANDSHAKE keeps its existing reflashing behavior. RXSTALL poisons staging and blocks framing until TRANSPORT_RESET. SRAM symbols `ug_posted_diag` and the S4 service counters are debugger diagnostics, outside STATS/SNAPSHOT ABI. Microsecond counters are coarse; physical nanosecond captures are still required.

Physical budgets remain pending:

- Handshake: service maximum <= 0.75 * measured minimum capture gap.
- Posted: drain >= 1.25 * sustained ingress; Q(t)=Q0+arrivals-drained <=6/8, no lost/duplicate bytes or RXSTALL; include CONFIG and foreign ports.
- Read: fence+tail+uncertainty and hold+uncertainty <=floor(0.75*T_ready_validated); assertion+uncertainty <=floor(0.75*T_assert_validated).

Use EXEs extracted from the supplied FAT12 data disk. Test first without aliases:

```text
UGCFG MODE ULTRAGS
UGMEM ROUNDTRIP 8388608
UGMEM ROUNDTRIP 65536 /SLOW
UGLOAD TEST.BIN /TYPE:BLOB /VERIFY
UGDUMP <handle> BACK.BIN /VERIFY
UGMEM FREE <handle>
UGCFG PORTS 02A0 0280
UGBENCH /METHOD:ALL /DIRECTION:BOTH /BLOCK:256
UGBENCH /METHOD:ALL /DIRECTION:BOTH /BLOCK:32
UGBENCH /METHOD:ALL /DIRECTION:BOTH /BLOCK:512
UGBENCH /METHOD:ALL /DIRECTION:BOTH /BLOCK:1024
UGCFG PORTS 02A0 OFF
UGTEST PROTO
```

Expected: MATCH, temporary objects freed, pool restored, aliases off, recoverable errors without reboot. STACK without proven NMI is SKIP. Repeat both slots, CPU21/3.5 and EI/DI, collecting physical traces and temperatures. HOST and DSS CPU model timings do not select an empirically best release method. MAME is not a physical PicoGUS test.

Reproduce with pinned SDK/extras/GCC/Python from the specification:

```text
make -f Makefile.ultrags s5-package BUILD=build/S5-main
make -f Makefile.ultrags s5-package BUILD=build/S5-review
python3 tools/ultrags/s5-compare.py --build build/S5-main --review build/S5-review
```
