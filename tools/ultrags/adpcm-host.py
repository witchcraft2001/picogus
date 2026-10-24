#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""WAV IMA ADPCM host gate: ffmpeg fixtures, production C under UBSan.

Generates fixtures with an independent codec (ffmpeg), builds the parser/
mixer test and the command-path test against the production sources, runs
them and records inputs, commands, fixture/executable/log hashes.
"""
import argparse, json, os, shlex, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from s6_inputs import ROOT, COMMON, digest

p = argparse.ArgumentParser()
p.add_argument('--build', type=Path, required=True)
p.add_argument('--cc', default='cc')
p.add_argument('--ffmpeg', default=os.environ.get('UG_FFMPEG', 'ffmpeg'))
a = p.parse_args()
a.build = a.build.resolve(); a.build.mkdir(parents=True, exist_ok=True)
evidence_path = a.build / 'host-evidence.json'
evidence_path.unlink(missing_ok=True)  # a failed run must not leave an old PASS
fixtures = a.build / 'fixtures'
subprocess.run([sys.executable, str(ROOT / 'tools/ultrags/gen-adpcm.py'), '--out', str(fixtures),
                '--ffmpeg', a.ffmpeg], check=True)
gen = a.build / 'gen'
subprocess.run(['node', str(ROOT / 'tools/ultrags/gen-wire.mjs'), str(ROOT / 'tools/ultrags/wire-schema.json'), str(gen)], check=True)
subprocess.run([sys.executable, str(ROOT / 'tools/ultrags/gen-diag.py'), str(ROOT / 'tools/ultrags/diag-schema.json'), str(gen)], check=True)
programs = {'ima-render': ['tests/ultrags/unit/test_ima_render.c', 'sw/ultrags/ug_pcm.c', 'sw/ultrags/ug_render.c'],
            'ima-storage': ['tests/ultrags/unit/test_ima_storage.c', *COMMON]}
inputs = {ROOT / f for src in programs.values() for f in src}
for folder in ('sw/ultrags', 'tests/ultrags/unit/sdk_mock', 'common', 'sw/system', 'sw/multifw'):
    inputs.update((ROOT / folder).rglob('*.h'))
inputs.update((ROOT / 'sw/ultrags').glob('*.inc')); inputs.update(gen.glob('*'))
inputs.update(ROOT / ('tools/ultrags/' + f) for f in ('adpcm-host.py', 'gen-adpcm.py', 's6_inputs.py',
                                                     'wire-schema.json', 'gen-wire.mjs', 'gen-diag.py'))
before = {str(f): digest(f) for f in sorted(inputs)}
commands, artifacts = {}, {}
for name, src in programs.items():
    cmd = shlex.split(a.cc) + ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-pthread',
           '-fsanitize=undefined', '-fno-sanitize-recover=all', '-DUG_S4_TEST=1', '-DPSRAM_ASYNC=1', '-DPSRAM_PIN_CS=1',
           *['-I' + str(ROOT / d) for d in ('tests/ultrags/unit/sdk_mock', 'sw', 'sw/ultrags', 'common')],
           '-I' + str(gen), *[str(ROOT / f) for f in src], '-o', str(a.build / name)]
    subprocess.run(cmd, check=True); commands[name] = cmd
    r = subprocess.run([str(a.build / name), str(fixtures)], check=True, capture_output=True, text=True, timeout=120)
    (a.build / (name + '.log')).write_text(r.stdout + r.stderr); print(r.stdout, end='')
    for suffix in ('', '.log'): artifacts[name + suffix] = digest(a.build / (name + suffix))
assert before == {str(f): digest(f) for f in sorted(inputs)}, 'inputs changed during the run; rerun'
ffmpeg_version = subprocess.check_output([a.ffmpeg, '-version'], text=True).splitlines()[0]
evidence = dict(status='HOST_PASS / REAL_PENDING', inputs=before, commands=commands, artifacts=artifacts,
                fixtures={f.name: digest(f) for f in sorted(fixtures.iterdir())},
                reference=ffmpeg_version, sanitizer='UBSan',
                scope='WAV IMA ADPCM 0x11: parser, mixer lane and command path vs ffmpeg decode; REAL pending')
evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
print('ADPCM host evidence:', evidence_path)
