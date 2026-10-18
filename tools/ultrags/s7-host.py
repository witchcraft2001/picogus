#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Executed native MOD4 review evidence, with content-based freshness checks."""
import argparse, json, os, shlex, subprocess, sys
from pathlib import Path
from s6_inputs import ROOT, COMMON, digest

parser = argparse.ArgumentParser()
parser.add_argument('--build', type=Path, required=True)
parser.add_argument('--cc', default='cc')
parser.add_argument('--verify-only', action='store_true')
a = parser.parse_args()
a.build = a.build.resolve()
a.build.mkdir(parents=True, exist_ok=True)
manifest = a.build / 's7-host-evidence.json'
programs = {
    's7-mod': ['tests/ultrags/unit/test_s7_mod.c', 'sw/ultrags/ug_mod.c'],
    's7-storage': ['tests/ultrags/unit/test_s7_storage.c', *COMMON],
}

def inputs():
    files = {ROOT / f for sources in programs.values() for f in sources}
    for folder in ('sw/ultrags', 'sw/system', 'sw/multifw', 'common', 'tests/ultrags/unit/sdk_mock'):
        files.update((ROOT / folder).rglob('*.h'))
    files.update(ROOT / ('tools/ultrags/' + f) for f in (
        's7-host.py', 's6_inputs.py', 'gen-wire.mjs', 'wire-schema.json', 'gen-diag.py', 'diag-schema.json'))
    files.update((a.build / 'gen').glob('*.h'))
    return {str(f.resolve()): digest(f) for f in sorted(files)}

def verify(e):
    assert e['status'] == 'PASS' and e['stage_status'] == 'IN_PROGRESS'
    assert e['inputs'] == inputs(), 'stale S7 host inputs'
    assert set(e['commands']) == set(programs), 'missing S7 executed programs'
    assert set(e['artifacts']) == {'s7-mod', 's7-mod.log', 's7-storage', 's7-storage.log', 's7-commands.jsonl'}
    for f, h in e['artifacts'].items():
        assert digest(a.build / f) == h, 'stale/substituted S7 artifact: ' + f

if a.verify_only:
    verify(json.loads(manifest.read_text()))
    print('S7 native host evidence freshness PASS; full S7 remains IN_PROGRESS')
    sys.exit(0)
manifest.unlink(missing_ok=True)
gen = a.build / 'gen'
gen.mkdir(exist_ok=True)
subprocess.run(['node', str(ROOT / 'tools/ultrags/gen-wire.mjs'), str(ROOT / 'tools/ultrags/wire-schema.json'), str(gen)], check=True)
subprocess.run([sys.executable, str(ROOT / 'tools/ultrags/gen-diag.py'), str(ROOT / 'tools/ultrags/diag-schema.json'), str(gen)], check=True)
before = inputs()
commands = {}
for name, sources in programs.items():
    cmd = shlex.split(a.cc) + ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-pthread',
        '-fsanitize=undefined', '-fno-sanitize-recover=all', '-DUG_S4_TEST=1', '-DPSRAM_ASYNC=1', '-DPSRAM_PIN_CS=1',
        *['-I' + str(ROOT / d) for d in ('tests/ultrags/unit/sdk_mock', 'sw', 'sw/ultrags', 'common')],
        '-I' + str(gen), *[str(ROOT / f) for f in sources], '-o', str(a.build / name)]
    commands[name] = cmd
    subprocess.run(cmd, check=True)
    env = dict(os.environ, UG_S7_VECTORS=str(a.build / 's7-commands.jsonl'))
    r = subprocess.run([str(a.build / name)], env=env, check=True, timeout=120, capture_output=True, text=True)
    log = r.stdout + r.stderr
    (a.build / (name + '.log')).write_text(log)
    print(log, end='', flush=True)
assert before == inputs(), 'S7 inputs changed during execution'
names = [name + suffix for name in programs for suffix in ('', '.log')] + ['s7-commands.jsonl']
evidence = {
    'status': 'PASS', 'stage_status': 'IN_PROGRESS', 'sanitizer': 'UBSan', 'inputs': before,
    'commands': commands, 'artifacts': {f: digest(a.build / f) for f in names},
    'compiler': subprocess.check_output(shlex.split(a.cc) + ['--version'], text=True).splitlines()[0],
    'scope': 'Native MOD4 parser/timing/effect regressions and production storage lifecycle; GS/full effect audio conformance remain open',
}
verify(evidence)
manifest.write_text(json.dumps(evidence, indent=2) + '\n')
