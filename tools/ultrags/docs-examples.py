#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Build guide entry units and original, deterministic audio fixtures."""
import argparse, hashlib, json, subprocess, wave
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,default=ROOT/'build');a=p.parse_args();build=a.build.resolve()
out = build/'host/docs/examples'
out.mkdir(parents=True, exist_ok=True)
inc = [ROOT/'host/sprinter/ultrags'/x for x in ('apps','include','lib')]
inc.append(build/'ultrags/gen')
# Remove only obsolete long DOS names emitted by the first guide draft.
for n in ('DISCOVER0','DISCOVER1'):
    for ext in ('.EXE','.lst'):(out/(n+ext)).unlink(missing_ok=True)
files = {}
for src in sorted((ROOT/'host/sprinter/ultrags/examples').glob('*.asm')):
    for slot in ([0,1] if src.stem in ('discover','firstpcm','s3m','gss3m') else [None]):
        name = ({'discover':'DISCOV','firstpcm':'PCM'}.get(src.stem,src.stem.upper()))+(str(slot) if slot is not None else '')
        target = out/(name+'.EXE')
        subprocess.run(['sjasmplus', *['--inc='+str(d) for d in inc],
                        *(['-DDOC_SLOT='+str(slot)] if slot is not None else []),
                        '--raw='+str(target),'--lst='+str(out/(name+'.lst')),str(src)],check=True,
                       stdout=subprocess.DEVNULL)
        files[target.name] = hashlib.sha256(target.read_bytes()).hexdigest()
# A quiet, integer triangle, generated here, no third-party music.
with wave.open(str(out/'GUIDE.WAV'),'wb') as w:
    w.setnchannels(1); w.setsampwidth(1); w.setframerate(8000)
    w.writeframes(bytes(128+((i%64 if i%64<32 else 63-i%64)-16) for i in range(8000)))
files['GUIDE.WAV']=hashlib.sha256((out/'GUIDE.WAV').read_bytes()).hexdigest()
(out/'manifest.json').write_text(json.dumps(files,indent=2)+'\n')
print('Guide examples:',len(files)-1,'EXE + GUIDE.WAV')
