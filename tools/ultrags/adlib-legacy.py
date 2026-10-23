#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Compile pinned pre-AdLib OPL backends with each current legacy mode's flags.
Compare allocated ELF sections, not debug paths or unrelated shared CONFIG code.
"""
import argparse,hashlib,json,re,shlex,struct,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();a.build=a.build.resolve()
root=Path(__file__).resolve().parents[2];out=a.build/'host/adlib/legacy';out.mkdir(parents=True,exist_ok=True)
fw=a.build/'multifw-release';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def sections(path):
 b=path.read_bytes();off=struct.unpack_from('<I',b,32)[0];size,n,strings=struct.unpack_from('<HHH',b,46)
 rows=[struct.unpack_from('<10I',b,off+i*size) for i in range(n)];s=rows[strings];names=b[s[4]:s[4]+s[5]];result={}
 for r in rows:
  if r[2]&2:
   name=names[r[0]:].split(b'\0',1)[0].decode();result[name]=(r[5],b[r[4]:r[4]+r[5]] if r[1]!=8 else b'')
 return result
inputs={};results=[]
for mode in ('adlib','sb'):
 folder=fw/('CMakeFiles/pg-'+mode+'-multifw.dir');flags=folder/'flags.make';inputs[str(flags)]=sha(flags)
 f={m[1]:shlex.split(m[2]) for line in flags.read_text().splitlines() if (m:=re.match(r'((?:C|CXX|ASM)_\w+) = (.*)',line))}
 for name in (('emu8950.c','slot_render.cpp','slot_render_pico.S') if mode=='adlib' else ('dbopl/dbopl.cpp','opl_dbopl.cpp')):
  path=root/'sw/opl'/name;old=out/(mode+'-'+name.replace('/','-'));old.write_bytes(subprocess.check_output(['git','show','7877c4e:sw/opl/'+name],cwd=root))
  lang='CXX' if name.endswith('cpp') else 'ASM' if name.endswith('.S') else 'C';obj=old.with_suffix(old.suffix+'.o')
  subprocess.run(['arm-none-eabi-g++' if lang=='CXX' else 'arm-none-eabi-gcc',*f[lang+'_DEFINES'],*f[lang+'_INCLUDES'],*f[lang+'_FLAGS'],'-I'+str(path.parent),'-c',str(old),'-o',str(obj)],check=True)
  current=folder/'opl'/(name+'.o');before=sections(obj);after=sections(current)
  assert before==after,(mode,name,[k for k in before.keys()|after.keys() if before.get(k)!=after.get(k)])
  # Negative control must detect a real instruction/data mutation.
  changed=dict(after);key=next((k for k,v in after.items() if v[1]),None)
  if key:
   n,data=changed[key];changed[key]=(n,bytes([data[0]^1])+data[1:]);assert before!=changed
  inputs.update({str(path):sha(path),str(current):sha(current),str(old):sha(old),str(obj):sha(obj)})
  results.append(dict(mode=mode,source=name,allocated_sections=len(before),bytes=sum(v[0] for v in before.values()),status='EXACT'))
for name in ('tll_table_flash.c','emu8950.h','slot_render.h'):
 path=root/'sw/opl'/name
 if not path.exists():continue
 inputs[str(path)]=sha(path)
 if name!='emu8950.h':assert path.read_bytes()==subprocess.check_output(['git','show','7877c4e:sw/opl/'+name],cwd=root)
elf=fw/'pg-ultrags-multifw.elf';inputs[str(elf)]=sha(elf)
resources={}
for line in subprocess.check_output(['arm-none-eabi-nm','-S','--defined-only',str(elf)],text=True).splitlines():
 fields=line.split()
 if len(fields)==4 and fields[3] in ('tll_base','queue','synth','source','output'):
  address,size=int(fields[0],16),int(fields[1],16);assert 0x20000000<=address<address+size<=0x20040000
  resources[fields[3]]=dict(address=address,bytes=size)
assert {k:v['bytes'] for k,v in resources.items()}==dict(tll_base=1024,queue=520,synth=2048,source=540,output=512)
inputs[str(Path(__file__).resolve())]=sha(Path(__file__))
(out/'evidence.json').write_text(json.dumps(dict(status='LEGACY_OPL_BACKENDS_EXACT',base='7877c4e',inputs=inputs,results=results,resources=resources,scope='Shared CONFIG changes intentionally alter the mode images; legacy OPL code/data retain exact allocated object sections.'),indent=2)+'\n')
print('Legacy AdLib/SB OPL allocated sections EXACT; instruction mutation rejected')
