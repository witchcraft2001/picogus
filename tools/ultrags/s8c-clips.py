#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Extract private 15s hardware fixtures without converting source PCM bytes."""
import argparse,hashlib,json,wave
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--mono',type=Path,required=True)
p.add_argument('--stereo',type=Path,required=True)
p.add_argument('--out',type=Path,default=Path('build/s8c-test-audio'))
a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
results=[]
for source,name,channels,width in [(a.mono,'MONO22.WAV',1,2),(a.stereo,'STEREO22.WAV',2,1)]:
 with wave.open(str(source)) as w:
  assert (w.getnchannels(),w.getsampwidth(),w.getframerate(),w.getcomptype())==(channels,width,22050,'NONE')
  data=w.readframes(15*22050);assert len(data)==15*22050*channels*width
 target=a.out/name
 with wave.open(str(target),'wb') as w:
  w.setparams((channels,width,22050,0,'NONE','not compressed'));w.writeframes(data)
 with wave.open(str(target)) as w:assert w.readframes(w.getnframes())==data
 results.append(dict(source=str(source.resolve()),source_sha256=sha(source.read_bytes()),name=name,
                     channels=channels,bits=width*8,rate=22050,seconds=15,pcm_bytes=len(data),
                     pcm_sha256=sha(data),sha256=sha(target.read_bytes())))
(a.out/'original-clips.json').write_text(json.dumps(dict(status='SOURCE_PCM_UNCHANGED / REAL_PENDING',generator_sha256=sha(Path(__file__).read_bytes()),clips=results),indent=2)+'\n')
print(json.dumps(results,indent=2))
