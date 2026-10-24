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
# Remove obsolete names: the first draft's long DOS names and the former
# INCLUDE wrappers that the standalone lessons replaced.
for n in ('DISCOVER0','DISCOVER1','MODFX','FM','GSMOD'):
    for ext in ('.EXE','.lst'):(out/(n+ext)).unlink(missing_ok=True)
# GUIDE.MOD: an original four-channel M.K. module for the music lessons.
# One looped square-wave sample, one pattern, four notes (C-2 E-2 G-2 C-3).
mod=bytearray(1084+1024+64)
mod[0:13]=b'UltraGS guide'
mod[20:26]=b'square';mod[42:44]=(32).to_bytes(2,'big');mod[45]=40;mod[48:50]=(32).to_bytes(2,'big')
mod[950]=1;mod[951]=127;mod[1080:1084]=b'M.K.'
for channel,row,period in ((0,0,428),(1,16,339),(2,32,285),(3,48,214)):
    cell=1084+(row*4+channel)*4
    mod[cell]=period>>8;mod[cell+1]=period&255;mod[cell+2]=0x10   # sample 1, no effect
for i in range(64):mod[1084+1024+i]=64 if i<32 else 192
(out/'GUIDE.MOD').write_bytes(mod)
inc.append(out)   # INCBIN "GUIDE.MOD"
files = {}
for src in sorted((ROOT/'host/sprinter/ultrags/examples').glob('*.asm')):
    for slot in ([0,1] if src.stem in ('discover','firstpcm','s3m','gss3m','modfx','fm','gsmod') else [None]):
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
files['GUIDE.MOD']=hashlib.sha256((out/'GUIDE.MOD').read_bytes()).hexdigest()
(out/'manifest.json').write_text(json.dumps(files,indent=2)+'\n')
print('Guide examples:',len(files)-2,'EXE + GUIDE.WAV + GUIDE.MOD')
