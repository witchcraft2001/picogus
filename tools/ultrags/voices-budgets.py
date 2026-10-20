#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Linked SRAM/Settings and previous six mode image identity (SDK BI date only)."""
import argparse, hashlib, json, struct, zlib
from pathlib import Path
from cfg_evidence import verify_multifw
from firmware_evidence import compare_image_except_sdk_date
from budget_report import sections, sram_budget, settings_abi
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--baseline',type=Path,required=True);p.add_argument('--prefix',default='arm-none-eabi');a=p.parse_args()
root=Path(__file__).resolve().parents[2];fw=a.build/'multifw-release';out=a.build/'host/budgets';out.mkdir(parents=True,exist_ok=True)
verify_multifw(fw)
binary=a.baseline.read_bytes();flash=bytearray(b'\xff'*(2<<20));count=len(binary)//512;assert count*512==len(binary)
for i in range(count):
    block=binary[i*512:(i+1)*512];m0,m1,flags,address,n,index,total,family=struct.unpack_from('<8I',block)
    assert (m0,m1,flags,n,index,total,family)==(0x0a324655,0x9e5d5157,0x2000,256,i,count,0xe48bff56)
    assert struct.unpack_from('<I',block,508)[0]==0x0ab16f30
    offset=address-0x10000000;assert offset==i*256 and offset+256<=0x1ff000
    flash[offset:offset+256]=block[32:288]
cat=flash[0x7c00:0x7c00+148];assert cat[:8]==b'UGCF\1\0\10\20' and zlib.crc32(cat[:144])==struct.unpack_from('<I',cat,144)[0]
comparisons=[];sram={};inputs=[Path(__file__),a.baseline,root/'tools/ultrags/firmware_evidence.py',root/'tools/ultrags/budget_report.py',root/'tools/ultrags/settings_abi.c',root/'sw/system/flash_settings.h']
mapping=json.loads((fw/'generated/multifw/flash-map.json').read_text())
for image in mapping['images']:
    mode=image['mode'];elf=fw/(image['name']+'-multifw.elf');bfile=elf.with_suffix('.bin');data=bfile.read_bytes();inputs.extend([elf,bfile])
    sram[image['name']]=sram_budget(sections(a.prefix,elf));assert sram[image['name']]['free_main']>=16384
    assert sram[image['name']]['scratch_x_used']<=4096 and sram[image['name']]['scratch_y_used']<=4096
    if mode<8:
        ident,flags,reserved,off,n,crc=struct.unpack_from('<BBHIII',cat,16+(mode-1)*16)
        assert (ident,flags,reserved)==(mode,1,0);old=flash[off:off+n];assert zlib.crc32(old)==crc
        result=compare_image_except_sdk_date(old,data,elf,a.prefix+'-nm')
        mutant=bytearray(data);mutant[1000]^=1
        try:compare_image_except_sdk_date(old,mutant,elf,a.prefix+'-nm')
        except AssertionError:pass
        else:raise AssertionError('code-byte mutation survived legacy image comparison')
        comparisons.append({'mode':mode,'name':image['name'],**result})
abi=settings_abi(root/'sw',root/'tools/ultrags',a.prefix,out)
assert (abi['sizeof_settings'],abi['settings_version'],abi['off_ug_tail'])==(156,6,152)
sha=lambda path:hashlib.sha256(Path(path).read_bytes()).hexdigest()
(out/'budgets.json').write_text(json.dumps({'status':'LINKED_BUDGETS_PASS / REAL_PENDING','legacy_images':comparisons,'legacy_code_mutations_rejected':6,'sram':sram,'settings':abi,'inputs':{str(x.resolve()):sha(x) for x in inputs}},indent=2)+'\n')
print('All six previous mode images identical except declared SDK date; code mutations rejected; SRAM/Settings PASS')
print('ULTRAGS free main SRAM:',sram['pg-ultrags']['free_main'])
