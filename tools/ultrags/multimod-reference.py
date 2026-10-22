#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Compare the supplied MOD's full transport trace with independent libxmp."""
import argparse,json,subprocess
from pathlib import Path
from s6_inputs import ROOT,digest
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--mod',type=Path,required=True);p.add_argument('--xmp-prefix',type=Path,default=Path('/opt/homebrew'));a=p.parse_args();b=a.build.resolve();b.mkdir(parents=True,exist_ok=True);mod=a.mod.resolve()
original=digest(mod);commands=[];inputs=[Path(__file__).resolve(),mod,ROOT/'sw/ultrags/ug_mod.h',ROOT/'common/ultrags_protocol.h',b/'gen/ug_wire.h',a.xmp_prefix/'include/xmp.h',a.xmp_prefix/'lib/libxmp.dylib']
for name,sources,extra in [('multi-trace',['tests/ultrags/unit/f00_trace.c','sw/ultrags/ug_mod.c'],['-I'+str(ROOT/'common'),'-I'+str(ROOT/'sw/ultrags'),'-I'+str(b/'gen')]),('multi-xmp',['tests/ultrags/unit/f00_xmp_trace.c'],['-I'+str(a.xmp_prefix/'include'),'-L'+str(a.xmp_prefix/'lib'),'-lxmp'])]:
 cmd=['cc','-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-fsanitize=undefined','-fno-sanitize-recover=all',*extra,*[str(ROOT/f) for f in sources],'-o',str(b/name)];subprocess.run(cmd,check=True);commands.append(cmd);inputs.extend(ROOT/f for f in sources)
traces={};version=''
for name,args in [('dope-native',['multi-trace',str(mod),'0']),('dope-xmp',['multi-xmp',str(mod)])]:
 cmd=[str(b/args[0]),*args[1:]];r=subprocess.run(cmd,check=True,capture_output=True,text=True);commands.append(cmd);(b/(name+'.jsonl')).write_text(r.stdout);traces[name]=[json.loads(s) for s in r.stdout.splitlines()]
 if name=='dope-xmp':version=r.stderr.strip()
u=traces['dope-native'];x=traces['dope-xmp'];assert len(u)==len(x)+1 and not u[-1]['playing'] and not u[-1]['paused']
for t,r in zip(u[:-1],x):assert all(t[k]==r[k] for k in ('order','pattern','row','tick','speed','bpm')),(t,r)
assert digest(mod)==original
report=dict(status='HOST_PASS / REAL_PENDING',original_sha256=original,inputs={str(f):digest(f) for f in inputs},commands=commands,libxmp=version,ticks_compared=len(x),order_row_tick_speed_bpm='EXACT',eof_frames=u[-1]['end_frames'],artifacts={n:digest(b/n) for n in ('multi-trace','multi-xmp','dope-native.jsonl','dope-xmp.jsonl')})
(b/'multimod-reference.json').write_text(json.dumps(report,indent=2)+'\n');print(version);print(len(x),'exact order/row/tick/speed/BPM ticks; original immutable; EOF frames',report['eof_frames'])
