#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Compare the supplied MOD's full transport trace with independent libxmp."""
import argparse,json,subprocess
from pathlib import Path
from s6_inputs import ROOT,digest
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--mod',type=Path,required=True);p.add_argument('--flt8',action='store_true');p.add_argument('--xmp-prefix',type=Path,default=Path('/opt/homebrew'));a=p.parse_args();b=a.build.resolve();b.mkdir(parents=True,exist_ok=True);mod=a.mod.resolve()
prefix='flt8' if a.flt8 else 'multi';song='flt8' if a.flt8 else 'dope'
original=digest(mod);commands=[];inputs=[Path(__file__).resolve(),mod,ROOT/'sw/ultrags/ug_mod.h',ROOT/'common/ultrags_protocol.h',b/'gen/ug_wire.h',a.xmp_prefix/'include/xmp.h',a.xmp_prefix/'lib/libxmp.dylib']
for name,sources,extra in [(prefix+'-trace',['tests/ultrags/unit/f00_trace.c','sw/ultrags/ug_mod.c'],['-I'+str(ROOT/'common'),'-I'+str(ROOT/'sw/ultrags'),'-I'+str(b/'gen')]),(prefix+'-xmp',['tests/ultrags/unit/f00_xmp_trace.c'],['-I'+str(a.xmp_prefix/'include'),'-L'+str(a.xmp_prefix/'lib'),'-lxmp'])]:
 cmd=['cc','-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-fsanitize=undefined','-fno-sanitize-recover=all',*extra,*[str(ROOT/f) for f in sources],'-o',str(b/name)];subprocess.run(cmd,check=True);commands.append(cmd);inputs.extend(ROOT/f for f in sources)
traces={};version=''
for name,args in [(song+'-native',[prefix+'-trace',str(mod),'0']),(song+'-xmp',[prefix+'-xmp',str(mod)])]:
 cmd=[str(b/args[0]),*args[1:]];r=subprocess.run(cmd,check=True,capture_output=True,text=True);commands.append(cmd);(b/(name+'.jsonl')).write_text(r.stdout);traces[name]=[json.loads(s) for s in r.stdout.splitlines()]
 if name==song+'-xmp':version=r.stderr.strip()
u=traces[song+'-native'];x=traces[song+'-xmp'];assert len(u)==len(x)+1 and not u[-1]['playing'] and not u[-1]['paused']
for t,r in zip(u[:-1],x):assert all(t[k]==r[k] for k in ('order','pattern','row','tick','speed','bpm')),(t,r)
assert digest(mod)==original
report=dict(status='HOST_PASS / REAL_PENDING',path=str(mod),original_sha256=original,inputs={str(f):digest(f) for f in inputs},commands=commands,libxmp=version,ticks_compared=len(x),order_row_tick_speed_bpm='EXACT',eof_frames=u[-1]['end_frames'],artifacts={n:digest(b/n) for n in (prefix+'-trace',prefix+'-xmp',song+'-native.jsonl',song+'-xmp.jsonl')})
(b/('flt8-reference.json' if a.flt8 else 'multimod-reference.json')).write_text(json.dumps(report,indent=2)+'\n');print(version);print(len(x),'exact order/row/tick/speed/BPM ticks; original immutable; EOF frames',report['eof_frames'])
