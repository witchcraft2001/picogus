#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute the pioasm words used by GUS and ULTRAGS, with a delayed ARM peer.

Instruction-clock evidence only: not an electrical model of the Sprinter,
IOCHRDY setup, GPIO synchronizers, or real I2S/PSRAM SRAM arbitration.
"""
import argparse
import hashlib
import json
import re
import zlib
from pathlib import Path


def program(header, name):
    text = Path(header).read_text()
    body = re.search(rf'{name}_program_instructions\[\]\s*=\s*\{{(.*?)\}};', text, re.S)[1]
    words = [int(w, 16) for w in re.findall(r'0x([0-9a-fA-F]{4})', body)]
    labels = {key: int(value) for key, value in re.findall(rf'#define {name}_offset_(\w+) (\d+)', text)}
    wrap = [int(re.search(rf'#define {name}_{key} (\d+)', text)[1]) for key in ('wrap_target', 'wrap')]
    return words, labels, wrap


class SM:
    def __init__(self, words, wrap, *, early=False, write=False):
        self.words, self.wrap = list(words), wrap
        self.early, self.write = early, write
        self.pc = self.x = self.y = self.isr = self.osr = self.inc = 0
        self.outc = 32
        self.tx, self.rx = [], []
        self.ior = self.iow = self.dack = 1
        self.port = self.data = self.ads = self.hold = self.dirs = self.value = self.irq = 0
        self.delay = 0
        self.held = False
        self.side_write = None

    def pins(self):
        bus = self.data if self.ads else self.port
        pins = (bus << 6) | (self.ior << 5) | (self.iow << 4) | (self.dack << 19)
        base = 11 if self.early else 6
        return ((pins >> base) | (pins << (32 - base))) & 0xffffffff

    def step(self):
        self.side_write = None
        if self.delay:
            self.delay -= 1
            return
        w = self.words[self.pc]
        pins = self.pins()  # sampled inputs precede this instruction's mux change
        if w & 0x1000:
            self.side_write = (w >> 10) & 3
            self.hold, self.ads = (w >> 10) & 1, (w >> 11) & 1
            self.held |= bool(self.hold)
        op, arg, dest = w >> 13, w & 31, (w >> 5) & 7
        nxt = self.wrap[0] if self.pc == self.wrap[1] else self.pc + 1
        if op == 0:  # JMP
            conditions = [True, not self.x, bool(self.x), not self.y, bool(self.y), self.x != self.y,
                          bool(self.dack), self.outc < 24]
            if dest == 2: self.x = (self.x - 1) & 0xffffffff
            if dest == 4: self.y = (self.y - 1) & 0xffffffff
            if conditions[dest]: nxt = arg
        elif op == 1:  # WAIT GPIO
            assert (w >> 5) & 3 == 0
            pin = {4: self.iow, 5: self.ior}[arg]
            if pin != ((w >> 7) & 1): return
        elif op == 2:  # IN PINS, left shift, baseline autopush
            assert dest == 0
            count = arg or 32
            self.isr = ((self.isr << count) | (pins & ((1 << count) - 1))) & 0xffffffff
            self.inc += count
            if not self.early and self.inc >= (18 if self.write else 10):
                assert len(self.rx) < 4
                self.rx.append(self.isr)
                self.isr = self.inc = 0
        elif op == 3:  # OUT, right shift with autopull
            if self.outc >= (32 if self.write else 24):
                if not self.tx: return
                self.osr, self.outc = self.tx.pop(0), 0
                return  # RP2040 3.5.4.2: OUT stalls on the refill cycle
            count = arg or 32
            value = self.osr & ((1 << count) - 1)
            self.osr >>= count
            self.outc = min(32, self.outc + count)
            if dest == 0: self.value = value
            elif dest == 1: self.x = value
            elif dest == 4: self.dirs = value
            else: assert dest == 3
        elif op == 4:  # PUSH / PULL
            assert not w & 0x40 and w & 0x20
            if w & 0x80:
                # With AUTOPULL, PULL is a barrier when OSR is not empty.
                if self.outc >= (32 if self.write else 24):
                    if not self.tx: return
                    self.osr, self.outc = self.tx.pop(0), 0
            else:
                if len(self.rx) == 4: return
                self.rx.append(self.isr)
                self.isr = self.inc = 0
        elif op == 5:  # MOV, including NOP MOV Y,Y
            source, transform = w & 7, (w >> 3) & 3
            assert transform in (0, 1)
            value = {0: pins, 1: self.x, 2: self.y, 3: 0, 6: self.isr, 7: self.osr}[source]
            if transform == 1: value ^= 0xffffffff
            if dest == 1: self.x = value
            elif dest == 2: self.y = value
            elif dest == 6: self.isr, self.inc = value, 0
            elif dest == 7: self.osr, self.outc = value, 0
            else: raise AssertionError(('MOV', dest))
        elif op == 6:
            assert w & 0xff == 0
            self.irq = 1
        elif op == 7:
            assert dest == 2
            self.y = arg
        else: raise AssertionError(w)
        # AUTOPULL can also refill between OUTs, including the final OUT's
        # trailing phase; MOV OSR/PULL have already reset the counter above.
        if self.outc >= (32 if self.write else 24) and self.tx:
            self.osr, self.outc = self.tx.pop(0), 0
        self.pc, self.delay = nxt, (w >> 8) & 3


def native(words, labels, wrap, base, alias):
    sm = SM(words, wrap, early=True)
    sm.words[labels['base_compare']] = 0xe040 | (base >> 5)
    sm.words[labels['alias_compare']] = 0xe040 | ((base if alias == 0xffff else alias) >> 5)
    return sm


def read(sm, port, value, delay, *, sample=24):
    sm.port, sm.ior, sm.held = port, 1, False
    for _ in range(4): sm.step()
    assert not sm.dirs and not sm.hold
    sm.ior = 0
    received = None
    consumed = 0
    response_at = None
    sampled = None
    for tick in range(delay + 128):
        sm.step()
        if sm.rx and received is None:
            received = sm.rx.pop(0)
            response_at = tick + delay
        if response_at == tick:
            sm.tx.extend([0xffffffff, 0xff00 | value])
            consumed += 1
        if tick >= sample and sampled is None and not sm.hold:
            sampled = sm.value if sm.dirs == 255 and sm.ads else 255
            sm.ior = 1
    assert received is not None and consumed == 1
    assert not sm.hold and not sm.dirs and not sm.ads
    assert not sm.tx and not sm.rx
    if sm.early:
        assert received & (1 << 26)
        received ^= 0xffffffff
        decoded = ((received >> 27) & 31) | ((received & 31) << 5)
        assert decoded == port
    else: assert received == port
    return sampled


def coupled(iow, iow_wrap, words, labels, wrap, *, mutate=False, writer_period=1, writer_phase=0):
    """SM1 must retain IOCHRDY while an earlier SM0 write completes."""
    writer = SM(iow, iow_wrap, write=True)
    writer.pc, writer.port, writer.data, writer.dack = 1, 0x2a3, 0x80, 0
    writer.iow = 0
    for _ in range(40): writer.step()
    assert writer.rx == [(0x2a3 << 8) | 0x80]
    writer.iow = 1
    reader = native(words, labels, wrap, 0x2a0, 0xffff)
    if mutate: reader.words[labels['owned_condition']] &= ~0x1000
    reader.pc, reader.port, reader.ior = 1, 0x2a3, 0
    hold = ads = 0
    seen = released_early = False
    sampled = None
    for tick in range(256):
        for sm in (writer, reader): sm.hold, sm.ads = hold, ads
        writer.side_write = None
        if (tick + writer_phase) % writer_period == 0: writer.step()
        reader.step()
        side = reader.side_write if reader.side_write is not None else writer.side_write
        if side is not None: hold, ads = side & 1, side >> 1
        if tick == 20: writer.tx = [0xffffffff]
        if tick == 40: writer.tx.append(0)
        if tick == 80: reader.tx.append(0xffffffff)
        if tick == 100: reader.tx.append(0xff24)
        if hold: seen = True
        if seen and not hold and sampled is None:
            if reader.dirs != 255 or not ads: released_early = True
            else: sampled = reader.value
            reader.ior = 1
    return not released_early and sampled == 36 and not hold and not ads and not reader.dirs


def check(build, out):
    old_header, new_header = build / 'isa_io.pio.h', build / 'ug_handshake_ior.pio.h'
    old, _, old_wrap = program(old_header, 'ior')
    iow, _, iow_wrap = program(old_header, 'iow')
    new, labels, wrap = program(new_header, 'ug_handshake_ior')
    assert len(new) + len(iow) <= 32
    maps = ports = 0
    # Independent ISA-rule vector: a PULL must not replace a partially full
    # OSR under AUTOPULL. This caught the former address-in-OSR draft.
    barrier = SM([0x80a0], (0, 0))
    barrier.osr, barrier.outc, barrier.tx = 0x123, 5, [0xffffffff]
    barrier.step()
    assert (barrier.osr, barrier.outc, barrier.tx) == (0x123, 5, [0xffffffff])
    for base in range(0x200, 0x400, 32):
        for alias in [0xffff, *range(0x200, 0x400, 32)]:
            if alias == base: continue
            maps += 1
            sm = native(new, labels, wrap, base, alias)
            for port in range(1024):
                sm.pc = sm.x = sm.y = sm.isr = sm.inc = sm.hold = sm.ads = 0
                sm.outc = 32
                sm.port, sm.ior = port, 0
                sm.pc = 1
                for _ in range(16):
                    if sm.pc in (labels['submit'], labels['owned_submit']): break
                    sm.step()
                expected = port // 32 in (base // 32, alias // 32)
                assert sm.pc == labels['owned_submit' if expected else 'submit']
                assert bool(sm.hold) == expected, (base, alias, port)
                assert bool(sm.isr & (1 << 26)) == expected
                assert not sm.dirs and not sm.ads
                ports += 1
    # The previous PIO samples FF under the same finite ARM delay despite
    # receiving/consuming every reply. The early PIO receives all INFO bytes.
    frame = bytes([0, 36]) + b'UGS1' + bytes(range(32))
    frame += zlib.crc32(frame).to_bytes(4, 'little')
    old_sm = SM(old, old_wrap)
    lost = bytes(read(old_sm, 0x2a3, value, 64) for value in frame)
    assert lost == bytes([255]) * len(frame)
    # Reject missing early assertion and an unconditional release on the
    # condition JMP (side-set executes even when that branch is not taken).
    for mutation in ('no-early-wait', 'premature-release'):
        sm = native(new, labels, wrap, 0x2a0, 0xffff)
        if mutation == 'no-early-wait':
            for pc in (labels['owned'], labels['owned_submit'], labels['owned_condition'], labels['owned_condition'] + 1):
                sm.words[pc] &= ~0x1000
        else:
            sm.words[labels['owned_condition'] + 1] = 0x1000 | labels['value']
        assert read(sm, 0x2a3, 36, 64) != 36, mutation
    for period in (1, 2, 3):
        for phase in range(period):
            assert coupled(iow, iow_wrap, new, labels, wrap, writer_period=period, writer_phase=phase)
    assert not coupled(iow, iow_wrap, new, labels, wrap, mutate=True), 'IOW/IOR arbitration mutation survived'
    for base in range(0x200, 0x400, 32):
        for delay in (0, 1, 8, 64, 1024, 10000):
            sm = native(new, labels, wrap, base, 0xffff)
            observed = bytes(read(sm, base + 3, value, delay) for value in frame)
            assert observed == frame and zlib.crc32(observed[:-4]) == int.from_bytes(observed[-4:], 'little'), (hex(base), delay, observed.hex(), frame.hex())
    # A stopped ARM with a full RX FIFO must still get early IOCHRDY.
    sm = native(new, labels, wrap, 0x2a0, 0x280)
    sm.rx = [0] * 4
    sm.port, sm.ior, sm.pc = 0x283, 0, 1
    for _ in range(64): sm.step()
    assert sm.hold and sm.pc == labels['owned_submit'] and not sm.dirs and not sm.ads
    # Original IOW opcodes retain DACK gating, ADS/data capture and slow ack.
    for dack in (0, 1):
        sm = SM(iow, iow_wrap, write=True)
        sm.port, sm.data, sm.dack = 0x2a3, 0xa5, dack
        for _ in range(2): sm.step()
        sm.iow = 0
        for _ in range(40): sm.step()
        if dack:
            assert not sm.rx and not sm.hold
        else:
            assert sm.rx == [(0x2a3 << 8) | 0xa5]
            sm.tx = [0xffffffff]
            for _ in range(8): sm.step()
            assert sm.hold and not sm.ads
            sm.tx = [0]
            for _ in range(8): sm.step()
            assert not sm.hold and not sm.ads and not sm.dirs
    report = dict(status='HOST_PIO_INSTRUCTION_PASS / REAL_PENDING', maps=maps, addresses=ports,
                  pio0_words=len(iow) + len(new), delayed_info_frames=16 * 6,
                  same_delay_old_sample='FF', same_delay_new_crc='PASS',
                  autopull_barrier='PASS', simultaneous_iow_ior='PASS', write_clock_phases=6,
                  inputs={str(p.resolve()): hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in [old_header, new_header, Path(__file__)]},
                  limitations='Instruction semantics and finite ARM hiatus; no electrical or real SRAM/I2S/PSRAM timing proof.')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + '\n')
    print(f'Generated PIO: {maps} maps / {ports} addresses; INFO CRC; AUTOPULL; shared IOW/IOR (6 clock phases); full RX; DACK/ADS PASS ({report["pio0_words"]}/32 words)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    check(args.build.resolve(), args.out)
