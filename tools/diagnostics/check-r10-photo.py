#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Reproduce the CRC from the owner's R10 photo (manual byte transcription)."""
import argparse
import hashlib
import json
import struct
import zlib
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('build', type=Path)
p.add_argument('photo', type=Path)
a = p.parse_args()
catalog = Path('build/config-r10-delivery/evidence/build-a/generated/multifw/catalog.bin')
uf2 = Path('build/config-r10-delivery/CURRENT.UF2')
config = Path('sw/ultrags/ug_config.c')
data = bytearray(catalog.read_bytes())
assert len(data) == 148
assert zlib.crc32(data[:144]) == struct.unpack_from('<I', data, 144)[0]
# Runtime verified bit for active mode 8, as in ug_config_init and the photo.
data[17 + 7 * 16] |= 2
data[144:] = struct.pack('<I', zlib.crc32(data[:144]))
assert data[144:].hex() == '608a7d34'
assert data[101] == 0xc8
data[101] = 0xff
computed = struct.pack('<I', zlib.crc32(data[:144]))
assert computed.hex() == 'dbc42d1f'
digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
out = a.build / 'host/r10-real-fail.json'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({
    'status': 'REAL_FAIL', 'photo': str(a.photo),
    'firmware': 'pg-ultrags-compat-r10 v4.1.1',
    'storedCRC_LE': '60 8A 7D 34', 'computedCRC_LE': 'DB C4 2D 1F',
    'substitutions': [{'offsetZeroBased': 101, 'expected': 'C8', 'observed': 'FF'}],
    'inputs': {str(path.resolve()): digest(path)
               for path in [a.photo, catalog, uf2, config, Path(__file__)]},
    'limits': ['Manual transcription from photo, not a captured raw bus stream.',
               'Matching CRC supports this substitution; it does not establish the electrical cause.',
               'MODE and subsequent INFO are separate reads; only INFO has a full dump.'],
}, indent=2) + '\n')
print('R10 photo: byte 101 C8->FF reproduces CRC DB C4 2D 1F; REAL_FAIL recorded')
