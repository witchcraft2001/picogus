#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Bind early GS PIO and ARM replies to the delivered ELF/UF2, not source claims."""
import argparse, importlib.util, json, re, subprocess, struct
from pathlib import Path
from cfg_evidence import verify_multifw, digest

ROOT = Path(__file__).resolve().parents[2]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

p = argparse.ArgumentParser()
p.add_argument('--build', type=Path, required=True)
a = p.parse_args(); b = a.build.resolve(); fw = b/'multifw-release'
model = module('pio', ROOT/'tools/ultrags/pio-isa-check.py')
control = module('control', ROOT/'tools/ultrags/gs-turbo-control.py')
arm = module('config_arm', ROOT/'tools/ultrags/config-read-arm.py')
bundle = verify_multifw(fw)
elf = fw/'pg-ultrags-multifw.elf'; header = fw/'ug_handshake_ior.pio.h'
words, labels, wrap = model.program(header, 'ug_handshake_ior')
assert len(words) == 32
control.linked_words(fw, elf, {'ug_handshake_ior': words})
fresh = b/'host/gs-turbo/fresh.pio.h'; fresh.parent.mkdir(parents=True, exist_ok=True)
subprocess.run([str(fw/'pioasm-install/pioasm/pioasm'), '-o', 'c-sdk',
                str(ROOT/'sw/ultrags/ug_handshake_ior.pio'), str(fresh)], check=True)
assert model.program(fresh, 'ug_handshake_ior')[0] == words
flags = fw/'CMakeFiles/pg-ultrags-multifw.dir/flags.make'
for flag in ('UG_ISA_GS_TURBO=1', 'UG_ISA_EARLY_READ=1', 'UG_CONFIG_CATALOG_FAST=1', 'UG_GS_STATUS_FAST=1'):
    assert flag in flags.read_text()
assert 'UG_ISA_COMPAT_READ' not in flags.read_text()
nm = re.search(r'^CMAKE_NM:[^=]+=(.*)$', (fw/'CMakeCache.txt').read_text(), re.M)[1]
m = arm.audio.Machine(elf, nm)
for name in ('guard_irq', 'ug_handshake_sync_ports', 'ug_handshake_take_read', 'ug_handshake_reply'):
    assert 0x20000000 <= m.sym[name] < 0x20042000
ptr = struct.unpack('<I', m.uc.mem_read(m.sym['firmware_string'], 4))[0]
identity = bytes(m.uc.mem_read(ptr, 64)).split(b'\0')[0].decode()
assert identity == 'pg-ultrags-gsturbo-r16 v4.1.1'
old = json.loads((ROOT/'build/gs-turbo-baseline/replayed.json').read_text())
independent = json.loads((b/'host/gs-turbo/independent.json').read_text())
delayed = []
for row in old['traces']:
    port, latency = row['port'], row['latencyTicks']
    sm = model.native(words, labels, wrap, 0x2a0, 0xffff, gs=True)
    result = model.shared_read(sm, labels, port, 0x7e, latency, sample=74)
    assert result == 0x7e
    assert row['sampled'] == (255 if port < 0x200 and latency > 74 else 0x7e)
    delayed.append([port, latency, result])
assert independent['delayed'] == delayed
assert any(r['sampled'] != now[2] for r, now in zip(old['traces'], delayed))
# Real Cortex-M0 machine code for capture, status getter and reply injection.
# The production reply drives the generated PIO tail; no mocked return value.
linked = []
for port in (0xb3, 0xbb, 0x2b3, 0x2bb):
    for latency in (8, 128, 4096):
        for flags_byte in (0, 1, 128, 129):
            m = arm.ConfigRead(elf, nm, header, port, deadline=128, gs=True)
            assert m.call('ug_handshake_capture', [1, port, 1])
            m.advance(latency)
            m.uc.mem_write(m.sym['gs_flags'], bytes([flags_byte]))
            value = m.call('ug_minimal_peek_gs_status', [])
            assert value == (0x7e | flags_byte)
            assert m.call('ug_handshake_reply', [0xff00 | value])
            m.advance(512)
            assert m.sample == value and not m.sm.hold and not m.sm.dirs and not m.sm.ads
            assert not m.sm.rx and not m.sm.tx
            linked.append(dict(port=port, delay=latency, flags=flags_byte, value=value, instructions=m.instructions))
