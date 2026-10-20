#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Bind the COMPAT PIO checks to both actual linked MULTIFW images."""
import argparse
import json
import re
import struct
import subprocess
from pathlib import Path
from cfg_evidence import verify_multifw, digest

p = argparse.ArgumentParser()
p.add_argument('build_a', type=Path)
p.add_argument('build_b', type=Path)
a = p.parse_args()
results = []
inputs = {str(Path(__file__).resolve()): digest(__file__)}
for build in (a.build_a, a.build_b):
    fw = build.resolve() / 'multifw-release'
    bundle = verify_multifw(fw)
    elf = fw / 'pg-ultrags-multifw.elf'
    data = elf.read_bytes()
    cache = (fw / 'CMakeCache.txt').read_text()
    flags = fw / 'CMakeFiles/pg-ultrags-multifw.dir/flags.make'
    defines = flags.read_text()
    led = 'UG_LED_DIAG:BOOL=ON' in cache
    probe = 'UG_CONFIG_PROBE:BOOL=ON' in cache
    fast = 'UG_CONFIG_CATALOG_FAST:BOOL=ON' in cache
    gs_fast = 'UG_GS_STATUS_FAST:BOOL=ON' in cache
    assert not (fast and probe)
    assert not gs_fast or fast
    identity = ('pg-ultrags-gsfast-r13' if gs_fast else 'pg-ultrags-cfgfast-r12' if fast else
                'pg-ultrags-cfgprobe-r11' if probe else 'pg-ultrags-compat-r10' + ('-led' if led else '')) + ' v4.1.1'
    assert ('UG_CONFIG_CATALOG_FAST=1' in defines) == fast
    assert ('UG_GS_STATUS_FAST=1' in defines) == gs_fast
    assert ('UG_CONFIG_PROBE=1' in defines) == probe
    assert ('UG_LED_DIAG=1' in defines) == led
    for define in ('UG_ISA_COMPAT_READ=1', 'UG_LANES=32'):
        assert define in defines, define
    for define in ('UG_ISA_EARLY_READ', 'UG_CONFIG_TRACE', 'UG_ISA_POSTED'):
        assert define not in defines, define
    assert 'UG_ISA_FRONTEND:STRING=COMPAT' in cache
    nm = re.search(r'^CMAKE_NM:[^=\n]+=(.*)$', cache, re.M)[1]
    symbols = {}
    for line in subprocess.check_output([nm, '--defined-only', str(elf)], text=True).splitlines():
        fields = line.split()
        if len(fields) == 3:
            symbols[fields[2]] = int(fields[0], 16)
    assert data[:6] == b'\x7fELF\x01\x01'
    phoff = struct.unpack_from('<I', data, 28)[0]
    stride, count = struct.unpack_from('<HH', data, 42)
    segments = [struct.unpack_from('<8I', data, phoff + i * stride) for i in range(count)]

    def read(address, size):
        matches = [data[off + address - va:off + address - va + size]
                   for kind, off, va, pa, n, _, _, _ in segments
                   if kind == 1 and va <= address and address + size <= va + n]
        assert len(matches) == 1
        return matches[0]

    words = {}
    probe_check = None
    for header, name, n in [('isa_io.pio.h', 'iow_program_instructions', 10),
                            ('ug_compat_ior.pio.h', 'ug_compat_ior_program_instructions', 22)]:
        path = fw / header
        array = re.search(name + r'\[\] = \{(.*?)\};', path.read_text(), re.S)[1]
        values = [int(v, 16) for v in re.findall(r'^\s*(0x[0-9a-fA-F]+),', array, re.M)]
        assert len(values) == n
        found = [v for k, v in symbols.items() if k.endswith(name)]
        assert len(found) == 1
        assert read(found[0], n * 2) == struct.pack('<' + 'H' * n, *values)
        words[name] = n
        inputs[str(path)] = digest(path)
        if probe or fast:
            prior = Path('build/config-r10-delivery/evidence/build-a') / header
            old_array = re.search(name + r'\[\] = \{(.*?)\};', prior.read_text(), re.S)[1]
            old_values = [int(v, 16) for v in re.findall(r'^\s*(0x[0-9a-fA-F]+),', old_array, re.M)]
            assert values == old_values, 'R11/R12 must preserve R10 PIO words'
            inputs[str(prior.resolve())] = digest(prior)
    if probe:
        # Execute the small linked Thumb span, failing closed on an unexpected
        # instruction. Prove the actual GPIO load precedes the sole FIFO store,
        # with no metadata writes/calls in this span. r1 is the prepared byte.
        start, end = (symbols[n] for n in ('ug_config_probe_sample', 'ug_config_probe_submitted'))
        assert 0 < end - start <= 32 and (end - start) % 2 == 0
        insns = struct.unpack('<' + 'H' * ((end - start) // 2), read(start, end - start))
        for byte in range(256):
            regs, accesses = [None] * 16, []
            regs[1] = byte
            for i, op in enumerate(insns):
                pc = start + 2 * i
                if op & 0xf800 == 0x2000:  # MOVS imm8
                    regs[(op >> 8) & 7] = op & 255
                elif op & 0xf800 == 0x4800:  # LDR literal
                    regs[(op >> 8) & 7] = struct.unpack('<I', read(((pc + 4) & ~3) + (op & 255) * 4, 4))[0]
                elif op & 0xf800 == 0:  # LSLS imm
                    regs[op & 7] = (regs[(op >> 3) & 7] << ((op >> 6) & 31)) & 0xffffffff
                elif op & 0xffc0 == 0x4300:  # ORRS
                    regs[op & 7] |= regs[(op >> 3) & 7]
                elif op & 0xf800 == 0x6800:  # LDR imm
                    addr = regs[(op >> 3) & 7] + ((op >> 6) & 31) * 4
                    assert addr == 0xd0000004, hex(addr)
                    regs[op & 7] = 0x04000020
                    accesses.append(('gpio', pc))
                elif op & 0xf800 == 0x6000:  # STR imm
                    addr = regs[(op >> 3) & 7] + ((op >> 6) & 31) * 4
                    assert addr == 0x50200014 and regs[op & 7] == 0xff00 | byte
                    accesses.append(('fifo', pc))
                else:
                    raise AssertionError(f'unexpected probe instruction {pc:x}: {op:04x}')
            assert accesses == [('gpio', end - 4), ('fifo', end - 2)]
        probe_check = {'sampleLabel': hex(start), 'submittedLabel': hex(end),
                       'gpioAddress': '0xd0000004', 'fifoAddress': '0x50200014',
                       'dataCases': 256, 'adjacentLoadStore': True,
                       'pioIdenticalToR10': True, 'words': list(insns)}
    for name in ('guard_irq', 'ug_compat_note_write', 'ug_compat_sync_ports',
                 'ug_handshake_guard_core1', 'firmware_string'):
        assert 0x20000000 <= symbols[name] < 0x20042000, name
    string_address = struct.unpack('<I', read(symbols['firmware_string'], 4))[0]
    assert 0x20000000 <= string_address < 0x20042000
    assert read(string_address, 64).split(b'\0')[0] == identity.encode()
    if not led:
        assert 'led_irq' not in symbols
        assert not any(k.startswith('ug_led_') for k in symbols), 'diagnostic code remains linked'
    assert not any(k in symbols for k in ('ug_handshake_put', 'ug_handshake_sync_ports'))
    for path in (elf, flags, fw / 'CMakeCache.txt', fw / 'picogus.uf2'):
        inputs[str(path)] = digest(path)
    results.append({'build': str(fw), 'bundle': bundle, 'pioWords': words,
                    'firmware': identity, 'ledDiagnostic': led, 'configProbe': probe, 'catalogFast': fast,'gsStatusFast': gs_fast,
                    'probeCheck': probe_check, 'guardInSRAM': True})
assert results[0]['bundle']['sha256'] == results[1]['bundle']['sha256']
out = a.build_a / 'host/compat-linked.json'
out.write_text(json.dumps({'status': 'LINKED_PASS / REAL_PENDING', 'builds': results,
                          'inputs': inputs,
                          'limits': ['No electrical timing or hardware startup measurement']}, indent=2) + '\n')
print('Both MULTIFW verified; UF2 identical; linked IOW10/IOR22 words, SRAM guard and firmware identity PASS')
