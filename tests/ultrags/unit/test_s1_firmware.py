#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tools/ultrags'))
from firmware_evidence import capture, verify, verify_uf2


def uf2(binary):
    count = (len(binary) + 255) // 256
    blocks = []
    for i in range(count):
        block = bytearray(512)
        struct.pack_into('<8I', block, 0, 0x0A324655, 0x9E5D5157, 0x2000,
                         0x10000000 + i * 256, 256, i, count, 0xE48BFF56)
        payload = binary[i*256:(i+1)*256]
        block[32:32+len(payload)] = payload
        struct.pack_into('<I', block, 508, 0x0AB16F30)
        blocks.append(block)
    return b''.join(blocks)


class FirmwareEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.binary = bytes(range(256)) + b'last'
        self.data = uf2(self.binary)

    def test_uf2_payload_matches_bin(self):
        verify_uf2(self.data, self.binary)

    def test_wrong_family(self):
        data = bytearray(self.data)
        struct.pack_into('<I', data, 28, 0xE48BFF59)
        with self.assertRaisesRegex(ValueError, 'header'):
            verify_uf2(data, self.binary)

    def test_duplicate_or_missing_block(self):
        with self.assertRaises(ValueError):
            verify_uf2(self.data[:512] * 2, self.binary)
        with self.assertRaises(ValueError):
            verify_uf2(self.data[:512], self.binary)

    def test_payload_corruption(self):
        data = bytearray(self.data)
        data[33] ^= 1
        with self.assertRaisesRegex(ValueError, 'payload'):
            verify_uf2(data, self.binary)

    def test_slot_origin(self):
        data = bytearray(self.data)
        struct.pack_into('<I', data, 12, 0x10008000)
        with self.assertRaisesRegex(ValueError, 'address'):
            verify_uf2(data, self.binary)

    def test_end_magic(self):
        data = bytearray(self.data)
        data[508] ^= 1
        with self.assertRaisesRegex(ValueError, 'end magic'):
            verify_uf2(data, self.binary)

    def test_stale_content_not_mtime(self):
        with tempfile.TemporaryDirectory() as work:
            build = Path(work)
            elf = build / 'firmware.elf'
            elf.write_bytes(b'ELF fixture')
            elf.with_suffix('.bin').write_bytes(self.binary)
            elf.with_suffix('.uf2').write_bytes(self.data)
            source = build / 'source.c'
            source.write_text('old')
            (build / 'CMakeCache.txt').write_text('PROJECT_TYPE:STRING=ULTRAGS_DIAG\nPGDEBUG:BOOL=OFF\nUG_DIAG_NO_DACK:BOOL=OFF\n')
            deps = build / 'CMakeFiles/pg-ultrags-diag.dir'
            deps.mkdir(parents=True)
            (deps / 'main.o.d').write_text(f'main.o: {source}\n')
            (build / 'standalone-evidence.json').write_text(json.dumps(capture(build, elf)))
            verify(build, elf)
            elf.with_suffix('.bin').write_bytes(b'substituted BIN')
            with self.assertRaisesRegex(ValueError, 'stale'):
                verify(build, elf)
            elf.with_suffix('.bin').write_bytes(self.binary)
            source.write_text('new')
            with self.assertRaisesRegex(ValueError, 'stale'):
                verify(build, elf)


if __name__ == '__main__':
    unittest.main(verbosity=2)
