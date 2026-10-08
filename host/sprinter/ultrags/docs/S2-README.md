# S2: multifw configuration stage

Software evidence is recorded under `build/ultrags/logs/` and
`build/S2-review/ultrags/logs/`. Hardware acceptance remains REAL_PENDING.
S1 electrical/timing gates and C00 remain open. No storage or music playback is
implemented by the S2 mode8 firmware; unsupported commands return BAD_OPCODE.

Build with the pinned toolchain from the specification:

```
make -f Makefile.ultrags s2-package
make -f Makefile.ultrags s2-package BUILD=build/S2-review
```

The resulting `ultrags/s2-package/` directory contains:

- `PGMULTI.UF2`: seven-image bundle, IDs 1–6 and 8. ID7 is known but absent.
- `PGULTRA.UF2`: independent standalone ULTRAGS at Flash origin. Installing it
  replaces the bootloader. It does not advertise a multifw catalogue.
- `ug-s2.zip` and `ug-s2.img`: identical executed DSS EXEs and fixtures. The IMG
  is a DSS-readable FAT12 data disk, not a claim of a bootable DSS system disk.
- Flash map, hashes, compiler provenance and software report.

UGCFG targets PGMULTI only. UGTEST/UGBENCH target the separate S1 standalone
ULTRAGS_DIAG firmware. UGDIAG and ST-* target the host model; ST-* includes
intentionally defective tests and must not run on hardware. Do not use those
programs as playback or production-mode tests.

Before installing either firmware, follow the S1 full-flash backup and BOOTSEL
recovery procedure. Restore the bundle using BOOTSEL/SWD to recover multifw;
UGCFG selects installed images and does not flash firmware.

Tester Notes (physical Sprinter, explicitly selected free ISA slot):

```
UGCFG LIST /SLOT:0
UGCFG MODE ULTRAGS /SLOT:0
UGCFG VERIFY /SLOT:0
UGCFG INFO /SLOT:0
UGCFG MODE GUS /SLOT:0
```

LIST must show IDs 1–6 and 8 present, ID7 ABSENT. Only images verified this boot
carry VERIFIED. Mode8 must report active=08, boot_result=00 and ready INFO/API1.
One MODE produces one watchdog reboot. No reset loop is acceptable.

Repeat with slot1 only if that is where the card is installed. No slot scanning
is performed. Repeat on both 21 MHz and 3.5 MHz CPU profiles.

```
UGCFG MODE ULTRAGS /SAVE
UGCFG PORTS 02A0 OFF /SAVE
UGCFG GSALIAS ON
UGCFG SAVE
```

Check the printed alias conflict warning before using 00B3/00BB on a shared bus.
After power-cycle, base=02A0 and startup ULTRAGS should persist; GS aliases must
be OFF. Repeat a MODE without SAVE and verify power-cycle returns to the saved
startup mode. Assert RESET DRV after watchdog mode switching: it must use saved
startup mode, with the old scratch request consumed. Record raw WATCHDOG_REASON
and CHIP_RESET through ug_raw_watchdog_reason/ug_raw_chip_reset in the bootloader
or active runtime using SWD; the runtime copies survive image startup. No hardware
values are inferred by the HOST tests.

```
UGCFG MODE 7
UGCFG MODE 9
UGCFG PORTS 01E0 OFF
UGCFG PORTS 02A0 02A0
```

Expect explicit failure and no saved changes. On an isolated address-safe bench,
exercise `PORTS 02A0 0280`, then `PORTS 0280 02A0`: the final pair must read back.
Fault/CRC/fallback and failed rollback are tested in HOST fixtures; do not corrupt
working Flash to reproduce them. PARTIAL_CONFIGURATION forbids SAVE.

SAVE runs on core1, holds a fixed Settings snapshot, and UGCFG waits for its
completion before REBOOT. In mode8 it requires idle transport and outputs digital
zero around Flash maintenance. Physical clock recovery and persistence still
require hardware verification. Standalone builds and old protocol4 firmware
without UGCF allow read-only diagnostics; mutations are refused.

MODE waits for identification to disappear and return before checking the new
boot; an ignored REBOOT cannot pass by returning the old active mode. The reboot
and mode8 INFO checks share one ten-second deadline. Corrupt INFO frames are
rejected before interpreting API or boot_state. A rejected PORTS write reports
PARTIAL_CONFIGURATION only when the original pair cannot be read back or restored.
