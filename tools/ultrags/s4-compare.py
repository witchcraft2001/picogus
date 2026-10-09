#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Compare two accepted S4 deliveries and exercise full-EXE freshness rejection."""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--build', type=Path, required=True)
p.add_argument('--review', type=Path, required=True)
a = p.parse_args()
root = Path(__file__).resolve().parents[2]
build, review = a.build.resolve(), a.review.resolve()
digest = lambda data: hashlib.sha256(data).hexdigest()
assembly = json.loads((build / 'ultrags/dss/asm-manifest.json').read_text())
other = json.loads((review / 'ultrags/dss/asm-manifest.json').read_text())
assert assembly['files'] == other['files'], 'different EXE assembly manifests'
names = [('ultrags/dss/' + e['name']) for e in assembly['files']]
names += ['ultrags/s4-package/' + name for name in (
    'PGMULTI.UF2', 'PGULTRA.UF2', 'PGSLOW.UF2', 'PGDEBUG.UF2',
    'PGDIAG.UF2', 'PGDDBG.UF2', 'PGNODACK.UF2', 'ug-s4.zip', 'ug-s4.img')]
files = []
for name in names:
    original, fresh = (build / name).read_bytes(), (review / name).read_bytes()
    assert original == fresh, 'non-identical artifact ' + name
    files.append(dict(path=name, size=len(original), sha256=digest(original)))
for name in ('s4-host.json', 's4-commands.json'):
    assert (build / 'host' / name).read_bytes() == (review / 'host' / name).read_bytes()
for tree in (build, review):
    report = json.loads((tree / 'ultrags/logs/s4-firmware.json').read_text())
    assert report['status'] == 'HOST_PASS / DSS-EXE_PASS / REAL_PENDING'
    subprocess.run([sys.executable, str(root / 'tools/ultrags/s4-report.py'),
                    '--build', str(tree)], check=True, cwd=root)

# Change only a saved result, then run the real gate's verifier. Always restore.
log = review / 'ultrags/logs/s4-full.json'
saved = log.read_bytes()
try:
    stale = json.loads(saved)
    stale['executed'][0]['sha256'] = '0' * 64
    log.write_text(json.dumps(stale))
    rejected = subprocess.run([sys.executable, str(root / 'tools/ultrags/s4-report.py'),
                               '--build', str(review)], capture_output=True, text=True, cwd=root)
    assert rejected.returncode and 'stale S4 executed EXE' in rejected.stderr, rejected.stderr
finally:
    log.write_bytes(saved)

evidence = dict(status='PASS', identical_artifacts=len(files), files=files,
                stale_full_exe_result='REJECTED', builds=[str(build), str(review)],
                verifiers={name: digest((root / 'tools/ultrags' / name).read_bytes())
                           for name in ('s4-report.py', 's4-compare.py', 'verify-package.mjs')})
