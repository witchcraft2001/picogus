# SPDX-License-Identifier: GPL-2.0-or-later
"""Required inputs/evidence for the implemented S6 host subset."""
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMMON = ['tests/ultrags/unit/sdk_mock/sdk_mock.c', 'sw/multifw/ug_catalog.c',
          *['sw/ultrags/'+name+'.c' for name in ('ug_config', 'ug_minimal', 'ug_storage',
            'ug_store', 'ug_memory', 'ug_psram', 'ug_hwmap', 'ug_pcm', 'ug_render', 'ug_mod')]]
PROGRAMS = {'s6-storage': ['tests/ultrags/unit/test_s6.c', *COMMON],
            's6-pcm': ['tests/ultrags/unit/test_s6_pcm.c', 'sw/ultrags/ug_pcm.c'],
            's6-render': ['tests/ultrags/unit/test_s6_render.c', 'sw/ultrags/ug_render.c'],
            's6-math': ['tests/ultrags/unit/test_render_math.c'],
            's6-device': ['tests/ultrags/unit/test_device.c', 'tests/ultrags/unit/sdk_mock/sdk_mock.c',
                          *['sw/ultrags/'+name+'.c' for name in ('ug_audio', 'ug_psram', 'ug_hwmap', 'ug_diag_link')]]}

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def inputs(build):
    files = {ROOT / source for sources in PROGRAMS.values() for source in sources}
    for directory in ('sw/ultrags', 'tests/ultrags/unit/sdk_mock', 'common', 'sw/multifw', 'sw/system'):
        files.update((ROOT / directory).rglob('*.h'))
    files.update(ROOT / ('tools/ultrags/'+name) for name in
                 ('s6_inputs.py', 's6-host.py', 'gen-wire.mjs', 'wire-schema.json', 'gen-diag.py', 'diag-schema.json'))
    files.update((Path(build).resolve() / 'gen').glob('*.h'))
    return {str(path.resolve()): digest(path) for path in sorted(files)}

def validate(evidence, build):
    assert evidence.get('status') == 'PASS' and evidence.get('sanitizer') == 'UBSan', 'missing passing S6 host run'
    assert evidence.get('inputs') == inputs(build), 'stale or incomplete S6 host input evidence'
    assert set(evidence.get('executables', {})) == set(PROGRAMS), 'incomplete S6 executable evidence'
    assert set(evidence.get('logs', {})) == set(PROGRAMS), 'incomplete S6 executed-test logs'
    assert set(evidence.get('commands', {})) == set(PROGRAMS), 'incomplete S6 compiler commands'
    assert set(evidence.get('fixtures',{}))=={'s6-commands.jsonl','s6-audio.s16le','s6-audio-index.jsonl'}, 'missing S6 fixtures'
    for name,value in evidence['fixtures'].items():
        assert value==digest(Path(build)/name), 'stale S6 fixture '+name
    for name in PROGRAMS:
        assert evidence['executables'][name] == digest(Path(build)/name), 'stale S6 executable '+name
        assert evidence['logs'][name] == digest(Path(build)/(name+'.log')), 'stale S6 test log '+name
