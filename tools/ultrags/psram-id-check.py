#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute actual SPI PIO words against the READ ID edge sequence.

AP Memory APS6404L-SQN rev.4.0 fig.13: MFID bit7 follows the falling
edge of address bit0. The first read clock must sample it, not discard it.
This is an instruction/transaction model, not electrical acceptance.
"""
import argparse
import hashlib
import json
import re
import struct
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
digest = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()


def words(header, name):
    source = header.read_text()
    body = re.search(rf'{name}_program_instructions\[\].*?\{{(.*?)\}};', source, re.S)[1]
    code = [int(n, 16) for n in re.findall(r'0x([0-9a-fA-F]{4})', body)]
    wrap = [int(re.search(rf'#define {name}_{key} (\d+)', source)[1])
            for key in ('wrap_target', 'wrap')]
    return code, wrap


def execute(code, wrap, command, reply, latency=1):
    # Byte DMA writes to a PIO FIFO replicate the byte in all four lanes.
    tx = list(command)
    rx, sent = [], []
    pc = x = y = osr = isr = inc = 0
    outc = 32
    cs, sck, mosi, miso, rises = 1, 0, 0, 0, 0
    active_at = None
    changes = []
    bits = [(b >> n) & 1 for b in reply for n in range(7, -1, -1)]
    for tick in range(10000):
        while changes and changes[0][0] <= tick:
            _, miso = changes.pop(0)
        sampled = miso  # IN samples before the instruction's side-set
        w = code[pc]
        side = (w >> 11) & 3
        next_cs, next_sck = side & 1, side >> 1
        if cs and not next_cs:
            active_at = tick
        if not next_cs:
            if not sck and next_sck:
                rises += 1
                if len(sent) < 32:
                    sent.append(mosi)
            if sck and not next_sck and rises >= 32:
                index = rises - 32
                changes.append((tick + latency, bits[index] if index < len(bits) else 0))
        cs, sck = next_cs, next_sck
        op, dest, count = w >> 13, (w >> 5) & 7, w & 31
        nxt = wrap[0] if pc == wrap[1] else pc + 1
        if op == 3:  # OUT left, AUTOPULL 8
            if outc >= 8:
                if not tx:
                    assert pc == wrap[0] and cs and not sck
                    return bytes(rx), sent, rises, tick - active_at
                osr, outc = tx.pop(0) * 0x01010101, 0
                continue  # OUT stalls for the refill cycle
            count = count or 32
            value = osr >> (32 - count)
            osr = (osr << count) & 0xffffffff
            outc = min(32, outc + count)
            if dest == 0:
                mosi = value
            elif dest == 1:
                x = value
            elif dest == 2:
                y = value
            else:
                raise AssertionError(('OUT destination', dest))
        elif op == 0:  # JMP, including post-decrement conditions
            condition = {0: True, 2: bool(x), 3: not y, 4: bool(y)}[dest]
            if dest == 2:
                x = (x - 1) & 0xffffffff
            if dest == 4:
                y = (y - 1) & 0xffffffff
            if condition:
                nxt = count
        elif op == 2:  # IN left, AUTOPUSH 8; DMA drains each byte
            assert dest == 0 and count == 1
            isr, inc = ((isr << 1) | sampled) & 255, inc + 1
            if inc == 8:
                rx.append(isr)
                isr = inc = 0
        elif op == 5:  # NOP = MOV Y,Y
            assert w & 0xff == 0x42
        else:
            raise AssertionError(('opcode', hex(w)))
        pc = nxt
        if outc >= 8 and tx:  # trailing AUTOPULL on non-OUT instructions
            osr, outc = tx.pop(0) * 0x01010101, 0
    raise AssertionError('PIO did not finish')


def check(build, out):
    assembler = build / 'pioasm-install/pioasm/pioasm'
    sources = [ROOT / 'sw/rp2040-psram/psram_spi.pio', ROOT / 'sw/ultrags/ug_psram_id.pio']
    headers = [build / 'rp2040-psram/psram_spi.pio.h', build / 'ug_psram_id.pio.h']
    with tempfile.TemporaryDirectory() as directory:
        for source, header in zip(sources, headers):
            fresh = Path(directory) / header.name
            subprocess.run([str(assembler), '-o', 'c-sdk', str(source), str(fresh)], check=True)
            assert fresh.read_bytes() == header.read_bytes(), 'stale PIO header: ' + str(header)
    programs = {name: words(header, name) for header, names in
                [(headers[0], ['spi_psram', 'spi_psram_fudge']), (headers[1], ['ug_psram_id'])]
                for name in names}
    assert len(programs['ug_psram_id'][0]) == 9
    adapter = ROOT / 'sw/ultrags/ug_psram.c'
    literal = re.search(r'const uint8_t command\[\]=\{([^}]+)\}', adapter.read_text())[1]
    command = bytes(int(n.strip(), 0) for n in literal.split(','))
    assert command == bytes([32, 24, 0x9f, 0, 0, 0])
    expected = bytes.fromhex('0d5d40a5963ce187')
    old, _, clocks_old, _ = execute(*programs['spi_psram'], bytes([32,64,0x9f,0,0,0]), expected)
    assert old == (int.from_bytes(expected, 'big') << 1 & ((1 << 64) - 1)).to_bytes(8, 'big')
    assert old[:3] == bytes.fromhex('1aba81') and clocks_old == 97
    old_short, _, clocks_short, _ = execute(*programs['spi_psram'], command, expected[:3])
    assert old_short == bytes.fromhex('1aba80') and clocks_short == 57
    checks = 0
    for seed in range(256):
        reply = bytes((seed + i * 37) & 255 for i in range(3))
        # At <=25 MHz SCK each PIO step is >=20 ns. These response
        # delays cover 0..10 ns; a whole extra bit of latency is not a
        # valid slow-SPI assumption (and would hide the old extra clock).
        for latency in (0, 0.25, 0.5):
            actual, sent, clocks, active_steps = execute(*programs['ug_psram_id'], command, reply, latency)
            captured = sum(bit << (31 - i) for i, bit in enumerate(sent)).to_bytes(4, 'big')
            assert actual == reply and captured == command[2:] and clocks == 56 and active_steps <= 125
            checks += 1
    actual, _, _, active_steps = execute(*programs['ug_psram_id'], command, expected[:3])
    assert actual == expected[:3]
    assert execute(*programs['ug_psram_id'], command, expected[:3], 2)[0] != expected[:3]
    # Validate compiled instruction sections too, not just a source/header model.
    cache = (build / 'CMakeCache.txt').read_text()
    compiler = Path(re.search(r'^CMAKE_C_COMPILER:(?:FILEPATH|STRING)=(.+)$', cache, re.M)[1])
    objcopy = compiler.with_name('arm-none-eabi-objcopy')
    obj = build / 'CMakeFiles/pg-ultrags-multifw.dir/ultrags/ug_psram.c.o'
    with tempfile.TemporaryDirectory() as directory:
        for name, (code, _) in programs.items():
            binary = Path(directory) / (name + '.bin')
            subprocess.run([str(objcopy), '-O', 'binary', '-j', '.rodata.' + name + '_program_instructions',
                            str(obj), str(binary)], check=True)
            assert binary.read_bytes() == struct.pack('<' + 'H' * len(code), *code), 'compiled PIO differs: ' + name
    inputs = [*sources, *headers, assembler, adapter, obj, build / 'CMakeCache.txt', Path(__file__)]
    report = dict(status='HOST_PSRAM_ID_INSTRUCTION_PASS / REAL_PENDING', cases=checks,
                  old_id=old.hex(), corrected_id=actual.hex(), old_sck_edges=97, new_sck_edges=56,
                  old_same_length_sck_edges=57, cs_active_steps=active_steps,
                  miso_delay_pio_steps=[0, 0.25, 0.5],
                  pio_words=9, compiled_programs=3,
                  inputs={str(p.resolve()): digest(p) for p in inputs},
                  reference='https://www.apmemory.com/en/downloadFiles/0324112120g3605268 (rev.4.0 fig.13)',
                  limitations='Instruction clocks and digital bit latency only; no electrical or real SRAM/I2S timing proof.')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + '\n')
    print(f'PSRAM READ ID: {checks} generated-word cases; old {old[:3].hex()} -> new {actual[:3].hex()}; 3-byte clocks 57 -> 56; compiled PIO PASS')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    check(args.build.resolve(), args.out)
