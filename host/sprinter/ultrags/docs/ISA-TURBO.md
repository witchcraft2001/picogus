# ISA guard for Sprinter DSS

Owner decision, 2026-10-18: direct SYS_PORT.RAM (003Ch) writes, 2 before each
ISA window and 3 after closing. DSS normally runs with Turbo enabled. Entry
speed is not detected or restored: an initially slow program returns with
software Turbo enabled too. Hardware Turbo permission is independent.

SYSTEM (1FFDh) is write-only; IN returns mapper data. The supported DSS mapping
uses SYSTEM=11h during ISA and 01h afterwards. PAGE3 and caller IFF are restored.
Close order is SYSTEM=01h, original PAGE3, SYS_PORT.RAM=3, original IFF.
Code and stack must be below C000h. Nested/invalid opens touch no hardware.
The reserved SYSSAVE workspace byte remains at its old address but is unused.
No BIOS call or CONFIG_DE snapshot is involved; CONFIG_DE remains untouched.
The old plan's BIOS failure/register-clobber/bit1 cases therefore do not apply.
Direct OUT has no software failure result; STATE still reports invalid nesting.

CONFIG discovery before UG_OPEN and all native/GS/BULK/ALIAS operations use the
same guard. Consuming reads occur once. Payload chunks are capped at8 even for
CPU21 or larger caller values; GS_DATA uses one-byte latch windows. EXT frames
and SNAPSHOT also yield every8 payload bytes; SNAP_LATCH is issued only once. Existing CLI
CPU hints remain accepted. UGBENCH prints isa_mhz=3.5 and turbo_between=ON.
This describes the requested clock; physical timing still needs measurement.

The harness rejects ISA accesses with effective Turbo enabled, models SYSTEM
read/write asymmetry and a separate FE system page, and advances time at the
current clock. maxWindowUs measures the mapped interval; maxDiUs includes the
forced DI through the closing RET, also for callers that entered with DI.
An already-disabled caller's entire program duration is not a library DI budget.
Tests use independent software Turbo and hardware permission and preserve the
CONFIG_DE fixture even when it contradicts the effective speed.

## Reproduce HOST / actual-EXE checks

For each BUILD=build/isa-turbo-a and build/isa-turbo-b:

```sh
make -f Makefile.ultrags test-dss fixtures BUILD=build/isa-turbo-a
UG_S4_FULL=1 node tests/ultrags/dss/run-s4.mjs . build/isa-turbo-a
UG_S5_FULL=1 node tests/ultrags/dss/run-s5.mjs . build/isa-turbo-a
node tools/ultrags/package-s0b.mjs --stage ISA --exe-dir build/isa-turbo-a/ultrags/dss --fixtures build/isa-turbo-a/ultrags/fixtures --out build/isa-turbo-a/ultrags/package
node tools/ultrags/verify-package.mjs --stage ISA --exe-dir build/isa-turbo-a/ultrags/dss --fixtures build/isa-turbo-a/ultrags/fixtures --package build/isa-turbo-a/ultrags/package
```

These packages contain the existing S0b–S5 DSS tools with the ISA correction.
They do not claim S6 DSS/audio acceptance or replace the firmware bundle.
Source audit hashes are in tests/ultrags/reference/sprinter-isa-sources.json.

## Tester Notes — REAL_PENDING

Baseline BIOS: 3.06. Record BIOS/DSS/board/slot/card firmware and EXE SHA-256.
Use the corrected EXEs from ZIP/IMG with the matching diagnostic or ULTRAGS mode:

```text
UGCFG INFO
UGCFG VERIFY
UGMEM ROUNDTRIP 8388608
UGMEM ROUNDTRIP 8388608 /SLOW
UGLOAD TEST.BIN /TYPE:BLOB /VERIFY
UGDUMP <reported-handle> BACK.BIN /VERIFY
UGBENCH /BYTES:65537 /LOOPS:1 /METHOD:FIXED /CHECK:BOTH
UGTEST BUS /REAL /SLOT:0 /CPU:21
UGTEST BUS /REAL /SLOT:1 /CPU:3.5
```

Run BUS only with the diagnostic firmware as described in S1-README.
Repeat native tests with /SLOT:1 on the second slot, with hardware Turbo allowed
and inhibited, and with software Turbo initially off/on. Check stable reads and
byte comparison, Turbo enabled between windows and after every exit, keyboard
response and advancing DSS clock. Use ESC during transfer; try absence, a bad
file, and bad arguments/help. Help/invalid arguments must not touch Turbo.
Measure both the ISA interval and full DI section (<10ms, target <=2ms), including
switches. Archive transcripts and scope traces. S6 remains IN_PROGRESS and
hardware stability remains REAL_PENDING until these runs are recorded.
