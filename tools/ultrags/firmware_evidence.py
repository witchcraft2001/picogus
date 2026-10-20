#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Content provenance captured when a standalone ELF is linked, not at packaging."""
import argparse
import hashlib
import json
import shlex
import struct
import subprocess
import datetime
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


def compare_image_except_sdk_date(baseline, image, elf, nm):
    """Allow only the SDK's declared BI build-date string to vary.

    Resolve its pointer through the actual linked ELF/BI table. No instruction,
    other string, padding, address or header byte is normalized.
    """
    baseline,image=bytes(baseline),bytes(image)
    if baseline==image:return {'comparison':'BYTE_IDENTICAL'}
    data=Path(elf).read_bytes();assert data[:6]==b'\x7fELF\x01\x01'
    phoff=struct.unpack_from('<I',data,28)[0];stride,count=struct.unpack_from('<HH',data,42)
    segments=[]
    for i in range(count):
        kind,off,va,pa,n,_,_,_=struct.unpack_from('<8I',data,phoff+i*stride)
        if kind==1 and n:segments.append((off,va,pa,n))
    def locate(address,n):
        matches=[(off+address-va,pa+address-va) for off,va,pa,size in segments if va<=address and address+n<=va+size]
        assert len(matches)==1,(hex(address),n)
        return matches[0]
    names={}
    for line in subprocess.check_output([nm,'--defined-only',str(elf)],text=True).splitlines():
        parts=line.split()
        if len(parts)==3:names[parts[2]]=int(parts[0],16)
    dates=[]
    for address in range(names['__binary_info_start'],names['__binary_info_end'],4):
        off,_=locate(address,4);record=struct.unpack_from('<I',data,off)[0]
        off,_=locate(record,12);kind,tag,identifier,pointer=struct.unpack_from('<HHII',data,off)
        if (kind,tag,identifier)==(6,0x5052,0x9da22254):dates.append(pointer)
    assert len(dates)==1,'missing/duplicate declared SDK build date'
    off,physical=locate(dates[0],12);new_date=data[off:off+12]
    # PT_LOAD includes page-alignment padding before non-4KiB slot starts.
    # objcopy's BIN begins at the actual boot2/FLASH symbol, not that page.
    origin=names['__flash_binary_start'];assert origin==names['__boot2_start__']
    index=physical-origin;assert image[index:index+12]==new_date and len(baseline)==len(image)
    old_date=baseline[index:index+12]
    for value in (old_date,new_date):
        assert value[-1]==0
        datetime.datetime.strptime(value[:-1].decode('ascii'),'%b %d %Y')
    adjusted=bytearray(image);adjusted[index:index+12]=old_date
    assert adjusted==baseline,'non-date working-mode bytes changed'
    return {'comparison':'IDENTICAL_EXCEPT_DECLARED_SDK_DATE','offset':index,
            'old_date':old_date[:-1].decode(),'new_date':new_date[:-1].decode()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', required=True)
    parser.add_argument('--elf', required=True)
    args = parser.parse_args()
    evidence = capture(args.build, args.elf)
    (Path(args.build) / 'standalone-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
