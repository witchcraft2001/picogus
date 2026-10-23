#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Reuse the compiled C/C++ wire consumers and hand-authored Z80 vectors."""
import subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2];out=root/'build/host/docs/protocol';gen=out/'gen'
out.mkdir(parents=True,exist_ok=True)
def run(*args):subprocess.run(list(map(str,args)),cwd=root,check=True)
run('node','tools/ultrags/gen-wire.mjs','tools/ultrags/wire-schema.json',gen)
run('node','tools/ultrags/vec2c.mjs','tests/ultrags/protocol/vectors.json',gen/'vectors-expected.h')
run('cc','-std=c11','-Wall','-Wextra','-Werror','-I'+str(gen),'tests/ultrags/protocol/check-wire.c','-o',out/'check-wire')
run(out/'check-wire')
run('c++','-fsyntax-only','-std=c++17','-Wall','-Wextra','-Werror','-I'+str(gen),'tests/ultrags/protocol/check-wire.cpp')
run('node','tests/ultrags/dss/run-z80-vectors.mjs',root,out)
run('node','tools/ultrags/docs-wire-check.mjs')
