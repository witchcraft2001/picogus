#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Measure ARM static stack frames using the production target's compiler flags."""
import argparse, hashlib, json, re, shlex, subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();a.build=a.build.resolve()
root=Path(__file__).resolve().parents[2];fw=a.build/'multifw-release' if (a.build/'multifw-release').is_dir() else a.build/'ultrags-release';out=a.build/'s7-stack';out.mkdir(exist_ok=True)
flags=fw/('CMakeFiles/pg-ultrags-multifw.dir/flags.make' if fw.name=='multifw-release' else 'CMakeFiles/pg-ultrags.dir/flags.make')
f={m.group(1):shlex.split(m.group(2)) for line in flags.read_text().splitlines() if (m:=re.match(r'(C_\w+) = (.*)',line))}
compiler=re.search(r'^CMAKE_C_COMPILER:[^=\n]+=(.*)$',(fw/'CMakeCache.txt').read_text(),re.M)[1]
sources=[root/('sw/ultrags/'+n+'.c') for n in ('ug_mod','ug_storage','ug_minimal','ug_psram','ug_render')]
frames={}
for src in sources:
    subprocess.run([compiler,*f['C_DEFINES'],*f['C_INCLUDES'],*f['C_FLAGS'],'-fstack-usage','-c',str(src),'-o',str(out/(src.stem+'.o'))],check=True)
    for line in (out/(src.stem+'.su')).read_text().splitlines():
        name,usage,kind=line.rsplit('\t',2);frames[name.split(':')[-1]]=int(usage)
# Conservative parser path plus reserve for SDK/PIO callbacks, exception frame
# and unprofiled callers. This is a static guard, not a physical stack watermark.
chain=('ug_minimal_dispatch','ug_storage_command','ug_mod_parse','mod_object_read','ug_psram_read')
assert all(n in frames for n in chain), 'required stack frame missing'
subtotal=sum(frames[n] for n in chain);reserve=768
assert frames['ug_mod_parse']<=384, 'MOD parser stack regression'
assert subtotal+reserve<=2048, 'MOD parser path exceeds core1 stack reserve'
render_chain=('ug_storage_render','ug_mixer_render','render_voice_samples','ug_fetch_byte','audio_mem_read','ug_psram_read')
render_frames={n:max((v for k,v in frames.items() if k==n or k.startswith(n+'.')),default=0) for n in render_chain}
assert all(render_frames[n] for n in ('ug_storage_render','ug_mixer_render','render_voice_samples'))
render_total=sum(render_frames.values())+reserve
assert render_total<=2048,'renderer path exceeds core1 stack reserve'
h=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
result={'status':'PASS','scope':'static ARM parser call-path guard; REAL stack watermark remains pending',
 'render_frames':render_frames,'render_with_reserve':render_total,'frames':{n:frames[n] for n in chain},'subtotal':subtotal,'unprofiled_and_irq_reserve':reserve,'core1_stack':2048,
 'inputs':{str(x):h(x) for x in [*sources,*(root/'sw/ultrags').glob('*.h'),*(root/'sw/ultrags').glob('*.inc'),Path(__file__).resolve(),flags]}}
(a.build/'s7-stack.json').write_text(json.dumps(result,indent=2)+'\n');print('S7 ARM static stack PASS:',result['frames'],'+',reserve,'reserve =',subtotal+reserve,'/2048')
