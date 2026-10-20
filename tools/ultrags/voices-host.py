#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Additional executed gates for the initial API 1.0 VLS1 delivery.

Run after test-dss. Existing actual-EXE evidence is validated, never re-labelled.
Private PROPLAY/MOD inputs are required but are not redistributed.
"""
import argparse, json, os, subprocess, sys
from pathlib import Path
from s6_inputs import ROOT, digest, validate

p = argparse.ArgumentParser()
p.add_argument('--build', type=Path, required=True)
p.add_argument('--verify-only', action='store_true')
a = p.parse_args()
b = a.build.resolve()
report = b / 'voices-host.json'

def inputs():
    files = set()
    for folder in ('sw/ultrags', 'host/sprinter/ultrags', 'tests/ultrags', 'tools/ultrags'):
        files.update(f for f in (ROOT / folder).rglob('*') if f.is_file() and
                     f.suffix in ('.c', '.cpp', '.h', '.inc', '.asm', '.pio', '.py', '.mjs', '.js', '.json'))
    return {str(f): digest(f) for f in sorted(files)}

def run(args):
    subprocess.run([str(x) for x in args], cwd=ROOT, check=True)

def dss_proof():
    run(['node', '--input-type=module', '-e',
         "import {verifyExecution} from './tools/ultrags/build-evidence.mjs';"
         "verifyExecution(process.cwd(),process.argv[1]);", b / 'ultrags/dss'])
    validate(json.loads((b / 'host/s6/s6-host-evidence.json').read_text()), b / 'host/s6')

def verify(e):
    assert e['status'] == 'HOST_ACTUAL_EXE_PASS / REAL_PENDING'
    assert e['inputs'] == inputs(), 'stale VLS1 host inputs; rerun voices-host'
    for path, sha in e['artifacts'].items():
        assert digest(path) == sha, 'stale/substituted host artifact: ' + path
    dss_proof()
    run([sys.executable, ROOT / 'tools/ultrags/s7-host.py', '--build', b / 'host/s7', '--verify-only'])
    native = json.loads((b / 'host/native/actual-exe.json').read_text())
    assert native['privateProplay'] and len(native['results']) >= 198
    manifest = json.loads((b / 'native/native-card-build.json').read_text())
    for path, sha in manifest['inputs'].items():
        assert digest(path) == sha, 'stale native C input: ' + path
    assert digest(b / 'native/native-card.node') == manifest['artifact']

if a.verify_only:
    verify(json.loads(report.read_text()))
    print('VLS1 host evidence freshness PASS / REAL_PENDING')
    sys.exit(0)

report.unlink(missing_ok=True)
assert os.environ.get('UG_PROPLAY') and os.environ.get('UG_PROPLAY_MOD'), 'Set UG_PROPLAY and UG_PROPLAY_MOD for unchanged private guest conformance'
dss_proof()
before = inputs()
private = {key: {'sha256': digest(os.environ[key]), 'size': Path(os.environ[key]).stat().st_size}
           for key in ('UG_PROPLAY', 'UG_PROPLAY_MOD')}
commands = [
    [sys.executable, ROOT / 'tools/ultrags/build-native-card.py', '--build', b / 'native'],
    [sys.executable, ROOT / 'tools/ultrags/s7-host.py', '--build', b / 'host/s7'],
    ['node', ROOT / 'tests/ultrags/dss/run-native.mjs', ROOT, b],
    ['node', ROOT / 'tests/ultrags/dss/run-s7.mjs', ROOT, b],
    ['node', ROOT / 'tests/ultrags/dss/config-regression.mjs', ROOT, b],
    ['node', ROOT / 'tests/ultrags/dss/turbo-contract.mjs', ROOT, b],
    ['node', ROOT / 'tests/ultrags/dss/review-vls1.mjs', ROOT, b],
    ['node', ROOT / 'tests/ultrags/protocol/run-protocol-tests.mjs', ROOT, b / 'protocol', '--wire-only'],
    [sys.executable, ROOT / 'tests/ultrags/unit/test_crc_combine.py'],
    ['node', ROOT / 'tests/ultrags/dss/ug-card-test.mjs'],
]
for cmd in commands:
    print('RUN', ' '.join(map(str, cmd)), flush=True)
    run(cmd)
assert before == inputs(), 'host sources changed during execution'
assert private == {key: {'sha256': digest(os.environ[key]), 'size': Path(os.environ[key]).stat().st_size}
                   for key in private}, 'private guest inputs changed during execution'
paths = [b / path for path in (
    'ultrags/dss/asm-manifest.json', 'ultrags/logs/ugdiag-run.json',
    'ultrags/logs/s2-run.json', 'ultrags/logs/s3-run.json', 'ultrags/logs/s4-run.json',
    'ultrags/logs/s5-run.json', 'ultrags/logs/s6-run.json', 'ultrags/logs/config-regression.json',
    'ultrags/logs/turbo-contract.json', 'ultrags/throughput/throughput.json',
    'host/s6/s6-host-evidence.json', 'host/s7/s7-host-evidence.json',
    's7-dss-evidence.json', 'native/native-card-build.json', 'native/native-card.node',
    'host/native/actual-exe.json', 'host/review/held-pages.json', 'protocol/logs/protocol-tests.json')]
e = {'status': 'HOST_ACTUAL_EXE_PASS / REAL_PENDING', 'stage_status': 'IN_PROGRESS',
     'inputs': before, 'commands': [[str(x) for x in c] for c in commands],
     'artifacts': {str(f): digest(f) for f in paths},
     'private_inputs': private,
     'limits': ['Functional SDK/DSS models do not prove ISA electrical timing or audio wall-clock deadlines',
                'Unchanged PROPLAY retains its DSS memory block at EXIT; process teardown is not modelled',
                'S7 full GS/effect/audio conformance and physical acceptance remain pending']}
verify(e)
report.write_text(json.dumps(e, indent=2) + '\n')
print('VLS1 executed host gates PASS / REAL_PENDING; S7 IN_PROGRESS')
