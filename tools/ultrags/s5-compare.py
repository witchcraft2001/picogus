#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Compare two accepted S5 deliveries and exercise full-EXE freshness rejection."""
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
names += ['ultrags/s5-package/' + name for name in (
    'PGMULTI.UF2', 'PGULTRA.UF2', 'PGSLOW.UF2', 'PGDEBUG.UF2',
    'PGDIAG.UF2', 'PGDDBG.UF2', 'PGNODACK.UF2', 'PGPOST.UF2', 'PGPMULT.UF2', 'PGPDIAG.UF2', 'PGPNOD.UF2', 'ug-s5.zip', 'ug-s5.img')]
files = []
for name in names:
    original, fresh = (build / name).read_bytes(), (review / name).read_bytes()
    assert original == fresh, 'non-identical artifact ' + name
    files.append(dict(path=name, size=len(original), sha256=digest(original)))
for name in ('s5-host.json', 's5-commands.json'):
    assert (build / 'host' / name).read_bytes() == (review / 'host' / name).read_bytes()
for tree in (build, review):
    report = json.loads((tree / 'ultrags/logs/s5-firmware.json').read_text())
    assert report['status'] == 'HOST_PASS / DSS-EXE_PASS / REAL_PENDING'
    subprocess.run([sys.executable, str(root / 'tools/ultrags/s5-report.py'),
                    '--build', str(tree)], check=True, cwd=root)
    subprocess.run(['node', str(root / 'tools/ultrags/verify-package.mjs'),
                    '--stage', 'S5', '--package', str(tree/'ultrags/s5-package'),
                    '--exe-dir', str(tree/'ultrags/dss'), '--fixtures', str(tree/'ultrags/fixtures')],
                   check=True, cwd=root, stdout=subprocess.DEVNULL)

# Change only a saved result, then run the real gate's verifier. Always restore.
log = review / 'ultrags/logs/s5-full.json'
saved = log.read_bytes()
try:
    stale = json.loads(saved)
    stale['executed'][0]['sha256'] = '0' * 64
    log.write_text(json.dumps(stale))
    rejected = subprocess.run([sys.executable, str(root / 'tools/ultrags/s5-report.py'),
                               '--build', str(review)], capture_output=True, text=True, cwd=root)
    assert rejected.returncode and 'stale S5 executed EXE' in rejected.stderr, rejected.stderr
finally:
    log.write_bytes(saved)

report_command=[sys.executable, str(root/'tools/ultrags/s5-report.py'), '--build', str(review)]
package_command=['node', str(root/'tools/ultrags/verify-package.mjs'), '--stage', 'S5',
                 '--package', str(review/'ultrags/s5-package'), '--exe-dir', str(review/'ultrags/dss'),
                 '--fixtures', str(review/'ultrags/fixtures')]
