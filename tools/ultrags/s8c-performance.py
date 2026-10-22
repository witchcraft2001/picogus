#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Compare original/current actual EXEs with the same CPU, disk and card model.

The fixed baseline is rebuilt from git, never taken from an earlier delivery.
All output stays under the two stable build roots. No physical speed claim.
"""
import argparse, io, json, os, re, shutil, subprocess, tarfile
from pathlib import Path
from s6_inputs import ROOT, digest

p = argparse.ArgumentParser()
p.add_argument('--build', type=Path, required=True)
a = p.parse_args()
b = a.build.resolve()
out = b/'host/s8c-performance'
out.mkdir(parents=True, exist_ok=True)
revision = subprocess.check_output(['git', 'rev-parse', '94447e0^{commit}'], cwd=ROOT, text=True).strip()
old = out/'baseline'
old.mkdir(exist_ok=True)
archive = subprocess.check_output(['git', 'archive', revision, 'host/sprinter/ultrags', 'tools/ultrags', 'tests/ultrags/dss'], cwd=ROOT)
with tarfile.open(fileobj=io.BytesIO(archive)) as t:
    t.extractall(old, filter='data')
oldbuild = old/'build'
gen = oldbuild/'ultrags/gen'
gen.mkdir(parents=True, exist_ok=True)

def run(cmd, log, env=None):
    with (out/log).open('w') as f:
        subprocess.run([str(x) for x in cmd], cwd=ROOT, env=env, stdout=f, stderr=subprocess.STDOUT, check=True)

run(['node', old/'tools/ultrags/gen-wire.mjs', old/'tools/ultrags/wire-schema.json', gen], 'baseline-wire.log')
run(['python3', old/'tools/ultrags/gen-diag.py', old/'tools/ultrags/diag-schema.json', gen], 'baseline-diag.log')
run(['node', old/'tests/ultrags/dss/assemble.mjs', old, oldbuild/'ultrags/dss'], 'baseline-asm.log')
run(['python3', old/'tools/ultrags/s8c-fast.py', '--build', oldbuild], 'baseline-fast.log')
for name in ['native/native-card.node', 'native/native-card-build.json', 'host/s2-catalog.bin']:
    (oldbuild/name).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(b/name, oldbuild/name)

runner = ROOT/'tests/ultrags/dss/run-stream.mjs'
rows = []
pipes = {}
inputs = {str(x): digest(x) for x in [Path(__file__).resolve(), runner, b/'native/native-card.node', b/'native/native-card-build.json']}
for name, exe in [('standard', 'UGPLAY.EXE'), ('fast', 'UGPF.EXE')]:
    reports = []
    for phase, root, build in [('before', old, oldbuild), ('after', ROOT, b)]:
        env = {**os.environ, 'UG_STREAM_PERF': '1', 'UG_STREAM_EXE': exe, 'UG_STREAM_BASELINE': '1' if phase == 'before' else '0'}
        run(['node', runner, root, build], f'{phase}-{name}.log', env)
        src = build/f'evidence/performance-{name}.json'
        target = out/f'{phase}-{name}.json'
        shutil.copyfile(src, target)
        report = json.loads(target.read_text())
        assert report['exeSha256'] == digest(build/'ultrags/dss'/exe)
        assert report['runnerSha256'] == digest(runner)
        inputs[str(target)] = digest(target)
        inputs[str(build/'ultrags/dss'/exe)] = report['exeSha256']
        reports.append(report)
    for before, after in zip(reports[0]['results'], reports[1]['results']):
        assert (before['cli'], before['payloadBytes'], before['readDelayUs'], before['serviceDelayUs']) == (after['cli'], after['payloadBytes'], after['readDelayUs'], after['serviceDelayUs'])
        for counter in ['payloadReads', 'clockCalls', 'dssCalls', 'windowCount', 'elapsedTicks']:
            assert after[counter] < before[counter], (name, counter, before[counter], after[counter])
        if after['payloadBytes'] == 131072:
            assert after['steps'] < before['steps']
            assert after['z80Tstates'] < before['z80Tstates']
            assert after['z80Ticks21MHz'] < before['z80Ticks21MHz']
        if name == 'fast' and after['payloadBytes'] == 131072:
            assert after['modeledBytesPerSecond'] >= 220500
        if name == 'fast':
            assert 'stream EOF underruns=0 ' in after['text']
        rows.append(dict(profile=name, before=before, after=after))
    pipe = reports[1]['results'][-1]
    assert '/BENCH:PIPE' in pipe['cli'] and pipe['payloadBytes'] == 131072
    assert pipe['payloadReads'] == 22 and pipe['feedPackets'] == 128
    match = re.search(r'BENCH PIPE bytes=131072 delta_frames=(\d+) READ_calls=22 packet_count=128 Bps=(\d+)\b', pipe['text'])
    assert match, 'PIPE must have a known, sufficient card-clock interval'
    frames, bps = map(int, match.groups())
    assert frames >= 6000 and bps == 131072*48000//frames
    assert (bps >= 220500) == (name == 'fast')
    pipes[name] = dict(bytes=131072, delta_frames=frames, Bps=bps, exeSha256=reports[1]['exeSha256'])

(out/'comparison.json').write_text(json.dumps(dict(
    status='HOST_PERFORMANCE_PASS / REAL_PENDING', baseline=revision,
    scope='Actual Z80 instructions with modeled disk/service delays; not measured hardware throughput',
    consumption=176400, requiredMinimum=220500, target=352800,
    inputs=inputs, pipe=pipes, results=rows), indent=2)+'\n')
print('S8c actual-EXE before/after counters PASS; physical throughput REAL_PENDING')
