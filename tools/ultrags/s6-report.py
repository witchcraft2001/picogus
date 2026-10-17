#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Verify executed subset and linked firmware; never imply full S6 acceptance."""
import argparse, json, shlex
from pathlib import Path
from budget_report import sections, sram_budget
from firmware_evidence import verify_uf2, configuration
from s6_inputs import ROOT, digest, validate

p=argparse.ArgumentParser(); p.add_argument('--build',type=Path,required=True); a=p.parse_args()
b=a.build.resolve(); host=b/'host/s6'; fw=b/'ultrags-release/pg-ultrags'
ev=json.loads((host/'s6-host-evidence.json').read_text()); validate(ev,host)
evidence=json.loads(fw.with_suffix('.evidence.json').read_text())
assert evidence.get('target')=='pg-ultrags', 'wrong S6 firmware target'
assert set(evidence.get('artifacts',{}))=={'elf','bin','uf2'}, 'incomplete firmware artifacts'
# Reconstruct the required compiler dependency set, including external SDK inputs.
# This matches s2-evidence.py and prevents omitted headers/empty maps passing.
fb=fw.parent
required={ROOT/'sw/CMakeLists.txt', ROOT/'tools/ultrags/s2-evidence.py', fb/'CMakeCache.txt'}
deps=list(fb.rglob('*.o.d')); assert deps, 'missing firmware dependencies'
for dep in deps:
    if any('uf2create' in part.lower() for part in dep.parts): continue
    if any(x.endswith('.dir') and (x.startswith('pg-') or x=='bootloader.dir') and x!='pg-ultrags.dir' for x in dep.parts): continue
    for name in shlex.split(dep.read_text().replace(chr(92)+chr(10),' ').split(':',1)[1]):
        path=Path(name); required.add(path.resolve() if path.is_absolute() else (fb/path).resolve())
required.update(path.resolve() for path in fb.rglob('flags.make') if path.parent.name=='pg-ultrags.dir')
assert evidence.get('inputs')=={str(path):digest(path) for path in sorted(required)}, 'stale/incomplete firmware inputs'
for ext,h in evidence['artifacts'].items():
    assert digest(fw.with_suffix('.'+ext))==h, 'stale S6 firmware artifact '+ext
cfg=configuration(fb)
assert cfg['PROJECT_TYPE']=='ULTRAGS' and cfg['PGDEBUG']=='OFF' and cfg['UG_ISA_WRITE_PROFILE']=='HANDSHAKE' and cfg['UG_DIAG_NO_DACK'] in ('','OFF'), 'wrong release configuration'
verify_uf2(fw.with_suffix('.uf2').read_bytes(),fw.with_suffix('.bin').read_bytes())
memory=sram_budget(sections('arm-none-eabi',fw.with_suffix('.elf')))
assert memory['free_main']>=16384, 'S6 SRAM reserve below 16 KiB'
report="""Ultra GS S6 implementation increment

Status: HOST_PARTIAL / DSS-EXE_PENDING / REAL_PENDING

Executed subset (UBSan): RAW descriptors; cooperative WAV parser and SEAL; PCM controls/repeats/mix; boundary event queue (16 events); foreground and four mono/two stereo dedicated FX; paused ownership/atomic steal; ID wrap beyond 65535 starts; reset/fault pin cleanup. Independent scalar oracle checks 1890 frequency/format/channel/pan/repeat/loop cases, exact samples/duration, sources beyond 4 MiB, clipping, 20 ms peaks and saturated counters. DMA mocks check ownership, both pending completion IRQs, zero fallback and starvation/maintenance recovery. Current standalone HANDSHAKE ELF/BIN/UF2 inputs and payloads verified; SRAM reserve >=16 KiB.

Full S6 is not accepted. DSS UGLOAD RAW/WAV, UGPLAY, UGMON, UGTEST PCM/FX and actual-EXE/lost-ACK/context matrix are outstanding. The independent DSS model/audio goldens, full concurrent transport/audio matrix, dual fresh full gates with byte-identical EXE/UF2/ZIP/IMG and complete packages are outstanding. This report does not attest that s6-check or earlier full regression gates ran; consult their own executed evidence. Physical LRCLK, bus/render timing, underruns and listening remain REAL_PENDING.
"""
(b/'REPORT-S6.txt').write_text(report)
(b/'s6-firmware-memory.json').write_text(json.dumps(memory,indent=2)+'\n')
print(report,end='')
