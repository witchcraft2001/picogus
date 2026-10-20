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
               build / 'host/guard/guard.json', build / 'host/psram-id.json',build / 'host/save-clock.json',build/'host/audio-render.json',build/'host/config-read-arm.json',build/'host/write-window/write-window.json',build/'host/config-read-deadline.json']
    statuses = ['LINKED_ARM_PIO_PASS / REAL_PENDING', 'HOST_PIO_INSTRUCTION_PASS / REAL_PENDING',
                'HOST_GUARD_PASS / REAL_PENDING', 'HOST_PSRAM_ID_INSTRUCTION_PASS / REAL_PENDING',
                'LINKED_SAVE_CLOCK_PASS / REAL_PENDING','LINKED_AUDIO_INSTRUCTION_PASS / REAL_PENDING','LINKED_CONFIG_READ_PASS / REAL_PENDING','GENERATED_PIO_TO_PRODUCTION_C_PASS / REAL_PENDING','LINKED_CONFIG_WAIT_LATCH_PASS / REAL_PENDING']
    for path, status in zip(reports, statuses):
        evidence = json.loads(path.read_text())
        require(evidence['status'] == status and evidence['inputs'], 'incomplete ISA gate: ' + str(path))
        for group in ('inputs', 'artifacts'):
            for source, expected in evidence.get(group, {}).items():
                require(digest(source) == expected, 'stale ISA gate: ' + source)
    pio = json.loads(reports[1].read_text())
    require((pio['maps'], pio['addresses'], pio['pio0_words'], pio['delayed_info_frames']) ==
            (512, 1048576, 32, 288), 'incomplete generated PIO matrix')
    require(pio['autopull_barrier'] == pio['simultaneous_iow_ior'] == 'PASS', 'incomplete shared PIO semantics')
    require(pio['write_clock_phases']==12 and pio['writes']==524288,'incomplete IOW/IOR passivity matrix')
    require(json.loads(reports[2].read_text())['addressOnlyInit']=='PASS','untested IOR/IOW SM initialization')
    edge=pio.get('read_rearm',{})
    require(edge.get('cases')==4096 and edge.get('candidate_duplicates')==0 and edge.get('r5_duplicates')=='REPRODUCED' and edge.get('ownership_cases')==4,'missing IOR rearm/ownership-feedback regression')
    require(pio['mux_settle']==dict(patterns=256,gus_pio_clocks=8,r2_pio_clocks=4,fixed_pio_clocks=16,r2_wrong_bytes=255,iow_clock_multiple_of_gus=2,mux_setup_not_shorter_than_gus=True,divider256_gus=517,divider256_candidate=259),'incomplete ADS settling regression')
    psram = json.loads(reports[3].read_text())
    require((psram['cases'], psram['pio_words'], psram['old_sck_edges'], psram['new_sck_edges'], psram['compiled_programs']) ==
            (768, 9, 97, 56, 3), 'incomplete READ ID PIO gate')
    require(psram['old_same_length_sck_edges'] == 57 and psram['cs_active_steps'] <= 125, 'READ ID clocks/CS boundary')
    require(psram['corrected_id'].startswith('0d5d40'), 'READ ID byte alignment failure')
    save=json.loads(reports[4].read_text())
    require((save['core_clock_hz'],save['boot2_divider'],save['rom_command_divider'])==(370000000,4,6),'SAVE clock/divider audit')
    require(len(save['host_cases'])==6 and all(x['ok'] for x in save['host_cases']),'SAVE clock host mutations')
    require(not save['closures']['ultrags']['clock_calls'] and save['closures']['gus']['clock_calls'],'SAVE linked clock closure')
    audio=json.loads(reports[5].read_text())
    require(audio['cpu']=='Cortex-M0' and audio['unicorn']=='2.1.4','audio linked-code CPU/runtime')
    require({x['profile'] for x in audio['cases']}=={'mod4','mod4-one-stereo','mod4-two-stereo','paused-mod-two-stereo','stereo-balance','twelve-lane','32-mono-48000','32-mono-44100','16-stereo-48000','mod4-28-fx'},'audio profile coverage')
    require(len(audio['cases'])==10 and all(x['frames']==1024 and x['instructions']>0 and x['cacheReads']>0 and not x['division64Calls'] and x['independentOracle']=='PASS' for x in audio['cases']),'audio exact samples / hot division gate')
    config=json.loads(reports[6].read_text())
    require(config['cpu']=='Cortex-M0' and len(config['cases'])==12,'incomplete CONFIG capture regression')
    require(all(c['fixed']['sampled']==(255 if c['fixed']['expired'] else 36) and
                c['fixed']['consumed']==(0 if c['fixed']['expired'] else 1) and
                c['baseline']['sampled']==255 for c in config['cases']),'CONFIG delayed reply/stale eligibility regression')
    window=json.loads(reports[7].read_text())
    require(window['cases']==3072 and window['r3_wrong_bytes']==3060 and window['baselineRejected'] and window['candidateUnlocked'],'incomplete CONFIG write-window regression')
    deadline=json.loads(reports[8].read_text())
    require(len(deadline['cases'])==12,'incomplete CONFIG WAIT latch coverage')
    require(all(c['forced_end']['consumed']==0 and not c['forced_end']['late_drive'] if 'forced_end' in c else c['baseline']['sample']==255 and not c['baseline']['wait_accepted'] and c['candidate']['sample']==36 and c['candidate']['wait_accepted'] and not c['candidate']['late_drive'] for c in deadline['cases']),'CONFIG WAIT latch/stale response regression')
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
