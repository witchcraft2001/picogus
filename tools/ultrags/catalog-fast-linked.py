#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute the linked R3 catalogue span and post-reply completion accounting; no electrical timing claim."""
import argparse
import hashlib
import json
import re
import struct
import subprocess
from pathlib import Path
import unicorn
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS, UC_HOOK_CODE, UC_HOOK_MEM_WRITE, UC_HOOK_MEM_READ
from unicorn.arm_const import UC_ARM_REG_PC, UC_ARM_REG_SP, UC_CPU_ARM_CORTEX_M0

p = argparse.ArgumentParser()
p.add_argument('build_a', type=Path)
p.add_argument('build_b', type=Path)
a = p.parse_args()
digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
inputs = {str(Path(__file__).resolve()): digest(__file__)}
results = []
for build in (a.build_a, a.build_b):
    fw = build.resolve() / 'multifw-release'
    elf = fw / 'pg-ultrags-multifw.elf'
    cache = (fw / 'CMakeCache.txt').read_text()
    nm = re.search(r'^CMAKE_NM:[^=\n]+=(.*)$', cache, re.M)[1]
    syms = {}
    for line in subprocess.check_output([nm, '--defined-only', str(elf)], text=True).splitlines():
        fields = line.split()
        if len(fields) == 3:
            syms[fields[2]] = int(fields[0], 16)
    start, sent, end = (syms[n] for n in ('ug_catalog_fast_begin', 'ug_catalog_fast_submitted', 'ug_catalog_fast_done'))
    cfg = syms['ug_cfg']
    uc = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
    uc.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M0)
    for addr, length in [(0x10000000, 0x200000), (0x20000000, 0x50000), (0x50200000, 0x1000), (0xd0000000, 0x1000)]:
        uc.mem_map(addr, length)
    data = elf.read_bytes()
    phoff = struct.unpack_from('<I', data, 28)[0]
    stride, count = struct.unpack_from('<HH', data, 42)
    for i in range(count):
        kind, off, va, pa, n, _, _, _ = struct.unpack_from('<8I', data, phoff + i * stride)
        if kind == 1 and n:
            uc.mem_write(va, data[off:off+n])
    assert bytes(uc.mem_read(start+2,2))==b'\x03\x99', 'R3 entry must read cfg from sp+12'
    assert bytes(uc.mem_read(start+36,2))==b'\x05\x98', 'completion pointer must be loaded from sp+20 after reply'
    completion=syms['ug_compat_completions'];atomic=syms['__atomic_fetch_add_4'];stack=0x2004f000
    state = {}

    def step(cpu, address, size, _):
        if address == end:
            cpu.emu_stop()
            return
        assert start <= address < end or (state['writes'] and atomic<=address<atomic+40), f'unexpected call/branch {address:x}'
        state['instructions'] += 1
        if address == sent:
            assert state['writes'] == [(0x50200014, 4, state['payload'])]
            assert state['accounted'] and state['spinReads']

    def write(cpu, access, address, size, value, _):
        if address == 0x50200014:
            state['beforeSubmit']=state['instructions']
            assert not state['writes'] and value == state['payload'] and size == 4
            assert struct.unpack('<H', cpu.mem_read(cfg + 300, 2))[0] == state['index']
        elif address==completion:
            assert state['writes']==[(0x50200014,4,state['payload'])] and value==1 and size==4
            state['accounted']=True
            return
        elif address==0xd0000134:
            assert state['accounted'] and value==0 and size==4
            return
        else:
            assert state['accounted']
            assert address == cfg + 300 and size == 2
            assert state['writes'] == [(0x50200014, 4, state['payload'])]
            assert state['index'] < 148 and value == state['index'] + 1
        state['writes'].append((address, size, value))

    def spin(cpu,access,address,size,value,_):
        assert state['writes'], 'spinlock before FIFO reply'
        state['spinReads']+=1;cpu.mem_write(address,struct.pack('<I',1))
    uc.hook_add(UC_HOOK_MEM_READ,spin,begin=0xd0000134,end=0xd0000137)
    uc.hook_add(UC_HOOK_CODE, step)
    uc.hook_add(UC_HOOK_MEM_WRITE, write)
    cases, counts = 0, set()
    for index in [*range(150), 65535]:
        for value in (range(256) if index < 148 else [255]):
            uc.mem_write(cfg + 152, bytes([0xa5]) * 148)
            if index < 148:
                uc.mem_write(cfg + 152 + index, bytes([value]))
            uc.mem_write(cfg + 300, struct.pack('<H', index))
            # Verified R3 stack contract; execute real atomic accounting after FIFO.
            # Surrounding live-cycle/selector dispatch is exercised by the C fixture.
            uc.reg_write(UC_ARM_REG_SP,stack);uc.mem_write(stack+12,struct.pack('<I',cfg))
            uc.mem_write(stack+20,struct.pack('<I',completion));uc.mem_write(completion,bytes(4))
            state = {'index': index, 'payload': 0xff00 | value,
                     'writes': [], 'instructions': 0,'accounted':False,'spinReads':0}
            uc.emu_start(start | 1, end, count=100)
            assert uc.reg_read(UC_ARM_REG_PC) == end
            expected_index = index + 1 if index < 148 else index
            assert struct.unpack('<H', uc.mem_read(cfg + 300, 2))[0] == expected_index
            assert len(state['writes']) == (2 if index < 148 else 1)
            counts.add(state['beforeSubmit'])
            cases += 1
    # Independently counted R3 Thumb path: 18 instructions in-range, 14 at EOF.
    assert cases == 37891 and counts == {14,18}, (cases,counts)
    results.append({'build': str(build), 'cases': cases, 'instructionsThroughFIFOStore': sorted(counts),
                    'noCallsBeforeFIFO': True,'completionAccountingAfterFIFO':True, 'fifoBeforeIndex': True})
    for path in (elf, fw / 'CMakeCache.txt'):
        inputs[str(path)] = digest(path)
out = a.build_a / 'host/catalog-fast-linked.json'
out.write_text(json.dumps({
    'status': 'LINKED_FAST_CATALOG_PASS / REAL_PENDING', 'builds': results,
    'unicorn': unicorn.__version__, 'inputs': inputs,
    'limits': ['Span begins after IO_WAIT; does not bound full dispatch latency.',
               'Entry sp+12=ug_cfg and sp+20=completion pointer are supplied; full main initialization is not emulated.',
               'No physical timing, SRAM contention, WAIT acceptance or host sampling measurement.']
}, indent=2) + '\n')
print('Both linked spans: 37891 cases each; FIFO before accounting/index, no pre-reply calls; instructions:', sorted(counts))