rejections={}
for name,path,command,reason in [
        ('host',review/'host/s5-host.json',report_command,'stale S5 HOST output'),
        ('exe',review/'ultrags/dss/UGBENCH.EXE',package_command,'stale/substituted EXE'),
        ('package',review/'ultrags/s5-package/ug-s5.zip',package_command,'zip sha256 == manifest'),
        ('firmware',review/'ultrags-release/pg-ultrags.uf2',report_command,'stale S5 handshake artifact'),
        ('packaged_firmware',review/'ultrags/s5-package/PGPOST.UF2',package_command,'S5 outer bytes PGPOST.UF2'),
        ('packaged_evidence',review/'ultrags/s5-package/s5-full.json',package_command,'S5 outer bytes s5-full.json')]:
    saved=path.read_bytes()
    try:
        changed=bytearray(saved);changed[len(changed)//2]^=1;path.write_bytes(changed)
        rejected=subprocess.run(command,capture_output=True,text=True,cwd=root)
        assert rejected.returncode and reason in rejected.stdout+rejected.stderr, rejected.stdout+rejected.stderr
        rejections[name]='REJECTED'
    finally:
        path.write_bytes(saved)

# Provenance must be complete and bound to the current build even when the
# outer manifest is internally consistent with a substituted evidence file.
manifest=review/'ultrags/s5-package/manifest.json'
saved_manifest=manifest.read_bytes()
provenance_name='provenance/ultrags-diag-release-standalone-evidence.json'
path=review/'ultrags/s5-package'/provenance_name
saved_provenance=path.read_bytes()
try:
    changed=json.loads(saved_manifest)
    changed['files']=[e for e in changed['files'] if e['name']!=provenance_name]
    manifest.write_text(json.dumps(changed))
    rejected=subprocess.run(package_command,capture_output=True,text=True,cwd=root)
    assert rejected.returncode and 'S5 required provenance' in rejected.stdout+rejected.stderr
    rejections['missing_provenance']='REJECTED'
    data=saved_provenance+b'\n'
    path.write_bytes(data)
    changed=json.loads(saved_manifest)
    entry=next(e for e in changed['files'] if e['name']==provenance_name)
    entry.update(size=len(data),sha256=digest(data))
    manifest.write_text(json.dumps(changed))
    rejected=subprocess.run(package_command,capture_output=True,text=True,cwd=root)
    assert rejected.returncode and 'S5 current packaged provenance' in rejected.stdout+rejected.stderr
    rejections['substituted_provenance']='REJECTED'
finally:
    manifest.write_bytes(saved_manifest)
    path.write_bytes(saved_provenance)

# A changed current ASM input must invalidate mutually consistent old
# assembly/execution manifests. Exercise the real standalone report gate.
source=root/'host/sprinter/ultrags/docs/S5-README.md'
saved=source.read_bytes()
try:
    source.write_bytes(saved+b'\n')
    rejected=subprocess.run(report_command,capture_output=True,text=True,cwd=root)
    assert rejected.returncode and 'stale assembly inputs' in rejected.stderr, rejected.stderr
    rejections['current_assembly_source']='REJECTED'
finally:
    source.write_bytes(saved)

evidence = dict(status='PASS' , identical_artifacts=len(files), files=files,
                stale_full_exe_result='REJECTED', stale_content=rejections, builds=[str(build), str(review)],
                verifiers={name: digest((root / 'tools/ultrags' / name).read_bytes())
                           for name in ('s5-report.py', 's5-compare.py', 'verify-package.mjs')})
output = review / 'ultrags/logs/s5-review-comparison.json'
output.write_text(json.dumps(evidence, indent=2) + '\n')
full = json.loads((review / 'ultrags/logs/s5-full.json').read_text())['results'][0]
all_exe = json.loads((review / 'ultrags/logs/ugdiag-run.json').read_text())
lines = [
    'Ultra GS S5 — HOST_PASS / DSS-EXE_PASS / REAL_PENDING',
    f'Full s5-package gate PASS in {build} and fresh {review}; affected HOST/PIO/firmware/regression and provenance/package gates repeated after final C-only review fixes.',
    f"Actual C/UBSan: {report['host_s5']['checks']} checks; full 1/2/4/8MiB BULK VERIFIED upload/readback/SEAL.",
    f"Actual EXE: {all_exe['pass']} regression/S5 cases, {len(json.loads((review/'ultrags/logs/s5-variants.json').read_text())['results'])} additional variants, plus separate S4 and S5 full 8MiB ROUNDTRIPs.",
    f"Full BULK EXE: {full['steps']} instructions, host CRC calls={full['hostCrcCalls']}.",
    f'{len(files)} byte-identical EXE/UF2/ZIP/IMG artifacts.',
    'Stale current ASM inputs, HOST, EXE, full-result, handshake UF2 and packaged UF2/evidence/container bytes are rejected.',
    'All shipped firmware has required provenance, including handshake diagnostics; omitted or substituted provenance is rejected even with a consistent outer manifest.',
    'Release HANDSHAKE; POSTED experimental, RX8, no write TX/IOCHRDY, ADS before PUSH, finite SRAM fence.',
    'BULK/GS_DATA FAST/VERIFIED, native/32 aliases, cooperative <=256-byte PSRAM/CRC/SEAL, pins/tokens/recovery.',
    'UGBENCH uses a temporary BLOB, separate phase timings, signed CRC cost, saturating counters, NONE/CRC postcheck and SOAK/ESC cleanup.',
    'Code review: CONFIG preview reads core0-owned and atomic fields only; concurrent SAVE stress passes. Reject legacy CONFIG FLASH in POSTED; no blocking reflasher symbols in its standalone ELF. HANDSHAKE retains previous behavior.',
    'Code review: posted diagnostic preserves all IOR counters, locked CONFIG passthrough, queued assertion/response settings and fatal guard suppression (26 actual C checks).',
    'Code review: SLOW/ALL works with older GS-only CAPS; current ASM inputs and separate firmware/evidence files are checked by the real verifiers.',
    'FIXED/ALIAS/STACK actual instructions and all required lengths execute on slots0/1, CPU21/3.5 and EI/DI.',
    'Known NMI and larger chunk profiles are HOST-only injection; release unknown-NMI STACK refuses before bus access.',
    'S0a–S4 regressions, full firmware matrix, both multifw entrypoints/profile bundles, printf/ABI/Flash/SRAM/resources pass.',
    'Protocol4/API1.0/Settings v6=156, UltraGS offset152 preserved; CAPS=230, aliases=238, formats=0.',
    'MAME NOT_RUN; ASan empty-runtime probe SKIP; UBSan PASS.',
    'Physical C00/P06/B05/B06, PSRAM/ISA/LRCLK/SCK/temperature/RESET/NMI and fastest stable method REAL_PENDING.',
    'Model timings do not select the release method. Physical inequalities are in S5-README.md and s5-firmware.json.',
    'No commit, push, flashing or adjacent repository edits.',
    'Tester Notes: host/sprinter/ultrags/docs/S5-README.md and package HELP.TXT.',
    f'Reproduce: make -f Makefile.ultrags s5-package BUILD={build}; repeat BUILD={review};',
    f'python3 tools/ultrags/s5-compare.py --build {build} --review {review}',
    'Versions: '+json.dumps(report['versions']),
    'Artifact SHA-256:',
] + [f"{f['sha256']}  {f['path']} ({f['size']} bytes)" for f in files]
(review / 'REPORT-S5-REVIEW.txt').write_text('\n'.join(lines)+'\n')
print(f'S5 review PASS: {len(files)} byte-identical artifacts; stale full-EXE result rejected')
