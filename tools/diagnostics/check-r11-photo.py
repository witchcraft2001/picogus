#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Check manually transcribed R11 photo differences against the issued catalog."""
import argparse
import hashlib
import json
import struct
import zlib
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('build', type=Path)
p.add_argument('gus_photo', type=Path)
p.add_argument('ultrags_photo', type=Path)
a = p.parse_args()
catalog = Path('build/config-probe11-delivery/evidence/build-a/generated/multifw/catalog.bin')
uf2 = Path('build/config-probe11-delivery/CURRENT.UF2')
original = catalog.read_bytes()
assert len(original) == 148
assert zlib.crc32(original[:144]) == struct.unpack_from('<I', original, 144)[0]

def runtime(mode):
    data = bytearray(original)
    data[17 + 16 * (mode - 1)] |= 2
    data[144:] = struct.pack('<I', zlib.crc32(data[:144]))
    return data

gus, expected = runtime(1), runtime(8)
assert gus[144:].hex() == 'cad7395a'
assert expected[144:].hex() == 'c0cc1fd0'
# Wrapped nibbles/zero run around byte118 are resolved consistently with
# the pictured checksum. This is a photo transcription, not a binary capture.
substitutions = {0: 0xff, 14: 7, 16: 0xff, 17: 7, 24: 0x1f, 27: 1, 43: 1, 118: 0xff}
observed = expected.copy()
for i, value in substitutions.items():
    assert expected[i] != value and expected[i] & value == expected[i]
    observed[i] = value
computed = struct.pack('<I', zlib.crc32(observed[:144]))
assert computed.hex() == '5e7c175e'
out = a.build / 'host'
out.mkdir(parents=True, exist_ok=True)
(out / 'r11-observed-catalog.bin').write_bytes(observed)
digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
(out / 'r11-real-2101.json').write_text(json.dumps({
    'status': 'REAL_FAIL', 'firmware': 'pg-ultrags-cfgprobe-r11 v4.1.1',
    'platform': 'Sprinter DX, stock firmware, unmodified (owner confirmed)',
    'gusCRC_LE': 'CA D7 39 5A', 'ultragsStoredCRC_LE': 'C0 CC 1F D0',
    'ultragsComputedCRC_LE': '5E 7C 17 5E',
    'changes': [{'offsetZeroBased': i, 'expected': f'{expected[i]:02X}',
                 'observed': f'{v:02X}'} for i, v in substitutions.items()],
    'allChangesSetBitsOnly': True, 'byteCount': 148,
    'inputs': {str(path.resolve()): digest(path) for path in
               [catalog, uf2, a.gus_photo, a.ultrags_photo, Path(__file__),
                out / 'r11-observed-catalog.bin']},
    'limits': ['Manual photo transcription; wrapped zero-run position corroborated by CRC.',
               'The same-offset substitutions reproduce the CRC without a stream shift.',
               'Setting zero bits to one is consistent with delayed/unstable drive but does not prove the electrical cause.',
               'MODE CRC and subsequent INFO dump describe separate reads.',
               'The prior LATE=0 probe at20:38 is not a measurement of this21:01 read.']
}, indent=2) + '\n')
print('R11 photos: GUS CRC matches; eight same-offset bit-setting substitutions reproduce 5E 7C 17 5E')
