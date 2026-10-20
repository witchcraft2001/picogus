#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Generated R7/candidate classifier words with independently controlled WAIT input.

The fault injection is intentional: it isolates the invalid assumption that a
shared output's input feedback identifies which SM/address owns a transaction.
It does not claim to measure the clone's pad delay or reproduce its electronics.
"""
import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--build', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
a = p.parse_args()
r = Path(__file__).resolve().parents[2]
b, out = a.build.resolve(), a.out.resolve()
out.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('pio', r/'tools/ultrags/pio-isa-check.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
ref = r/'tests/ultrags/reference/handshake-r7.pio'
old_header = out/'r7.pio.h'
subprocess.run([str(b/'pioasm-install/pioasm/pioasm'), '-o', 'c-sdk', '-v', '0',
                str(ref), str(old_header)], check=True)
new_header = b/'ug_handshake_ior.pio.h'
old = m.program(old_header, 'ug_handshake_ior')
new = m.program(new_header, 'ug_handshake_ior')
assert len(old[0]) == len(new[0]) == 32
assert 'owned' not in old[1] and 'owned' in new[1]
cases = false_negative = false_positive = 0
minimum_settle = 1000
for base, alias in ((0x200, 0xffff), (0x2a0, 0xffff), (0x3e0, 0x280)):
    for gs in (False, True):
        for write in (False, True):
            for feedback in (0, 1):
                for port in range(1024):
                    expected = port//32 in (base//32, alias//32) or (gs and port in (0xb3, 0xbb))
                    for program, candidate in ((old, False), (new, True)):
                        words, labels, wrap = program
                        sm = m.native(words, labels, wrap, base, alias, gs=gs, write=write)
                        sm.feedback_pin = feedback
                        sm.port, sm.data, sm.dack = port, (port*73)&255, 0
                        sm.mux_delay = 16
                        # Opposite strobe remains HIGH, as on a normal ISA cycle.
                        sm.step()
                        if write: sm.iow = 0
                        else: sm.ior = 0
                        ads_at = data_at = None
                        for tick in range(100):
                            was_ads = sm.ads
                            sm.step()
                            if sm.ads and not was_ads: ads_at = tick
                            if len(sm.rx) == 2 and data_at is None: data_at = tick
                            if sm.pc == labels['parked']: break
                        assert len(sm.rx) == (2 if write else 1)
                        assert m.address(sm, sm.rx[0]) == port
                        tag = m.tag(sm, sm.rx[0] if candidate or not write else sm.rx[1])
                        assert bool(sm.hold) == expected
                        if candidate:
                            assert tag == expected, (port, write, feedback, tag, expected)
                            if write and (expected or 0x1d0 <= port <= 0x1d2):
                                assert m.data_byte(sm, sm.rx[1]) == sm.data
                                assert data_at-ads_at >= 16
                                minimum_settle = min(minimum_settle, data_at-ads_at)
                        else:
                            false_negative += expected and not tag
                            false_positive += not expected and tag
                    cases += 1
assert false_negative and false_positive and minimum_settle == 16
paths = [Path(__file__), r/'tools/ultrags/pio-isa-check.py', ref, old_header, new_header,
         r/'sw/ultrags/ug_handshake_ior.pio', r/'sw/ultrags/ug_handshake.h']
report = dict(status='OWNERSHIP_TAG_PASS / REAL_PENDING', cases=cases,
              r7_false_negative=false_negative, r7_false_positive=false_positive,
              candidate_mismatches=0, serviced_write_minimum_settle_clocks=minimum_settle,
              limits='Controlled GPIO26 input faults, not measured electrical timing or hardware acceptance.',
              inputs={str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in paths})
(out/'ownership.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps({k: v for k, v in report.items() if k != 'inputs'}, indent=2))
