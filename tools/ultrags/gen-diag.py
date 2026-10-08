#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Generate private standalone diagnostic constants in build/ only."""
import json, pathlib, sys
schema = json.loads(pathlib.Path(sys.argv[1]).read_text())
out = pathlib.Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
items = schema['constants'].items()
header = '/* SPDX-License-Identifier: GPL-2.0-or-later; generated */\n#pragma once\n'
inc = '; SPDX-License-Identifier: GPL-2.0-or-later; generated\n'
for key, value in items:
    header += f'#define {key} {value}u\n'
    inc += f'{key}\tEQU {value}\n'
(out / 'ug_diag_wire.h').write_text(header)
(out / 'ug_diag_wire.inc').write_text(inc)
