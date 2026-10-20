#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Capture linked ARM paths and verify compiled PIO instruction bytes."""
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path
from cfg_evidence import verify_multifw

p = argparse.ArgumentParser()
p.add_argument('--build', type=Path, required=True)
p.add_argument('--objdump')
p.add_argument('--objcopy')
p.add_argument('--pioasm')
p.add_argument('--out', type=Path, required=True)
a = p.parse_args()
build, out = a.build.resolve(), a.out.resolve()
out.mkdir(parents=True, exist_ok=True)
verify_multifw(build)  # reject reports made from stale or failed link output
cache = (build / 'CMakeCache.txt').read_text()
compiler = re.search(r'^CMAKE_C_COMPILER:[^=]+=(.*)$', cache, re.M)[1]
objdump = a.objdump or compiler.removesuffix('gcc') + 'objdump'
objcopy = a.objcopy or compiler.removesuffix('gcc') + 'objcopy'
flags = build / 'CMakeFiles/pg-ultrags-multifw.dir/flags.make'
if '-DUG_ISA_EARLY_READ=1' not in flags.read_text():
    raise SystemExit('HANDSHAKE ULTRAGS with the early PIO read filter is required')
inputs = [Path(__file__).resolve(), Path(__file__).with_name('cfg_evidence.py'), build / 'CMakeCache.txt', flags]
artifacts = []
root = Path(__file__).resolve().parents[2]
assembler = Path(a.pioasm) if a.pioasm else build / 'pioasm-install/pioasm/pioasm'
inputs.append(assembler)
for source, header in [(root / 'sw/isa/isa_io.pio', build / 'isa_io.pio.h'),
                       (root / 'sw/ultrags/ug_handshake_ior.pio', build / 'ug_handshake_ior.pio.h')]:
    inputs.append(source)
    with tempfile.TemporaryDirectory(prefix='ug-pio-current-') as directory:
        fresh = Path(directory) / header.name
        subprocess.run([str(assembler), '-o', 'c-sdk', '-v', '0', str(source), str(fresh)], check=True)
        assert fresh.read_bytes() == header.read_bytes(), 'stale pioasm output: ' + str(header)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write(name, text):
    path = out / name
    path.write_text(text)
    artifacts.append(path)

def pio_words(header, name):
    inputs.append(header)
    body = re.search(rf'{name}_program_instructions\[\]\s*=\s*\{{(.*?)\}};', header.read_text(), re.S)[1]
    return [int(x, 16) for x in re.findall(r'0x([0-9a-fA-F]{4})', body)]

pio = {'iow': pio_words(build / 'isa_io.pio.h', 'iow'),
       'gus-ior': pio_words(build / 'isa_io.pio.h', 'ior'),
       'ultrags-ior': pio_words(build / 'ug_handshake_ior.pio.h', 'ug_handshake_ior')}
assert len(pio['ultrags-ior']) == 32
summary = ['# Linked GUS / ULTRAGS ISA paths', '',
    'Actual optimized MULTIFW ELF disassembly, with resolved call destinations.',
    'The full main polling loop and all statically reachable callees are retained.',
    'Indirect calls and physical SRAM arbitration/I2S/PSRAM contention are not bounded by this report.', '',
    'GUS retains its original IOW/IOR programs; ULTRAGS uses one32-word classifier shared by two SMs.',
    'ULTRAGS native IOCHRDY is asserted before PUSH/PULL can block, independently of ARM polling phase.',
    'Generated-instruction tests supply finite ARM hiatuses; core1 TIMER_IRQ_2 handles a stopped core0.',
    'Timer2: core1 priority 0x00; 100 us sampling, 10 ms hold threshold; a trip disconnects the bus until reboot.',
    'The fuse interval is a recovery limit, not the Sprinter electrical timing budget.', '',
    'Worst arrival phase: an idle SM can observe an edge one instruction clock later. Once captured, native matching and early wait use only PIO registers/instructions, with no ARM/SRAM dependency.',
    'ARM work already in progress, timer accesses and statistics atomic locks can delay the data phase; the early wait remains asserted throughout that delay.',
    'HANDSHAKE serializes one transaction per SM: a preceding foreign cycle can still await its ARM verdict. RX FIFO depth is not a burst buffer; arbitrary unbounded foreign traffic is not guaranteed.',
    'Both ULTRAGS IOW and IOR classify BASE/ALIAS and exact enabled B3/BB before capture. IOW retains DACK gating. Both SMs run at up to366MHz (twice GUS183MHz); ADS settling is16 clocks, preserving the GUS8-clock interval. ARM forces the initial two response OUTs; PIO retains the autonomous WAIT/direction-release tail. Real setup/hold/service latency require the functional/electrical REAL gates.', '']
