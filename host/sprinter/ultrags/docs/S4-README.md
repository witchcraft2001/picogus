# Ultra GS S4: slow BLOB transport

Protocol 4, API 1.0 and Settings v6 are unchanged. S4 implements BLOB
ALLOC → WRITE → SEAL → READ → FREE through GS_DATA, with 1024-byte blocks and
closed ISA windows between latch polls. Default FAST computes no host CRC.
`/VERIFY` enables frame CRC, block verification and streaming file CRC;
UGLOAD additionally rereads the source and compares the complete readback.
`/CRC:hhhhhhhh` alone verifies a known file CRC at SEAL without host CRC.
BULK/FIFO, music formats, legacy LOAD and playback remain unsupported.

Use slot 0 by default; specify `/SLOT:1` for the other slot. All utilities
accept `/BASE:hex`, `/QUIET` and `/?`. There is no scan or automatic MODE/reset.
UGDUMP accepts `/OFFSET:N /LENGTH:N`; absent LENGTH means size minus OFFSET,
and the whole range must lie within uploaded. Existing files survive unless
`/OVERWRITE` is supplied. An output left after failure is marked INCOMPLETE.
UGDUMP prints `host_crc=NOT_COMPUTED` in FAST; `/VERIFY` prints the streaming
CRC of exactly the requested range, including CRC zero for an empty range.
Options specific to a different utility are rejected as syntax errors.
Exit codes and the final ASCII RESULT line follow §11.1.

Tester Notes:

```text
UGCFG MODE ULTRAGS
UGMEM ROUNDTRIP 65536 /SLOW
UGMEM ROUNDTRIP 8388608 /SLOW
UGLOAD TEST.BIN /TYPE:BLOB /SLOW /VERIFY
UGDUMP <received_handle> BACK.BIN /SLOW /VERIFY
UGMEM FREE <received_handle>
UGTEST PROTO
```

Compare TEST.BIN with BACK.BIN. ROUNDTRIP must remove its temporary object;
free memory must return to the starting value. PROTO checks short/extra/CRC,
oversized framing, preserved data and recovery without reboot. File and print
calls occur only outside a grant; clock/key calls require a closed ISA window.
Lost END acknowledgement triggers TRANSPORT_RESET and INFO/OBJECT_INFO recovery;
no non-idempotent operation is blindly retried. An unknown ALLOC result is
reported without freeing an unknown handle. Cleanup checks the original session.

Run `make -f Makefile.ultrags s4-package` with the pinned SDK/extras/GCC/Python.
Repeat with `BUILD=build/S4-review`. ZIP/IMG contain exactly executed EXEs;
separate PGMULTI, PGULTRA, PGSLOW, PGDEBUG and diagnostic UF2 files carry
hashes, flash map and build provenance. Standalone and diagnostic UF2 replace
all flash, including the multifw bootloader; restore PGMULTI to use MODE again.
The floppy is a FAT12 data image, not a DSS system boot disk.

HOST and DSS-EXE results describe automatic C/UBSan and actual Z80 execution
under mocks. REAL remains pending. C00 is mandatory before physical S4
acceptance. Physical PSRAM/ISA, SCK/LRCLK, voltage/temperature and 8 MiB SEAL
≤30 seconds need hardware evidence. SRAM diagnostic symbols
`ug_seal_elapsed_us`, `ug_service_max_us` and `ug_spi_slice_max_us` record the
completed SEAL duration, maximum interval between core1 maintenance/dispatcher
opportunities and largest SPI/CRC slice. VERIFIED WRITE_END CRC is also split
into at most 256-byte slices before commit. Mock timing is not hardware timing.
I2S continues digital zero.
