#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Reject damaged final bundles even when the outer package hashes are new."""
import argparse
import json
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / 'tools/ultrags'))
from cfg_evidence import verify_multifw,verify_isa_reports

parser = argparse.ArgumentParser()
parser.add_argument('--build', type=Path, required=True)
args = parser.parse_args()
source = (args.build / 'multifw-release').resolve()
verify_multifw(source)
passed = 1


def damaged(name, relative, change):
    global passed
    with tempfile.TemporaryDirectory(prefix='ug-cfg-bundle-') as temp:
        directory = Path(temp)
        for path in source.iterdir():
            if path.is_file():
                (directory / path.name).symlink_to(path)
        generated = directory / 'generated/multifw'
        generated.mkdir(parents=True)
        for path in (source / 'generated/multifw').iterdir():
            if path.is_file():
                (generated / path.name).symlink_to(path)
        path = directory / relative
        data = path.read_bytes()
        path.unlink()
        if change is not None:
            path.write_bytes(change(bytearray(data)))
        try:
            verify_multifw(directory)
        except (ValueError, FileNotFoundError):
            passed += 1
            print('PASS ' + name)
        else:
            raise AssertionError('accepted ' + name)


def flip(offset):
    def change(data):
        data[offset] ^= 1
        return data
    return change


damaged('UF2 payload substitution', 'picogus.uf2', flip(32))
damaged('UF2 address substitution', 'picogus.uf2', flip(12))
damaged('UF2 family substitution', 'picogus.uf2', flip(28))
damaged('UF2 end magic', 'picogus.uf2', flip(508))
damaged('UF2 truncation', 'picogus.uf2', lambda data: data[:-512])
damaged('BIN bundle substitution', 'picogus.bin', flip(32))
damaged('bootloader substitution', 'bootloader.bin', flip(32))
damaged('missing bootloader link evidence', 'bootloader.evidence.json', None)
damaged('mode image substitution', 'pg-ultrags-multifw.bin', flip(32))
damaged('catalogue corruption', 'generated/multifw/catalog.bin', flip(144))


def overlap(data):
    mapping = json.loads(data)
    mapping['images'][1]['offset'] = mapping['images'][0]['offset']
    return json.dumps(mapping).encode()


damaged('overlapping slot map', 'generated/multifw/flash-map.json', overlap)
print(f'CFG complete firmware provenance: {passed} PASS')

reports = verify_isa_reports(args.build)
for mutation in ('missing', 'failed', 'stale-input', 'stale-disassembly', 'missing-psram', 'failed-psram', 'stale-psram', 'missing-save', 'failed-save', 'stale-save'):
    with tempfile.TemporaryDirectory(prefix='ug-cfg-isa-') as temp:
        directory = Path(temp)
        for report in reports:
            dest = directory / report.relative_to(args.build)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(report.read_bytes())
        path = directory / reports[4 if 'save' in mutation else 3 if 'psram' in mutation else 0].relative_to(args.build)
        data = json.loads(path.read_text())
        if mutation.startswith('missing'): path.unlink()
        else:
            if mutation.startswith('failed'): data['status'] = 'FAIL'
            else:
                group = data['inputs' if mutation in ('stale-input', 'stale-psram', 'stale-save') else 'artifacts']
                group[next(iter(group))] = '0' * 64
            path.write_text(json.dumps(data))
        try: verify_isa_reports(directory)
        except (ValueError, FileNotFoundError): print('PASS ISA gate ' + mutation)
        else: raise AssertionError('accepted ISA gate ' + mutation)
print('CFG mandatory linked ARM/PIO/PSRAM/fuse/SAVE clock gates: 11 PASS')
