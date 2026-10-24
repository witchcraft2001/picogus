#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""S3M production C, original fixtures and pinned independent libxmp oracle."""
import argparse,json,subprocess
from pathlib import Path
from s6_inputs import ROOT,COMMON,digest
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();b=a.build.resolve();b.mkdir(parents=True,exist_ok=True)
report=b/'host-evidence.json';report.unlink(missing_ok=True);commands=[]
def run(cmd,name=None):
    commands.append(cmd);r=subprocess.run(cmd,capture_output=True,text=True)
    if name:(b/(name+'.log')).write_text(r.stdout+r.stderr)
    if r.returncode:print(r.stdout+r.stderr);r.check_returncode()
    return r.stdout
run(['python3',str(ROOT/'tools/ultrags/gen-s3m.py'),str(b/'fixtures')])
run(['node',str(ROOT/'tools/ultrags/gen-wire.mjs'),str(ROOT/'tools/ultrags/wire-schema.json'),str(b/'gen')])
run(['python3',str(ROOT/'tools/ultrags/gen-diag.py'),str(ROOT/'tools/ultrags/diag-schema.json'),str(b/'gen')])
programs={'storage':['tests/ultrags/unit/test_s3m_storage.c',*COMMON],
          'render':['tests/ultrags/unit/test_s3m_render.c','sw/ultrags/ug_render.c'],
          'pitch':['tests/ultrags/unit/test_s3m_pitch.c','sw/ultrags/ug_s3m.c'],
          'trace':['tests/ultrags/unit/s3m_trace.c','sw/ultrags/ug_s3m.c'],
          'xmp-trace':['tests/ultrags/unit/s3m_xmp_trace.c']}
files={ROOT/f for ss in programs.values() for f in ss}
files.update((ROOT/'sw/ultrags').glob('*.[ch]'));files.update((ROOT/'sw/ultrags').glob('*.inc'))
files.update((ROOT/'tests/ultrags/unit').glob('test_s*a_storage.c'));files.add(ROOT/'tests/ultrags/unit/test_s7_storage.c')
files.update([Path(__file__),ROOT/'tools/ultrags/gen-s3m.py',ROOT/'tools/ultrags/s6_inputs.py',ROOT/'tools/ultrags/wire-schema.json',Path('/opt/homebrew/include/xmp.h'),Path('/opt/homebrew/lib/libxmp.dylib')])
files.update((b/'fixtures').glob('*'));before={str(f.resolve()):digest(f) for f in sorted(files)}
for name,sources in programs.items():
    cmd=['cc','-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-pthread','-fsanitize=undefined','-fno-sanitize-recover=all','-DUG_S4_TEST=1','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1',
         *['-I'+str(ROOT/f) for f in ['tests/ultrags/unit/sdk_mock','sw','sw/ultrags','common']],'-I'+str(b/'gen'),*[str(ROOT/f) for f in sources],'-o',str(b/name)]
    if name=='xmp-trace':cmd+=['-I/opt/homebrew/include','-L/opt/homebrew/lib','-lxmp']
    run(cmd,'compile-'+name)
for name in ('render','pitch','storage'):
    out=run([str(b/name),*([str(b/'fixtures'),str(b)] if name=='storage' else [])],name);print(out,end='',flush=True)
comparisons=[]
for f in sorted((b/'fixtures').glob('*.S3M')):
    if f.stem=='LIMITS':continue
    enabled=f.read_bytes()[64:96]
    traces=[]
    for name in ('trace','xmp-trace'):
        text=run([str(b/name),str(f)]);(b/(f.stem+'-'+name+'.txt')).write_text(text)
        traces.append([[int(v) for v in l.split()] for l in text.splitlines()])
    u,x=traces;assert len(u)==len(x),(f,len(u),len(x));max_period_error=0
    for tick,(t,r) in enumerate(zip(u,x)):
        assert t[:5]==r[:5],(f,tick,'transport',t[:5],r[:5])
        for ch in range((len(r)-5)//6):
            if enabled[ch]&128:continue # disabled voices are not rendered
            off=5+6*ch;v,w=t[off:off+4],r[off:off+4]
            # libxmp leaves public channel_info empty until its first voice.
            if not v[1] and not w[1]:continue
            assert v[0]==w[0] and v[2:]==w[2:],(f,tick,ch,v,w)
            if t[off+4] and (not tick or t[off+4]!=u[tick-1][off+4]):
                assert r[off+4]==t[off+5],(f,tick,ch,'retrigger/offset',t[off+4:],r[off+4:])
            if tick and r[off+4]==0 and x[tick-1][off+4]>0:
                assert t[off+4]!=u[tick-1][off+4],(f,tick,ch,'missing retrigger')
            error=abs(v[1]-w[1]);max_period_error=max(max_period_error,error/max(1,w[1]))
            # ST3's documented integer period table vs libxmp's floating pitch.
            assert error<=max(256,w[1]*0.003),(f,tick,ch,v,w)
    comparisons.append(dict(fixture=f.name,ticks=len(x),transport_note_volume_pan='EXACT',max_relative_period_error=max_period_error))
print('libxmp 4.7.0:',len(comparisons),'fixtures,',sum(c['ticks'] for c in comparisons),'ticks PASS',flush=True)
assert before=={str(f.resolve()):digest(f) for f in sorted(files)},'inputs changed during test'
report.write_text(json.dumps(dict(status='HOST_PASS / REAL_PENDING',inputs=before,commands=commands,reference='libxmp 4.7.0',comparisons=comparisons,
    artifacts={str(f.relative_to(b)):digest(f) for f in b.iterdir() if f.is_file() and (f.name.endswith(('-trace.txt','-xmp-trace.txt','.s16le')) or f.name in ('storage','render','pitch','trace','xmp-trace'))},limits=['Physical timing/underruns not measured','ST3 integer periods compared to libxmp within 0.3%, minimum one ST3 period unit','Extreme C2SPD/note combinations checked analytically; libxmp transposition limits differ']),indent=2)+'\n')