# Real ARM cleanup must retain a subsequent write's exact captured pair.
# PIO instruction capture/tagging is tested separately above; here MMIO RXF
# supplies that pair while the actual ARM code arbitrates/requeues it.
release = []
for port in (0xb2, 0xb3, 0xba, 0xbb, 0xbc, 0x1d2, 0x2a3, 0x303):
    for gs in (False, True):
        m = arm.ConfigRead(elf, nm, header, 0x1d2)
        assert m.call('ug_handshake_capture', [1, 0x1d2, 0])
        owned = port == 0x2a3 or (gs and port in (0xb3, 0xbb))
        raw = ((port & 31) << 27) | (port >> 5) | (1 << 26)
        if owned: raw ^= 0xffffffff
        fifo = [raw, ((0xa5 & 31) << 27) | (0xa5 >> 5)]
        def read_fifo(uc, access, address, size, value, _):
            if address == 0x5020000c: uc.mem_write(address, struct.pack('<I', len(fifo) << 4))
            if address == 0x50200004: uc.mem_write(address, struct.pack('<I', 0 if fifo else 1 << 8))
            if address == 0x50200020: uc.mem_write(address, struct.pack('<I', fifo.pop(0)))
        m.uc.hook_add(arm.UC_HOOK_MEM_READ, read_fifo, begin=0x50200000, end=0x50200023)
        m.uc.mem_write(0x50200000, struct.pack('<I', 1))
        m.uc.mem_write(0x502000d4, struct.pack('<I', labels['parked']))
        m.sm.port=port; m.sm.ior=1; m.iow=0
        m.call('ug_handshake_put', [1, 0])
        assert bool(m.sm.hold) == owned and not fifo
        assert m.call('ug_handshake_has_write', [])
        assert m.call('ug_handshake_take_write', [m.OUT]) == raw
        assert struct.unpack('<I', m.uc.mem_read(m.OUT, 4))[0] == (((0xa5 & 31) << 27) | (0xa5 >> 5))
        assert not m.call('ug_handshake_has_write', [])
        release.append(dict(port=port, gs=gs, held=owned, captures=1))
paths = [Path(__file__), elf, header, flags, fw/'picogus.uf2',
         ROOT/'sw/picogus.cpp', ROOT/'sw/ultrags/ug_handshake.c', ROOT/'sw/ultrags/ug_handshake.h',
         ROOT/'sw/ultrags/ug_handshake_ior.pio', ROOT/'tools/ultrags/pio-isa-check.py',
         ROOT/'tools/ultrags/gs-turbo-control.py', ROOT/'tools/ultrags/config-read-arm.py',
         ROOT/'tools/ultrags/audio-render-check.py', b/'host/gs-turbo/independent.json',
         ROOT/'build/gs-turbo-baseline/replayed.json']
report = dict(status='LINKED_GS_TURBO_PASS / REAL_PENDING', bundle=bundle, identity=identity,
              pio_words=32, delayed=delayed, linked=linked, read_cleanup_overlap=release,
              inputs={str(f.resolve()): digest(f) for f in paths},
              limits=['Instruction scheduling is synthetic, not a Sprinter electrical timing measurement.',
                      'PIO tail and linked ARM replies are exercised; full firmware boot/audio concurrency require hardware.'])
(b/'host/gs-turbo/linked.json').write_text(json.dumps(report, indent=2)+'\n')
print('Linked GS Turbo: exact ELF/UF2 PIO, delayed negative/positive controls, 48 Cortex-M0 replies PASS')
