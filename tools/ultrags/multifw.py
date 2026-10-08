#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Three build phases: placement, final-image manifest/recovery, bundle."""
import argparse, json, struct, zlib, hashlib
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('phase',choices=['layout','catalog','pack']); p.add_argument('--build',type=Path,required=True); p.add_argument('--sw',type=Path,required=True); p.add_argument('--names',nargs=7,required=True); a=p.parse_args()
b=a.build; gen=b/'generated/multifw'; gen.mkdir(parents=True,exist_ok=True)
ids=[1,2,3,4,5,6,8]; end=0x1ff000
if a.phase=='layout':
    origin=0x8000; entries=[]
    for mode,name in zip(ids,a.names):
        # One guard KiB permits the small bundle-only runtime catalogue code.
        capacity=((len((b/(name+'.bin')).read_bytes())+1023)//1024+1)*1024
        if origin+capacity>end: raise SystemExit('images exceed settings boundary')
        (b/(name+'-multifw.ld')).write_text(f'MEMORY {{ FLASH(rx) : ORIGIN = 0x10000000 + {origin}, LENGTH = {capacity} }}\nINCLUDE fw_memmap_c2ram.ld\n')
        entries.append(dict(mode=mode,name=name,offset=origin,capacity=capacity)); origin+=capacity
    (gen/'layout.json').write_text(json.dumps(entries,indent=2)+'\n')
else:
    entries=json.loads((gen/'layout.json').read_text())
    if [e['mode'] for e in entries]!=ids or [e['name'] for e in entries]!=a.names:
        raise SystemExit('invalid slot identity map')
    previous=0x8000
    for e in entries:
        if e['offset']<previous or e['offset']%1024 or e['capacity']<1024 or e['capacity']%1024 or e['offset']+e['capacity']>end:
            raise SystemExit('invalid/overlapping slot reservation')
        previous=e['offset']+e['capacity']
    for e in entries:
        data=(b/(e['name']+'-multifw.bin')).read_bytes()
        if not 264<=len(data)<=e['capacity']: raise SystemExit('final image exceeds reserved slot')
        sp,pc=struct.unpack_from('<II',data,256)
        if sp&7 or not 0x20000000<sp<=0x20042000 or not pc&1 or not 0x10000000+e['offset']<=pc&~1<0x10000000+e['offset']+len(data): raise SystemExit('bad final vector')
        e.update(length=len(data),crc=zlib.crc32(data),sha256=hashlib.sha256(data).hexdigest())
    c=bytearray(struct.pack('<4sBBBBII',b'UGCF',1,0,8,16,148,0))
    for mode in range(1,9):
        e=next((e for e in entries if e['mode']==mode),None)
        c+=struct.pack('<BBHIII',mode,bool(e),0,e['offset'] if e else 0,e['length'] if e else 0,e['crc'] if e else 0)
    c+=struct.pack('<I',zlib.crc32(c))
    if a.phase=='catalog':
        (gen/'catalog.bin').write_bytes(c)
        e=entries[0]
        (gen/'recovery.h').write_text(f'/* generated from FINAL slot-linked GUS */\n#define UG_RECOVERY {{ {e["offset"]}u, {e["length"]}u, {e["crc"]}u }}\n')
        (gen/'flash-map.json').write_text(json.dumps(dict(bootstrap_limit=0x7c00,catalog_offset=0x7c00,catalog_length=148,settings_offset=end,images=entries),indent=2)+'\n')
    else:
        if c!=(gen/'catalog.bin').read_bytes(): raise SystemExit('stale manifest')
        boot=(b/'bootloader.bin').read_bytes()
        if len(boot)>0x7c00: raise SystemExit('bootstrap overlaps catalogue')
        size=(max(e['offset']+e['length'] for e in entries)+255)&~255
        flash=bytearray(b'\xff'*size); flash[:len(boot)]=boot; flash[0x7c00:0x7c00+148]=c
        for e in entries: flash[e['offset']:e['offset']+e['length']]=(b/(e['name']+'-multifw.bin')).read_bytes()
        (b/'picogus.bin').write_bytes(flash)
        uf=bytearray()
        for n in range(size//256):
            uf+=struct.pack('<8I',0x0a324655,0x9e5d5157,0x2000,0x10000000+n*256,256,n,size//256,0xe48bff56)+flash[n*256:(n+1)*256]+bytes(220)+struct.pack('<I',0x0ab16f30)
        (b/'picogus.uf2').write_bytes(uf)
