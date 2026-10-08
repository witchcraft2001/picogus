#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import argparse,hashlib,json,struct,zlib,subprocess
from pathlib import Path
from budget_report import sections,sram_budget,settings_abi
from firmware_evidence import verify_uf2
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();b=a.build.resolve();root=Path(__file__).resolve().parents[2]
h=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
multi=b/'multifw-release';mapping=json.loads((multi/'generated/multifw/flash-map.json').read_text());raw=(multi/'picogus.bin').read_bytes();cat=raw[0x7c00:0x7c00+148]
assert cat[:8]==b'UGCF\1\0\10\20' and zlib.crc32(cat[:144])==struct.unpack_from('<I',cat,144)[0]
assert len(raw)<0x1ff000 and (multi/'bootloader.bin').stat().st_size<=0x7c00
assert [e['mode'] for e in mapping['images']]==[1,2,3,4,5,6,8]
records=[]
for e in mapping['images']:
    data=(multi/(e['name']+'-multifw.bin')).read_bytes();assert zlib.crc32(data)==e['crc'];assert raw[e['offset']:e['offset']+e['length']]==data
    mode,flags,res,offset,length,crc=struct.unpack_from('<BBHIII',cat,16+(e['mode']-1)*16)
    assert (mode,flags,res,offset,length,crc)==(e['mode'],1,0,e['offset'],len(data),zlib.crc32(data))
    path=multi/(e['name']+'-multifw.elf');memory=sram_budget(sections('arm-none-eabi',path));assert memory['free_main']>=0
    records.append(dict(mode=mode,sram=memory))
assert cat[112:128]==bytes([7])+bytes(15)
# Verify bundle UF2 separately: padding is 0xff, unlike SDK standalone zero padding.
uf=(multi/'picogus.uf2').read_bytes();assert len(uf)//512==len(raw)//256
for i in range(len(uf)//512):
    words=struct.unpack_from('<8I',uf,i*512)
    assert words==(0x0a324655,0x9e5d5157,0x2000,0x10000000+i*256,256,i,len(uf)//512,0xe48bff56)
    assert uf[i*512+32:i*512+288]==raw[i*256:(i+1)*256]
    assert struct.unpack_from('<I',uf,i*512+508)[0]==0x0ab16f30
standalone=b/'ultrags-release/pg-ultrags';verify_uf2(standalone.with_suffix('.uf2').read_bytes(),standalone.with_suffix('.bin').read_bytes())
assert sram_budget(sections('arm-none-eabi',standalone.with_suffix('.elf')))['free_main']>=16384
provenance=[]
for path in [multi/(e['name']+'-multifw.evidence.json') for e in mapping['images']]+[standalone.with_suffix('.evidence.json'),multi/'bootloader.evidence.json']:
    ev=json.loads(path.read_text())
    for file,digest in ev['inputs'].items():assert h(file)==digest, 'stale firmware source: '+file
    stem=str(path).replace('.evidence.json','')
    for ext,digest in ev['artifacts'].items():assert h(stem+'.'+ext)==digest,'stale linked artifact'
    provenance.append({'path':str(path),'sha256':h(path)})
abi=settings_abi(root/'sw',root/'tools/ultrags','arm-none-eabi',b/'host')
assert abi['sizeof_settings']==156 and abi['off_ug_tail']==152 and abi['settings_version']==6
# Preserve the actual v5 offsets, not merely the new tail size.
old={'magic':0,'version':4,'startupMode':5,'Global':6,'Joy':8,'GUS':10,'SB':16,'MPU':22,'CMS':26,'Tandy':28,'Mouse':30,'NE2K':36,'WiFi':38,'CD':136,'MMB':140,'Volume':142,'SB16':148}
for name,offset in old.items():assert abi['off_'+name]==offset,(name,abi['off_'+name])
exe=json.loads((b/'ultrags/logs/s2-run.json').read_text());assert exe['results'] and all(r['ok'] for r in exe['results'])
versions={c:subprocess.check_output(c.split(),text=True,stderr=subprocess.STDOUT).splitlines()[0] for c in ['arm-none-eabi-gcc --version','cmake --version','sjasmplus --version','node --version']}
cache={line.split(':',1)[0]:line.split('=',1)[1] for line in (multi/'CMakeCache.txt').read_text().splitlines() if ':' in line and '=' in line and not line.startswith(('#','//'))}
for key in ['PICO_SDK_PATH','PICO_EXTRAS_PATH']:
    versions[key]=subprocess.check_output(['git','-C',cache[key],'rev-parse','HEAD'],text=True).strip()
wrapper=b/'s2-entrypoint/picogus.bin'
assert wrapper.read_bytes()==raw, 'CMake entrypoints produced different Flash bytes'
report=dict(status='HOST_PASS / DSS-EXE_PASS / REAL_PENDING',catalog=cat.hex(),flash_map=mapping,images=records,settings_abi=abi,provenance=provenance,versions=versions,exe_checks=len(exe['results']),real_pending=['S1 electrical gates','C00','mode switching on Sprinter','SAVE/power-cycle','RESET DRV'],raw_reset_diagnostics='ug_raw_watchdog_reason / ug_raw_chip_reset captured in bootloader and each runtime SRAM; hardware readings pending')
(b/'ultrags/logs/s2-firmware.json').write_text(json.dumps(report,indent=2)+'\n')
print('S2 firmware/catalog/CRC/UF2/SRAM/Settings ABI/provenance PASS; REAL_PENDING')
