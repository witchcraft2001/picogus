#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Run the linked-ARM gates using one selected Python/Unicorn environment."""
import argparse, os, re, subprocess, sys
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--build', type=Path, required=True)
p.add_argument('--audio', choices=('none', 'stream', 'all'), default='none')
a = p.parse_args(); b = a.build.resolve()
root = Path(__file__).resolve().parents[2]
cache = (b/'multifw-release/CMakeCache.txt').read_text()
nm = re.search(r'^CMAKE_NM:[^=]+=(.*)$', cache, re.M)[1]
env = dict(os.environ, PATH=str(Path(nm).parent)+os.pathsep+os.environ['PATH'])
steps = [('config-read-arm.py', ['--nm', nm]), ('gs-turbo-linked.py', []), ('gs-config-entry-arm.py', [])]
if a.audio == 'all': steps.append(('s8a-arm.py', []))
if a.audio != 'none': steps.append(('s8c-arm.py', []))
for script, args in steps:
    print('RUN', script, b, flush=True)
    subprocess.run([sys.executable, str(root/'tools/ultrags'/script), '--build', str(b), *args],
                   cwd=root, env=env, check=True)
