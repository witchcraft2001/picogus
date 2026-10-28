#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Owned Soundtracker fixtures and libxmp oracle; private originals are optional."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from s6_inputs import ROOT, COMMON
p = argparse.ArgumentParser()
p.add_argument('--build', type=Path, required=True)
p.add_argument('--awesome', type=Path)
p.add_argument('--axelf', type=Path)
a = p.parse_args()
b = a.build.resolve()
b.mkdir(parents=True, exist_ok=True)
gen = b / 'gen'
subprocess.run(['node', str(ROOT/'tools/ultrags/gen-wire.mjs'), str(ROOT/'tools/ultrags/wire-schema.json'), str(gen)], check=True)
subprocess.run(['python3', str(ROOT/'tools/ultrags/gen-diag.py'), str(ROOT/'tools/ultrags/diag-schema.json'), str(gen)], check=True)
incs = ['-I'+str(ROOT/d) for d in ('tests/ultrags/unit/sdk_mock', 'sw', 'sw/ultrags', 'common')] + ['-I'+str(gen)]
storage = ['cc', '-std=c11', '-O1', '-g', '-pthread', '-fsanitize=undefined', '-fno-sanitize-recover=all', '-DUG_S4_TEST=1', '-DPSRAM_ASYNC=1', '-DPSRAM_PIN_CS=1', *incs, str(ROOT/'tests/ultrags/unit/test_mod15_storage.c'), *[str(ROOT/x) for x in COMMON], '-o', str(b/'storage')]
oracle = ['cc', '-std=c11', *incs, '-I/opt/homebrew/include', str(ROOT/'tests/ultrags/unit/mod15_xmp_compare.c'), str(ROOT/'sw/ultrags/ug_mod.c'), '-L/opt/homebrew/lib', '-lxmp', '-o', str(b/'compare')]
# Owned fixtures exercise both dialects, all fifteen instruments and byte skips.
fixtures = []
for dialect in ('ust', 'ix'):
    data = bytearray(600 + 1024 + 15*8)
    data[:8] = b'MOD15 QA'
    data[470:472] = bytes((1, 120))
    for sample in range(15):
        off = 20 + sample*30
        data[off+22:off+30] = bytes((0, 4, 0, sample*4, 0, 2, 0, 3))
        data[1624+sample*8:1624+(sample+1)*8] = bytes((99, 98)) + bytes((sample+1,))*6
    def event(row, channel, period, sample, effect=0, param=0):
        off = 600+row*16+channel*4
        data[off:off+4] = bytes((period>>8, period&255, sample*16|effect, param))
    for sample in range(1,16):
        event(sample-1, (sample-1)%4, 428, sample)
    event(16, 0, 428, 1, 1 if dialect=='ust' else 0, 0x37)
    event(24, 0, 113, 1, 2 if dialect=='ust' else 1, 15)
    event(32, 0, 856, 1, 2, 0xf0 if dialect=='ust' else 15)
    event(40, 0, 300, 1)  # Historical alternate period decodes to a note.
    if dialect == 'ix':
        event(44, 0, 0, 0, 12, 0)
        event(45, 0, 0, 0, 12, 80)
        event(46, 0, 0, 0, 15, 0)  # F00 must not pause.
        event(48, 0, 428, 1, 15, 32)  # F20 is speed, not BPM.
    path = b/(dialect+'.MOD')
    path.write_bytes(data)
    fixtures.append((path, 384 if dialect=='ust' else 800))
    if dialect == 'ix':
        for fine in (7, 8):
            data[44] = fine
            path = b/('ix-fine'+str(fine)+'.MOD')
            path.write_bytes(data)
            fixtures.append((path, 800))
commands = [storage, oracle]
if bool(a.awesome) != bool(a.axelf):
    p.error('--awesome and --axelf must be supplied together')
inputs = list(fixtures)
if a.awesome:
    inputs += [(a.awesome.resolve(), 7296), (a.axelf.resolve(), 31872)]
# The storage helper accepts any two source files; synthetic fixtures always run.
commands.append([str(b/'storage'), str(fixtures[0][0]), str(fixtures[1][0])])
if a.awesome:
    commands.append([str(b/'storage'), str(a.awesome), str(a.axelf)])
commands += [[str(b/'compare'), str(path), str(ticks)] for path, ticks in inputs]
logs = []
for cmd in commands:
    result = subprocess.run(cmd, capture_output=True, text=True)
    logs.append({'command': cmd, 'returncode': result.returncode, 'output': result.stdout+result.stderr})
    (b/'review-evidence.json').write_text(json.dumps({'checks': logs}, indent=2)+'\n')
    print(result.stdout+result.stderr, end='')
    result.check_returncode()
(b/'review-evidence.json').write_text(json.dumps({
    'status': 'PARTIAL_HOST_PASS / REAL_PENDING', 'checks': logs,
    'inputs': {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path, _ in inputs},
    'sources': {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in [Path(__file__), ROOT/'sw/ultrags/ug_mod.c', ROOT/'tests/ultrags/unit/mod15_xmp_compare.c']},
    'limits': ['No linked ARM audio or DSS EXE validation', 'No full audio comparison against libxmp']
}, indent=2)+'\n')
