#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Ensure failed/stale/substituted evidence cannot pass the S8a release gate."""
import hashlib,json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2];build=root/'build'
cmd=['node',str(root/'tools/ultrags/package-s8a.mjs'),'--verify-only']
def run():return subprocess.run(cmd,cwd=root,capture_output=True,text=True)
first=run();assert first.returncode==0,first.stderr
current={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in build.glob('CURRENT.*') if p.is_file()}
cases=[('EXE substitution',build/'ultrags/dss/UGTEST.EXE',lambda b:bytes([b[0]^1])+b[1:]),
       ('failed HOST report',build/'host/s8a/host-evidence.json',lambda b:json.dumps(dict(json.loads(b),status='FAIL')).encode()),
       ('missing ARM profiles',build/'evidence/s8a-arm.json',lambda b:json.dumps(dict(json.loads(b),results=[])).encode()),
       ('substituted delivered fixture',build/'s8a-test-audio/EIGHT.MOD',lambda b:b[:-1]+bytes([b[-1]^1])),
       ('missing cancellation coverage',build/'evidence/s8a-exe.json',lambda b:json.dumps(dict(json.loads(b),results=[r for r in json.loads(b)['results'] if r['exit']!=10])).encode()),
       ('failed F00 HOST',build/'host/f00/host-evidence.json',lambda b:json.dumps(dict(json.loads(b),status='FAIL')).encode()),
       ('missing F00 EXE cases',build/'evidence/f00-exe.json',lambda b:json.dumps(dict(json.loads(b),results=[])).encode()),
       ('wrong original tick trace',build/'host/f00/bruno-evidence.json',lambda b:json.dumps(dict(json.loads(b),ticks_compared=0)).encode())]
results=[]
for name,path,change in cases:
 original=path.read_bytes()
 try:
  path.write_bytes(change(original));r=run();assert r.returncode!=0,name+' was accepted';results.append(name);print('PASS rejects',name)
 finally:path.write_bytes(original)
assert current=={p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in current},'release files changed during gate tests'
last=run();assert last.returncode==0,last.stderr
(build/'evidence/s8a-package-negative.json').write_text(json.dumps(dict(status='PASS',cases=results,checker_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),packager_sha256=hashlib.sha256((root/'tools/ultrags/package-s8a.mjs').read_bytes()).hexdigest()),indent=2)+'\n')
