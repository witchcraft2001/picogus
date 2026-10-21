#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Trace the original immutable MOD against installed libxmp, tick for tick."""
import argparse,json,subprocess
from pathlib import Path
from s6_inputs import ROOT,digest
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--mod',type=Path,required=True);p.add_argument('--xmp-prefix',type=Path,default=Path('/opt/homebrew'));a=p.parse_args();b=a.build.resolve();b.mkdir(parents=True,exist_ok=True);mod=a.mod.resolve()
expected='024f4b4a2c4ab31524243dfaa389b7dd38b3af4d2cdd37d6cbf6efab03d70a8a';assert digest(mod)==expected
commands=[]
for name,sources,extra in [('trace',['tests/ultrags/unit/f00_trace.c','sw/ultrags/ug_mod.c'],['-I'+str(ROOT/'common'),'-I'+str(ROOT/'sw/ultrags'),'-I'+str(b/'gen')]),('xmp-trace',['tests/ultrags/unit/f00_xmp_trace.c'],['-I'+str(a.xmp_prefix/'include'),'-L'+str(a.xmp_prefix/'lib'),'-lxmp'])]:
 cmd=['cc','-std=c11','-O2','-Wall','-Wextra','-Werror',*extra,*[str(ROOT/f) for f in sources],'-o',str(b/name)];subprocess.run(cmd,check=True);commands.append(cmd)
traces={};xmp_version=''
for name,args in [('bruno-ignore',['trace',str(mod),'2']),('bruno-pause',['trace',str(mod),'4']),('bruno-xmp',['xmp-trace',str(mod)])]:
 cmd=[str(b/args[0]),*args[1:]];r=subprocess.run(cmd,check=True,capture_output=True,text=True);commands.append(cmd);(b/(name+'.jsonl')).write_text(r.stdout);traces[name]=[json.loads(s) for s in r.stdout.splitlines()]
 if name=='bruno-xmp':xmp_version=r.stderr.strip()
u=traces['bruno-ignore'];x=traces['bruno-xmp'];pause=traces['bruno-pause'];assert len(u)==len(x)+1==7558
assert u[-1]==dict(end_frames=7254720,playing=0,paused=0)
assert pause[-1]==dict(end_frames=913920,playing=1,paused=1)
assert (pause[-2]['order'],pause[-2]['pattern'],pause[-2]['row'],pause[-2]['tick'])==(4,3,55,0)
for t,r in zip(u[:-1],x):
 assert all(t[k]==r[k] for k in ('order','pattern','row','tick','speed','bpm')),(t,r)
 # libxmp reports the end of the tick; our trace reports the beginning.
 assert abs(t['frames']/48-(r['time_ms']-r['frame_us']/1000))<0.001,(t,r)
assert 'Noisetracker' in xmp_version;assert digest(mod)==expected
inputs=[Path(__file__).resolve(),mod,ROOT/'tests/ultrags/unit/f00_trace.c',ROOT/'tests/ultrags/unit/f00_xmp_trace.c',ROOT/'sw/ultrags/ug_mod.c',ROOT/'sw/ultrags/ug_mod.h',ROOT/'common/ultrags_protocol.h',b/'gen/ug_wire.h',a.xmp_prefix/'include/xmp.h',a.xmp_prefix/'lib/libxmp.dylib']
report=dict(status='HOST_PASS / REAL_PENDING',original_sha256=expected,inputs={str(f):digest(f) for f in inputs},commands=commands,libxmp=xmp_version,ticks_compared=len(x),order_row_tick_speed_bpm='EXACT',time_basis='UG tick start == libxmp time_ms - frame_us/1000',ignore_eof_seconds=151.14,pause_seconds=19.04,pause=dict(order=4,pattern=3,row=55),artifacts={n:digest(b/n) for n in ('trace','xmp-trace','bruno-ignore.jsonl','bruno-pause.jsonl','bruno-xmp.jsonl')})
(b/'bruno-evidence.json').write_text(json.dumps(report,indent=2)+'\n');print(xmp_version);print('7557 exact ticks; IGNORE EOF151.14s; PAUSE19.04s order4/pattern3/row55; immutable original PASS')
