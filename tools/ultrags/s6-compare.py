#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Compare two fresh S6 software deliveries, including indexed audio goldens."""
import argparse, hashlib, json, subprocess, sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--review',type=Path,required=True);a=p.parse_args()
root=Path(__file__).resolve().parents[2];build=a.build.resolve();review=a.review.resolve()
assert build!=review, 'two separate build directories required'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for tree in (build,review):
    subprocess.run(['node',str(root/'tools/ultrags/verify-s6-package.mjs'),'--build',str(tree)],check=True)
    subprocess.run([sys.executable,str(root/'tests/ultrags/unit/test_s6_package.py'),'--build',str(tree)],check=True)
assembly=json.loads((build/'ultrags/dss/asm-manifest.json').read_text())
assert assembly['files']==json.loads((review/'ultrags/dss/asm-manifest.json').read_text())['files']
names=['ultrags/dss/'+x['name'] for x in assembly['files']]
names+=['ultrags/s6-package/'+x for x in ('PGMULTI.UF2','PGULTRA.UF2','PGSLOW.UF2','PGDEBUG.UF2',
    'PGDIAG.UF2','PGDDBG.UF2','PGNODACK.UF2','PGPOST.UF2','PGPMULT.UF2','PGPDIAG.UF2','PGPNOD.UF2','ug-s6.zip','ug-s6.img')]
names+=['host/s6/'+x for x in ('s6-commands.jsonl','s6-audio.s16le','s6-audio-index.jsonl')]
files=[]
for name in names:
    original,fresh=build/name,review/name
    assert original.read_bytes()==fresh.read_bytes(), 'different bytes '+name
    files.append(dict(path=name,size=original.stat().st_size,sha256=sha(original)))
run=json.loads((review/'ultrags/logs/s6-run.json').read_text())
report=dict(status='HOST_PASS / DSS-EXE_PASS / REAL_PENDING',stage='IN_PROGRESS',builds=[str(build),str(review)],identical_artifacts=len(files),files=files,
    exe_s6_cases=len(run['results']),shared_vectors=run['sharedCount'],physical='REAL_PENDING')
(review/'ultrags/logs/s6-comparison.json').write_text(json.dumps(report,indent=2)+'\n')
(review/'REPORT-S6-COMPARISON.txt').write_text('S6 HOST_PASS / DSS-EXE_PASS / REAL_PENDING; IN_PROGRESS\n'+
    f'Two fresh complete s6-package gates: {build} and {review}.\n'+
    f'{len(files)} byte-identical EXE/UF2/ZIP/IMG/shared-vector/audio artifacts.\n'+
    f"{len(run['results'])} S6 actual-EXE cases, {run['sharedCount']} shared C/model records.\n"+
    'Both full 8 MiB ROUNDTRIPs and separate ISA/DI budgets are required by each gate.\n'+
    'Rehashed payload substitutions, missing artifacts and empty provenance rejected.\n'+
    'LRCLK, continuous I2S, render/bus budgets and listening remain REAL_PENDING.\n'+
    '\n'.join(f"{x['sha256']}  {x['path']} ({x['size']} bytes)" for x in files)+'\n')
print(f'S6 comparison PASS: {len(files)} identical artifacts; physical acceptance pending')
