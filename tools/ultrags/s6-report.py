#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Verify complete software evidence; S6 stays IN_PROGRESS until physical gates."""
import argparse, json, shlex, subprocess
from pathlib import Path
from budget_report import sections, sram_budget
from firmware_evidence import verify_uf2, configuration
from s6_inputs import ROOT, digest, validate

p=argparse.ArgumentParser(); p.add_argument('--build',type=Path,required=True); a=p.parse_args()
b=a.build.resolve(); host=b/'host/s6'; fw=b/'ultrags-release/pg-ultrags'
ev=json.loads((host/'s6-host-evidence.json').read_text()); validate(ev,host)
# The full S0-S5 gate validates the current complete EXE set, both full 8 MiB
# executions, host/PIO/firmware matrix, ABI, resources and dependency provenance.
subprocess.run(['python3',str(ROOT/'tools/ultrags/s5-report.py'),'--build',str(b)],check=True)
assembly=json.loads((b/'ultrags/dss/asm-manifest.json').read_text())
expected=json.loads(subprocess.check_output(['node','--input-type=module','-e',
    'import {executionInputs} from "./tools/ultrags/build-evidence.mjs"; process.stdout.write(JSON.stringify(executionInputs(process.argv[1])));',str(ROOT)],cwd=ROOT,text=True))
run=json.loads((b/'ultrags/logs/s6-run.json').read_text())
assert run['inputs']==expected and run['buildInputs']==assembly['inputs'], 'stale S6 DSS inputs'
assert len(run['results'])>=200 and all(x['ok'] for x in run['results']), 'missing/failed S6 DSS cases'
assert {'UGPLAY.EXE','UGMON.EXE','UGLOAD.EXE','UGTEST.EXE'} <= {x['name'] for x in run['executed']}, 'missing S6 executed programs'
for item in run['executed']:
    assert digest(b/'ultrags/dss'/item['name'])==item['sha256'], 'stale S6 executed EXE'
assert run['sharedCount']>=50 and run['sharedSha256']==digest(host/'s6-commands.jsonl'), 'stale S6 shared C/model vectors'
assert run['modelStarts']>65535, 'missing cyclic FX model stress'
assert run['queuedStopWrap'] is True, 'missing live-token reservation across queued STOP'
assert all(x['maxWindowUs']<10000 and x['maxDiUs']<10000 for x in run['results']), 'ISA/DI budget'
names={x['name'] for x in run['results']}
assert {'UGTEST PCM','UGTEST FX','lost ACK 16','lost ACK 33','lost ACK 48','lost ACK 54',
        'lost short FX unknown','WAIT specific replaced instance','background verified upload',
        'playing PCM verified readback','stereo higher priority steal','WAIT session changed',
        'lost SEAL ACK keeps READY','lost WAV SEAL ACK keeps READY',
        'lost SEAL session change preserves new asset','FX audio fault WAIT',
        'FX WAIT ignores old sticky error','FX WAIT detects repeated sticky fault',
        'UGTEST lost PLAY cleanup PCM','UGTEST lost PLAY cleanup FX',
        'UGTEST lost FX keeps foreign foreground',
        'UGTEST FX capability before allocation',
        'session change before allocation UGLOAD','session change before allocation UGPLAY',
        'session change cannot overwrite foreign LOADING',
        'ignored option rejected STOP /GAIN:1'} <= names, 'incomplete S6 matrix'
index=[json.loads(line) for line in (host/'s6-audio-index.jsonl').read_text().splitlines()]
assert len(index)==1891 and {x.get('rate') for x in index if 'rate' in x}=={8000,11025,16000,22050,24000,32000,44100,48000,12345}, 'audio matrix'
end=0
for item in index:
    assert item['offset_bytes']==end and item['output_frames']>0, 'golden frame accounting'
    end+=item['output_frames']*4
assert (host/'s6-audio.s16le').stat().st_size==end, 'golden sample count'

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
report=f"""Ultra GS S6 software gate

Status: HOST_PASS / DSS-EXE_PASS / REAL_PENDING
Stage: IN_PROGRESS (physical acceptance outstanding)

Actual C/UBSan storage/parser/render/DMA checks PASS. Independent scalar oracle:
1890 rate/format/channel/pan/repeat/loop cases plus 12-lane clipping golden,
{end//4} output stereo frames at fixed 48000 Hz; indexed S16LE samples exported.
Long source phase crosses 1/2/4 MiB and the exact 8 MiB EOF. PCM controls, atomic
four mono/two stereo FX, paused ownership, queue16, >65535 starts, pins/reset/fault,
concurrent verified upload/readback and DMA recovery are covered.

Actual assembled EXE: {len(run['results'])} S6 scenarios; {run['sharedCount']} shared
production-C/independent-model vectors; {run['modelStarts']} independent model FX
starts. RAW/WAV upload -> READY handle -> repeated PLAY -> explicit FREE;
foreground/FX controls, replacement validation, targeted WAIT/ESC, card-frame-paced
monitor, stopped counters, file/format/CRC errors, lost ALLOC/END/PLAY ACK,
reconciliation and session changes PASS. Slots0/1, EI/DI, software Turbo on/off,
hardware inhibit, PAGE3 and separate ISA/DI budgets PASS.

Current complete S0-S5 software regression evidence verified, including both
full 8 MiB actual-EXE ROUNDTRIPs, full firmware matrix and provenance. Current
standalone HANDSHAKE UF2/ELF/BIN and >=16 KiB SRAM reserve verified.
No new protocol commands or Settings layout. MOD, legacy GS loading and playlists
remain later stages. Physical LRCLK, continuous I2S, render<=75% quantum, bus
budgets, temperature and listening are REAL_PENDING; S6 is not ACCEPTED.
Dual-build byte identity is recorded separately by s6-compare.py.
"""
(b/'REPORT-S6.txt').write_text(report)
(b/'s6-firmware-memory.json').write_text(json.dumps(memory,indent=2)+'\n')
print(report,end='')
