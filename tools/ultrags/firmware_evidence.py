#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Content provenance captured when a standalone ELF is linked, not at packaging."""
import argparse
import hashlib
import json
import shlex
import struct
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def configuration(build):
    values = {}
    for line in (Path(build) / 'CMakeCache.txt').read_text().splitlines():
        if ':' in line and '=' in line and not line.startswith(('#', '//')):
            key, value = line.split('=', 1)
            values[key.split(':', 1)[0]] = value
    return {key: values.get(key, 'HANDSHAKE' if key=='UG_ISA_WRITE_PROFILE' else '') for key in ('PROJECT_TYPE', 'PGDEBUG', 'UG_DIAG_NO_DACK', 'UG_ISA_WRITE_PROFILE')}


def capture(build, elf):
    build, elf = Path(build).resolve(), Path(elf).resolve()
    root = Path(__file__).resolve().parents[2]
    inputs = {root / 'sw/CMakeLists.txt', Path(__file__).resolve(),
              root / 'tools/ultrags/diag-schema.json', root / 'tools/ultrags/gen-diag.py'}
    deps = list(build.rglob('*.o.d'))
    if not deps:
        raise ValueError('missing compiler dependencies')
    for dep in deps:
        text = dep.read_text().replace('\\\n', ' ')
        for value in shlex.split(text.split(':', 1)[1]):
            path = Path(value)
            inputs.add((build / path).resolve() if not path.is_absolute() else path.resolve())
    return {'elf_sha256': digest(elf),
            'artifacts': {ext: digest(elf.with_suffix('.'+ext)) for ext in ('elf', 'bin', 'uf2')},
            'configuration': configuration(build),
            'inputs': {str(path): digest(path) for path in sorted(inputs)}}


def verify(build, elf):
    path = Path(build) / 'standalone-evidence.json'
    recorded = json.loads(path.read_text())
    if recorded != capture(build, elf):
        raise ValueError('stale standalone source/configuration/ELF evidence; rebuild diagnostic')
    return recorded


def verify_uf2(data, binary, origin=0x10000000):
    if not data or len(data) % 512:
        raise ValueError('invalid UF2 block size')
    count = len(data) // 512
    payload = bytearray()
    for i in range(count):
        offset = i * 512
        magic0, magic1, flags, addr, size, number, total, family = struct.unpack_from('<8I', data, offset)
        if (magic0, magic1, flags, size, number, total, family) != (
                0x0A324655, 0x9E5D5157, 0x2000, 256, i, count, 0xE48BFF56):
            raise ValueError('invalid RP2040 UF2 header/sequence')
        if struct.unpack_from('<I', data, offset + 508)[0] != 0x0AB16F30:
            raise ValueError('invalid UF2 end magic')
        if addr != origin + i * 256 or addr + size > 0x10200000 - 4096:
            raise ValueError('non-standalone or settings-overlapping UF2 address')
        payload.extend(data[offset + 32:offset + 32 + size])
    if count != (len(binary) + 255) // 256 or payload[:len(binary)] != binary or any(payload[len(binary):]):
        raise ValueError('UF2 payload differs from linked BIN')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', required=True)
    parser.add_argument('--elf', required=True)
    args = parser.parse_args()
    evidence = capture(args.build, args.elf)
    (Path(args.build) / 'standalone-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
