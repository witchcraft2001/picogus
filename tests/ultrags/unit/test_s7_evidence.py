#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Passing evidence must reject stale headers, missing cases and substituted EXEs."""
import argparse, json, subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args()
root=Path(__file__).resolve().parents[3]
cmd=['node',str(root/'tools/ultrags/s7-report.mjs'),'--build',str(a.build),'--verify-only']
subprocess.run(cmd,check=True)
host=a.build/'host/s7/s7-host-evidence.json';dss=a.build/'s7-dss-evidence.json'
cases=[(host,lambda d:d['inputs'].pop(str(root/'sw/ultrags/ug_mod.h'))),
       (host,lambda d:d['artifacts'].__setitem__('s7-storage','0'*64)),
       (dss,lambda d:d['inputs'].pop('tests/ultrags/dss/run-s7.mjs')),
       (dss,lambda d:d.__setitem__('results',[x for x in d['results'] if not x['name'].startswith('STOP context ')])),
       (dss,lambda d:d['executed'][0].__setitem__('sha256','0'*64)),
       (dss,lambda d:d.__setitem__('sharedSha256','0'*64)),
       (dss,lambda d:d.__setitem__('stage_status','HOST_PASS'))]
for path,change in cases:
    original=path.read_bytes()
    try:
        data=json.loads(original);change(data);path.write_text(json.dumps(data))
        result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        assert result.returncode,'tampered S7 evidence was accepted'
    finally:path.write_bytes(original)
print(f'S7 evidence: {len(cases)} stale/tamper cases rejected PASS')