summary.append('IOW parks after two captures. IOR wraps directly to park after a single address/ownership capture, skipping ADS/write-data setup. core0 resumes it with a forced JMP; foreign cleanup has no side-set. GS decoding uses OSR, which core0 empties before delivering each read value. The autonomous read tail releases data directions after IOR rises.')
for name, words in pio.items():
    summary.append(f'{name}: {len(words)} instructions: ' + ' '.join(f'{w:04x}' for w in words))
for mode in ('gus', 'ultrags'):
    target = 'pg-' + mode + '-multifw'
    elf = build / (target + '.elf')
    obj = build / f'CMakeFiles/{target}.dir/picogus.cpp.o'
    inputs.extend([elf, obj])
    text = subprocess.check_output([objdump, '-d', '-C', str(elf)], text=True)
    write(f'{mode}-linked.dis', text)
    blocks = list(re.finditer(r'^([0-9a-f]+) <(.+)>:\n', text, re.M))
    functions = {m[2]: text[m.start():blocks[i+1].start() if i+1 < len(blocks) else len(text)]
                 for i, m in enumerate(blocks)}
    assert 'main' in functions
    def calls(name):
        return {n for n in re.findall(r'\b(?:blx?|b\.w|b\.n)\s+[0-9a-f]+\s+<([^>]+)>', functions[name]) if n in functions}
    roots = {'main'} | {n for n in functions if n.startswith(('apply_iow(', 'read_gus', 'ug_minimal_read_', 'ug_minimal_write_decoded', 'ug_handshake_', 'guard_irq', 'release_bus'))}
    reachable, pending = set(), list(roots)
    while pending:
        name = pending.pop()
        if name in reachable:
            continue
        reachable.add(name)
        for dest in calls(name):
            if dest in functions and dest not in reachable:
                pending.append(dest)
    write(f'{mode}-main.dis', functions['main'])
    write(f'{mode}-paths.dis', '\n'.join(functions[n] for n in sorted(reachable)))
    summary += ['', f'{mode.upper()} linked ELF SHA-256: {sha(elf)}',
                f'{mode.upper()} resolved path functions: {len(reachable)}',
                f'{mode.upper()} retained roots: ' + ', '.join(sorted(roots))]
    if mode == 'ultrags':
        for name in ('ug_minimal_read_status', 'ug_minimal_read_response', 'ug_minimal_write_decoded'):
            assert name in functions, 'missing actual transport callee: ' + name
            assert 'ug_crc32' not in functions[name], 'CRC entered the bus-side hot path'
            summary.append(name + ' direct linked calls: ' + ', '.join(sorted(calls(name))))
        for root in ('ug_minimal_read_status', 'ug_minimal_read_response'):
            seen, todo = set(), [root]
            while todo:
                name = todo.pop()
                if name in seen: continue
                seen.add(name)
                todo.extend(calls(name) - seen)
            assert not any('ug_crc32' in n or 'psram_' in n for n in seen), 'SPI/CRC in STATUS/response closure'
        guard = next(m for m in blocks if m[2] == 'guard_irq')
        assert 0x20000000 <= int(guard[1], 16) < 0x20042000, 'fuse IRQ must run in SRAM'
        summary.append('Core1 fuse IRQ linked in SRAM at 0x' + guard[1] + '.')
    for key, name in ([('iow','iow'),('gus-ior','ior')] if mode=='gus' else [('ultrags-ior','ug_handshake_ior')]):
        symbol = name + '_program_instructions'
        section = f'.rodata._ZL{len(symbol)}{symbol}'
        with tempfile.NamedTemporaryFile() as raw:
            subprocess.run([objcopy, f'--dump-section={section}={raw.name}', str(obj)], check=True)
            raw.seek(0)
            assert raw.read() == b''.join(w.to_bytes(2, 'little') for w in pio[key]), (mode, name)
summary += ['', 'CONFIG is acquired on read prefetch before applying pending IOW work; the write is still applied before reading a selector/catalogue value.',
            'A stale CONFIG capture is rejected before its consuming register handler. Parked read ownership remains immutable across a map update.',
            'CONFIG still requires ARM capture before the host deadline; its additional linked ARM/PIO finite-deadline regression is not a physical timing bound.',
            'Compiled PIO bytes match pioasm output in both target objects; total ULTRAGS PIO0 instruction RAM: '
            + str(len(pio['ultrags-ior'])) + '/32.',
            'STATUS/response have dedicated entry points; CRC is prepared by core1 before REPLY publication.',
            'Static code/call counts are not cycle limits. REAL_PENDING remains in force.', '']
write('REPORT.md', '\n'.join(summary))
(out / 'paths.json').write_text(json.dumps(dict(status='LINKED_ARM_PIO_PASS / REAL_PENDING',
    inputs={str(f): sha(f) for f in sorted(set(inputs))},
    artifacts={str(f): sha(f) for f in artifacts}), indent=2) + '\n')
print('Linked ARM paths and compiled PIO bytes PASS:', out / 'REPORT.md')
