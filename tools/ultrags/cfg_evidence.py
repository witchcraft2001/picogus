# SPDX-License-Identifier: GPL-2.0-or-later
"""Validate the complete MULTIFW bytes before publishing a CFG bundle."""
import hashlib
import json
import struct
import zlib
from pathlib import Path

from firmware_evidence import verify_uf2


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_isa_reports(build):
    """Require current linked-code, generated-PIO and independent fuse gates."""
    build = Path(build)
    reports = [build / 'host/firmware-paths/paths.json', build / 'host/pio-isa.json',
               build / 'host/guard/guard.json', build / 'host/psram-id.json']
    statuses = ['LINKED_ARM_PIO_PASS / REAL_PENDING', 'HOST_PIO_INSTRUCTION_PASS / REAL_PENDING',
                'HOST_GUARD_PASS / REAL_PENDING', 'HOST_PSRAM_ID_INSTRUCTION_PASS / REAL_PENDING']
    for path, status in zip(reports, statuses):
        evidence = json.loads(path.read_text())
        require(evidence['status'] == status and evidence['inputs'], 'incomplete ISA gate: ' + str(path))
        for group in ('inputs', 'artifacts'):
            for source, expected in evidence.get(group, {}).items():
                require(digest(source) == expected, 'stale ISA gate: ' + source)
    pio = json.loads(reports[1].read_text())
    require((pio['maps'], pio['addresses'], pio['pio0_words'], pio['delayed_info_frames']) ==
            (256, 262144, 32, 96), 'incomplete generated PIO matrix')
    require(pio['autopull_barrier'] == pio['simultaneous_iow_ior'] == 'PASS', 'incomplete shared PIO semantics')
    psram = json.loads(reports[3].read_text())
    require((psram['cases'], psram['pio_words'], psram['old_sck_edges'], psram['new_sck_edges'], psram['compiled_programs']) ==
            (768, 9, 97, 56, 3), 'incomplete READ ID PIO gate')
    require(psram['old_same_length_sck_edges'] == 57 and psram['cs_active_steps'] <= 125, 'READ ID clocks/CS boundary')
    require(psram['corrected_id'].startswith('0d5d40'), 'READ ID byte alignment failure')
    return reports


def verify_multifw(directory):
    directory = Path(directory)
    mapping = json.loads((directory / 'generated/multifw/flash-map.json').read_text())
    images = mapping['images']
    require([e['mode'] for e in images] == [1, 2, 3, 4, 5, 6, 8], 'MULTIFW image IDs')
    require([e['name'] for e in images] ==
            ['pg-gus', 'pg-adlib', 'pg-mpu', 'pg-psg', 'pg-sb', 'pg-usb', 'pg-ultrags'],
            'MULTIFW image names')
    require((mapping['bootstrap_limit'], mapping['catalog_offset'], mapping['catalog_length'],
             mapping['settings_offset']) == (0x7c00, 0x7c00, 148, 0x1ff000), 'MULTIFW Flash map')

    # Include the bootloader: otherwise old/tampered recovery code can be
    # paired with freshly verified mode images and acquire a new outer hash.
    targets = ['bootloader'] + [e['name'] + '-multifw' for e in images]
    for target in targets:
        evidence = json.loads((directory / (target + '.evidence.json')).read_text())
        require(evidence['target'] == target and evidence['inputs'], 'MULTIFW link identity')
        require(set(evidence['artifacts']) == {'elf', 'bin', 'uf2'}, 'MULTIFW link artifacts')
        for source, expected in evidence['inputs'].items():
            require(digest(source) == expected, 'stale MULTIFW source: ' + source)
        for extension, expected in evidence['artifacts'].items():
            require(digest(directory / (target + '.' + extension)) == expected,
                    'stale MULTIFW linked artifact: ' + target + '.' + extension)

    catalog = (directory / 'generated/multifw/catalog.bin').read_bytes()
    require(len(catalog) == 148 and catalog[:16] == b'UGCF\1\0\10\20\x94\0\0\0\0\0\0\0',
            'MULTIFW catalogue header')
    require(zlib.crc32(catalog[:144]) == struct.unpack_from('<I', catalog, 144)[0],
            'MULTIFW catalogue CRC')
    require(catalog[112:128] == bytes([7]) + bytes(15), 'MULTIFW absent NE2000 record')

    boot = (directory / 'bootloader.bin').read_bytes()
    require(len(boot) <= 0x7c00, 'MULTIFW bootloader overlaps catalogue')
    previous = 0x8000
    payloads = []
    for image in images:
        offset, capacity = image['offset'], image['capacity']
        data = (directory / (image['name'] + '-multifw.bin')).read_bytes()
        require(offset >= previous and offset % 1024 == 0 and capacity >= 1024 and
                capacity % 1024 == 0 and offset + capacity <= 0x1ff000,
                'MULTIFW overlapping/invalid slot')
        require(264 <= len(data) <= capacity and len(data) == image['length'] and
                zlib.crc32(data) == image['crc'] and digest(directory / (image['name'] + '-multifw.bin')) == image['sha256'],
                'MULTIFW image does not match Flash map')
        record = struct.unpack_from('<BBHIII', catalog, 16 + (image['mode'] - 1) * 16)
        require(record == (image['mode'], 1, 0, offset, len(data), zlib.crc32(data)),
                'MULTIFW catalogue differs from linked image')
        previous = offset + capacity
        payloads.append((offset, data))

    size = (max(offset + len(data) for offset, data in payloads) + 255) & ~255
    expected = bytearray(b'\xff' * size)
    expected[:len(boot)] = boot
    expected[0x7c00:0x7c00 + 148] = catalog
    for offset, data in payloads:
        expected[offset:offset + len(data)] = data
    binary = (directory / 'picogus.bin').read_bytes()
    require(binary == expected, 'MULTIFW bundle differs from verified bootloader/catalogue/images')
    verify_uf2((directory / 'picogus.uf2').read_bytes(), binary)
    return {'targets': targets, 'sha256': digest(directory / 'picogus.uf2')}