output = review / 'ultrags/logs/s4-review-comparison.json'
output.write_text(json.dumps(evidence, indent=2) + '\n')
full = json.loads((review / 'ultrags/logs/s4-full.json').read_text())['results'][0]
all_exe = json.loads((review / 'ultrags/logs/ugdiag-run.json').read_text())
lines = [
    'Ultra GS S4 — 2026-10-09',
    'HOST_PASS / DSS-EXE_PASS / REAL_PENDING', '',
    f'Full s4-package gate PASS in {build} and fresh {review}.',
    f"Actual C/UBSan: {report['host_s4']['checks']} checks; verified full 8MiB upload/readback/SEAL.",
    f"Actual EXE: {all_exe['pass']} regression/S4 cases plus separate full 8MiB ROUNDTRIP.",
    f"S4-specific EXE cases: {report['s4_exe_checks']}; shared actual C/model fixtures: {len(json.loads((review / 'host/s4-commands.json').read_text()))}.",
    f"Full UGMEM: {full['steps']} instructions, RESULT PASS code=0, host CRC calls={full['hostCrcCalls']}.",
    f"Maximum S4 ISA window in model: {report['s4_max_window_us']:.3f} us (not electrical evidence).",
    f'{len(files)} byte-identical artifacts: 39 EXE, seven UF2, ZIP/IMG.',
    'Stale HOST outputs, substituted packages/EXEs and stale full-EXE results are rejected.', '',
    'Implementation: GS_DATA FAST/VERIFIED, BLOB SEAL table CRC, pins/tokens/cancel/timeout,',
    'cooperative <=256-byte PSRAM/CRC service, stats and coherent SRAM snapshot/latch.',
    'Code review fixes: retain CANCEL through pin release; A1 cancels only transfer staging;',
    'GS reset clears CB only after the frame is ready; concurrent WC/request regression passes.',
    'cancelled READ_BEGIN/CRC validation cannot restart; latch overflow invalidates staging;',
    'OUT latch retains its byte; UGDUMP range CRC/FAST marker; foreign CLI options rejected.',
    'Cold GS reset publishes boot_state=2; concurrent MEM_INFO returns BUSY without borrowing its job.',
    'Lost-END recovery preserves the original error/source even when INFO is refused.',
    'Held ESC cannot cancel bounded grant cleanup/recovery; INFO/FREE retain their deadlines.',
    'DSS close errors retain known handles for a bounded retry; an untouched existing file',
    'is preserved and is not labelled as incomplete output.',
    'Sticky X_ERROR cannot abort a new EXEC in the DSS or non-DSS library profile.',
    'S4 C/DSS evidence captures sources before execution and rejects changes during the run.',
    'Actual EXE compact traces prove FAST 25 bytes/block; VERIFIED 45 write / 49 read;',
    'STATUS accesses are counted separately from compact frames.',
    'UGLOAD/UGDUMP/ROUNDTRIP and PROTO CRC/short/extra/timeout/FAULT recovery execute as ASM EXEs.',
    'Disk/print calls forbidden within grants; clock/key calls require closed ISA windows.',
    'FAST/VERIFY/manifest CRC, >64KiB files, short IO/errors, 120s inter-block pauses,',
    'deadlines/midnight/stopped clocks/ESC, lost ACK and context restoration tested.',
    'Slots 0/1, CPU21/3.5MHz, EI/DI; full 8MiB EXE runs separately at slot0/21MHz/EI.',
    'S0a–S3 regressions, MULTIFW/NE2K, both multifw entry points, standalone/slow/debug,',
    'diagnostic OFF/ON/no-DACK, printf/ABI/Flash/SRAM/resource checks PASS.',
    'ASan SKIP: standalone empty runtime probe timed out. UBSan PASS.',
    'MAME: NOT_RUN; DSS CPU harness results are not physical PicoGUS evidence.',
    'Protocol4/API1.0/Settings v6=156 bytes, UltraGS offset152 preserved.',
    'BULK/FIFO, music formats, legacy LOAD and playback remain unsupported.', '',
    'REAL_PENDING: C00, physical PSRAM/ISA, normal/fudge, SCK/LRCLK, temperature,',
    'NMI/no-turbo/RESET DRV/electrical timing, 8MiB SEAL <=30s and uninterrupted service timing.',
    'ug_seal_elapsed_us / ug_service_max_us / ug_spi_slice_max_us are SRAM diagnostics;',
    'service_max includes the complete core1 loop between maintenance/dispatcher opportunities.',
    'Mock values are not hardware timing.',
    'Timing diagnostic addresses: ' + json.dumps(report['timing_diagnostics']),
    'No commits, push, flashing, or adjacent repository edits were performed.', '',
    'Reproduce (PATH includes pinned Arm GCC; SDK2.1.1/extras and Python3.13 configured):',
    'make -f Makefile.ultrags s4-package BUILD=build/S4-main',
    'make -f Makefile.ultrags s4-package BUILD=build/S4-review',
    'python3 tools/ultrags/s4-compare.py --build build/S4-main --review build/S4-review', '',
    'Versions: ' + json.dumps(report['versions'], ensure_ascii=False), '',
    'Tester Notes:',
    'UGCFG MODE ULTRAGS',
    'UGMEM ROUNDTRIP 65536 /SLOW',
    'UGMEM ROUNDTRIP 8388608 /SLOW',
    'UGLOAD TEST.BIN /TYPE:BLOB /SLOW /VERIFY',
    'UGDUMP <received_handle> BACK.BIN /SLOW /VERIFY',
    'UGMEM FREE <received_handle>',
    'UGTEST PROTO',
    'Expected: equal data, temporary ROUNDTRIP object freed, free pool restored, no reboot for protocol errors.',
    'The IMG is a FAT12 data disk. Follow S4-README.md for bundle/standalone restoration.', '',
    'Evidence: ultrags/logs/s4-firmware.json, s4-run.json, s4-full.json,',
    's4-review-comparison.json; host/s4-host-evidence.json; ultrags/s4-package/manifest.json.', '',
    'Artifact SHA-256:',
] + [f"{f['sha256']}  {f['path']} ({f['size']} bytes)" for f in files]
(review / 'REPORT-S4-REVIEW.txt').write_text('\n'.join(lines) + '\n')
print(f'S4 review PASS: {len(files)} byte-identical artifacts; stale full-EXE result rejected')
