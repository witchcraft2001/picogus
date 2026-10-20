#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Fail closed on stale linked ARM/PIO, fuse, SRAM or stack evidence."""
import argparse, json
from pathlib import Path
from cfg_evidence import verify_multifw, verify_isa_reports, digest

p = argparse.ArgumentParser()
p.add_argument('--build', type=Path, required=True)
a = p.parse_args()
b = a.build.resolve()
flags = (b / 'multifw-release/CMakeFiles/pg-ultrags-multifw.dir/flags.make').read_text()
for define in ('-DUG_LANES=32 ', '-DUG_ISA_EARLY_READ=1 ', '-DUG_PSRAM_SCK_MHZ=100 '):
    assert define in flags, 'wrong production profile: ' + define
assert '-DUG_ISA_POSTED' not in flags and '-DPGDEBUG' not in flags
verify_multifw(b / 'multifw-release')
verify_isa_reports(b)
for name, status in [('host/budgets/budgets.json', 'LINKED_BUDGETS_PASS / REAL_PENDING'),
                     ('s7-stack.json', 'PASS')]:
    e = json.loads((b / name).read_text())
    assert e['status'] == status
    for source, sha in e['inputs'].items():
        assert digest(source) == sha, 'stale linked budget evidence: ' + source
budget = json.loads((b / 'host/budgets/budgets.json').read_text())
assert len(budget['legacy_images']) == budget['legacy_code_mutations_rejected'] == 6
assert budget['sram']['pg-ultrags']['free_main'] >= 16384
assert budget['settings']['sizeof_settings'] == 156 and budget['settings']['settings_version'] == 6
assert budget['settings']['off_ug_tail'] == 152
stack = json.loads((b / 's7-stack.json').read_text())
assert stack['subtotal'] + stack['unprofiled_and_irq_reserve'] <= 2048
assert stack['render_with_reserve'] <= 2048
print('VLS1 linked firmware/PIO/fuse/Settings/stack evidence PASS / REAL_PENDING')
