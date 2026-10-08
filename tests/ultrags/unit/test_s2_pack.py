#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import json,struct,subprocess,sys,zlib
from pathlib import Path
root=Path(__file__).resolve().parents[3];out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
names=['image'+str(i) for i in range(7)]
def run(phase,ok=True):
 r=subprocess.run([sys.executable,str(root/'tools/ultrags/multifw.py'),phase,'--build',str(out),'--sw',str(root/'sw'),'--names',*names],capture_output=True,text=True)
 assert (r.returncode==0)==ok,(phase,r.stderr)
for name in names:(out/(name+'.bin')).write_bytes(bytes(1024))
run('layout');layout=out/'generated/multifw/layout.json';original=layout.read_text();entries=json.loads(original)
for e in entries:
 data=bytearray(1024);struct.pack_into('<II',data,256,0x20042000,0x10000000+e['offset']+265)
 (out/(e['name']+'-multifw.bin')).write_bytes(data)
run('catalog');cat=(out/'generated/multifw/catalog.bin').read_bytes()
assert zlib.crc32((out/'image0-multifw.bin').read_bytes())==struct.unpack_from('<I',cat,28)[0]
assert zlib.crc32((out/'image0.bin').read_bytes())!=struct.unpack_from('<I',cat,28)[0]
(out/'bootloader.bin').write_bytes(bytes(1024));run('pack')
(out/'bootloader.bin').write_bytes(bytes(0x7c01));run('pack',False);(out/'bootloader.bin').write_bytes(bytes(1024))
for mutate in [lambda e:e[1].update(offset=e[0]['offset']),lambda e:e[6].update(offset=0x1ff000),lambda e:e[0].update(offset=0x7c00),lambda e:e[1].update(offset=e[1]['offset']+1),lambda e:e[6].update(mode=7)]:
 e=json.loads(original);mutate(e);layout.write_text(json.dumps(e));run('catalog',False)
layout.write_text(original)
data=(out/'image6-multifw.bin').read_bytes();(out/'image6-multifw.bin').write_bytes(data+bytes(2048));run('catalog',False);(out/'image6-multifw.bin').write_bytes(data)
changed=bytearray(data);changed[-1]=1;(out/'image6-multifw.bin').write_bytes(changed);run('pack',False)
(out/'image6-multifw.bin').write_bytes(data);run('pack')
print('S2 PACK PASS: final-not-provisional CRC, bootstrap/slot/Flash overlap and overflow, stale catalogue rejected')
