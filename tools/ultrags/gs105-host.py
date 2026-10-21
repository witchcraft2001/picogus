#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Independent fixed tick expectations, production native/GS audio equivalence.

Expected vectors below are authored independently; this runner never rewrites them.
Micromod is read from the pinned, hashed cache, never linked into firmware.
"""
import argparse,json,subprocess,re
from pathlib import Path
from s6_inputs import ROOT,COMMON,digest
from gs105_reference import compare,check_rejection
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();b=a.build.resolve();b.mkdir(parents=True,exist_ok=True)
(b/'host-evidence.json').unlink(missing_ok=True)
ref=ROOT/'build/reference/micromod';revision='83b5d9aebddb528ea177e115b0afed5d75f6b92a'
reference_hashes={'micromod.c':'15481720d1ba6c7b023f699ae80fe8a12bcbfe5fb1847243b53ab537c0356a5a','micromod.h':'40fec0a4849ce0853c6d13c3f1ebf086091c39a8e0f09ee65c3f6ec27e5d17f6'}
for name,expected in reference_hashes.items():
 assert (ref/name).is_file(),f'Cache required: {ref/name}; fetch raw GitHub at {revision}/micromod-c/{name}'
 assert digest(ref/name)==expected,'Pinned Micromod cache hash differs: '+name
subprocess.run(['node',str(ROOT/'tools/ultrags/gen-wire.mjs'),str(ROOT/'tools/ultrags/wire-schema.json'),str(b/'gen')],check=True)
subprocess.run(['python3',str(ROOT/'tools/ultrags/gen-diag.py'),str(ROOT/'tools/ultrags/diag-schema.json'),str(b/'gen')],check=True)
inputs={ROOT/f for f in COMMON}|{ROOT/f for f in ('tests/ultrags/unit/gs105_trace.c','tests/ultrags/unit/gs105_micromod.c','tests/ultrags/unit/test_shared_voices.c','tests/ultrags/unit/test_legacy.c','tests/ultrags/unit/gs105_commands.c')}|{Path(__file__).resolve(),ROOT/'tools/ultrags/gs105_reference.py',ROOT/'tools/ultrags/s6_inputs.py',ROOT/'tests/ultrags/reference/sources.json',ref/'micromod.c',ref/'micromod.h'}
for folder in ('sw/ultrags','tests/ultrags/unit/sdk_mock','common','sw/system','sw/multifw'):inputs.update((ROOT/folder).rglob('*.h'))
inputs.update((ROOT/'sw/ultrags').glob('*.inc'));inputs.update((b/'gen').glob('*'))
input_hashes={str(f):digest(f) for f in sorted(inputs)}
cmd=['cc','-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-pthread','-fsanitize=undefined','-fno-sanitize-recover=all','-DUG_S4_TEST=1','-DPSRAM_ASYNC=1','-DPSRAM_PIN_CS=1',*['-I'+str(ROOT/d) for d in ('tests/ultrags/unit/sdk_mock','sw','sw/ultrags','common')],'-I'+str(b/'gen')]
commands=[]
for name,sources in [('trace',['tests/ultrags/unit/gs105_trace.c',*COMMON]),('legacy',['tests/ultrags/unit/test_legacy.c',*COMMON]),('commands',['tests/ultrags/unit/gs105_commands.c',*COMMON])]:
 c=[*cmd,*[str(ROOT/f) for f in sources],'-o',str(b/name)];subprocess.run(c,check=True);commands.append(c)
# The reference contains historically intentional signed arithmetic. Keep it
# separate from the production-C UBSan gate; no source patching.
c=['cc','-std=c11','-O2','-I'+str(ref),str(ROOT/'tests/ultrags/unit/gs105_micromod.c'),'-o',str(b/'micromod')];subprocess.run(c,check=True);commands.append(c)
for name in ('legacy','commands'):
 r=subprocess.run([str(b/name)],capture_output=True,text=True);(b/(name+'.log')).write_text(r.stdout+r.stderr);print(r.stdout+r.stderr,end='');r.check_returncode()
supported={0,8,0x20,0x21,0x23,0x2a,0x2b,0x2e,0x30,0x31,0x32,0x33,0x35,0x36,0x37,0x38,0x39,0x3a,0x3d,0x3e,0x40,0x41,0x42,0x45,0x46,0x47,0x48,0x49,*range(0x60,0x6c),*range(0x80,0x84),*range(0x88,0x8c),*range(0x90,0x94),*range(0x98,0x9c),*range(0xa0,0xa4),*range(0xa8,0xac),0xd0,0xd1,0xd2,0xf0,0xf3,0xf4,0xf5,0xf6}
covered={int(v,16) for v in re.findall(r'COMMAND_([0-9A-F]{2}) EXECUTED_ASSERTIONS_PASS',(b/'commands.log').read_text())}
assert covered==supported,('missing commands',supported-covered)
# columns: order,row,tick,speed,bpm,period,volume,mix,pan,offset,trigger,fine,gliss,waveV,waveT
cases=[]
def case(name,fx,param,expect=None,field=5,period=0,extra=(),ticks=18,at=6,classification=None,row=1,checks=(),bounds=(),loop=True):
 cases.append(dict(name=name,fx=fx,param=param,expect=expect,field=field,period=period,extra=extra,ticks=ticks,at=at,classification=classification,row=row,checks=checks,bounds=bounds,loop=loop))
case('000',0,0,[428]*6)
case('037',0,0x37,[428,360,286,428,360,286])
case('103',1,3,[428,425,422,419,416,413])
case('203',2,3,[428,431,434,437,440,443])
case('307',3,7,[428,421,414,407,400,400],period=400)
case('1FF-clamp',1,255,[1]*6,extra=((0,0,1,0,0),),classification='safe native clamp 1..4095; reference permits zero period')
case('2FF-clamp',2,255,[4090,4095,4095,4095,4095,4095],extra=((0,0,4090,0,0),),classification='safe native clamp 1..4095; reference permits larger periods')
case('300-memory',3,0,[400,393,386,380,380,380],period=380,row=2,at=12,extra=((1,0,400,3,7),))
case('E31-porta',3,7,[428,428,404,404,404,404],period=400,extra=((0,0,428,14,0x31),),classification='native E3 quantization; Micromod omits glissando')
case('9FF-beyond-loop',9,255,[65280]*6,field=9,period=428)
case('423',4,0x23,[428,428,429,430,431,432],classification='native modulation uses phase before increment; reference increments first')
case('531',5,0x31,[32,35,38,41,44,47],field=6,period=400,classification='native up-nibble priority; reference subtracts both nibbles')
case('631',6,0x31,[32,35,38,41,44,47],field=6,classification='native up-nibble priority; reference subtracts both nibbles')
case('723',7,0x23,[32,32,34,36,38,40],field=7,classification='native modulation uses phase before increment; reference increments first')
case('87B',8,123,[123]*6,field=8)
case('901',9,1,[256]*6,field=9,period=428)
case('900-memory',9,0,[256]*6,field=9,period=428,extra=((0,0,428,9,1),))
case('AFF-priority',10,0x31,[32,35,38,41,44,47],field=6,classification='native up-nibble priority; reference subtracts both nibbles')
case('A03',10,3,[32,29,26,23,20,17],field=6)
case('B01',11,1,[1]*6,field=0,at=12)
case('CFF',12,255,[64]*6,field=6)
case('D12',13,0x12,[12]*6,field=1,at=12)
case('DFA-invalid',13,0xfa,[0]*6,field=1,at=12)
case('E17',14,0x17,[421]*6)
case('E27',14,0x27,[435]*6)
case('E31',14,0x31,[1]*6,field=12)
for wave in range(8):
 case(f'E4{wave}',14,0x40+wave,[wave]*6,field=13)
 case(f'E7{wave}',14,0x70+wave,[wave]*6,field=14)
case('E57',14,0x57,[407]*6,period=428,classification='native E5 current-note tuning differs from reference note/table handling')
case('E60',14,0x60,[1]*6,field=1)
case('E63',14,0x63,[0]*6,field=1,at=12,extra=((0,0,428,14,0x60),),ticks=60)
case('E89',14,0x89,[153]*6,field=8)
case('E92',14,0x92,[1,1,2,2,3,3],field=10)
case('E90',14,0x90,[1]*6,field=10)
case('EA7',14,0xa7,[39]*6,field=6)
case('EB7',14,0xb7,[25]*6,field=6)
case('EC2',14,0xc2,[32,32,0,0,0,0],field=6)
case('EC0',14,0xc0,[0]*6,field=6)
case('ED2',14,0xd2,[428,428,400,400,400,400],period=400)
case('ED9-discard',14,0xd9,[1]*6,field=10,period=400)
case('EE2',14,0xe2,[1]*18,field=1,ticks=30)
case('E00-ignored',14,0,[428]*6)
case('EFF-ignored',14,0xff,[428]*6)
case('F03',15,3,[3]*6,field=3)
case('F96',15,150,[150]*6,field=4)
case('F00-pause',15,0,[1]*6,field=1,classification='native inherited 6A=0 pauses; Micromod ignores F00')
# Independently authored combined-effect and waveform/phase expectations.
case('531-combined',5,0x31,[400,393,386,380,380,380],period=380,row=2,at=12,ticks=24,extra=((1,0,400,3,7),),checks=((6,[32,35,38,41,44,47]),),classification='native up-nibble priority; reference subtracts both nibbles')
case('631-combined',6,0x31,[428,432,433,433,433,433],row=2,at=12,ticks=24,extra=((1,0,0,4,0x23),),checks=((6,[32,35,38,41,44,47]),),classification='native modulation phase and up-nibble priority')
for wave,periods,volumes in [(1,[428,433,433,433,432,432],[32,43,43,42,41,40]),(2,[428,433,433,433,433,433],[32,43,43,43,43,43]),(3,None,None)]:
 case(f'V-WAVE-{wave}',4,0x23,periods,extra=((0,0,428,14,0x40+wave),),bounds=((5,423,433),),classification='waveform phase/origin and integer rounding differ')
 case(f'T-WAVE-{wave}',7,0x23,volumes,field=7,extra=((0,0,428,14,0x70+wave),),bounds=((7,20,43),),classification='waveform phase/origin and integer rounding differ')
for keep in (False,True):
 case('V-PHASE-'+str(int(keep)),14,0x44 if keep else 0x40,[10 if keep else 0]*6,field=15,period=400,row=2,at=12,extra=((1,0,0,4,0x23),),checks=((10,[2]*6),),classification='native waveform selection applies before note phase reset')
 case('T-PHASE-'+str(int(keep)),14,0x74 if keep else 0x70,[10 if keep else 0]*6,field=16,period=400,row=2,at=12,extra=((1,0,0,7,0x23),),checks=((10,[2]*6),),classification='native waveform selection applies before note phase reset')
case('8-left',8,0,[0]*6,field=8)
case('8-right',8,255,[255]*6,field=8)
case('9FF-no-loop',9,255,[65280]*6,field=9,period=428,loop=False)
case('global-BD-last',0,0,[1]*6,field=0,at=12,checks=((1,[5]*6),),extra=((1,0,0,11,2),(1,1,0,13,0x12),(1,2,0,11,1),(1,3,0,13,5)))
case('global-F-last',0,0,[7]*6,field=3,checks=((4,[180]*6),),extra=((1,0,0,15,3),(1,1,0,15,150),(1,2,0,15,7),(1,3,0,15,180)))
results=[];artifacts={n:digest(b/n) for n in ('trace','legacy','commands','micromod','legacy.log','commands.log')}
for test in cases:
 name=test['name'];mod=bytearray(1084+3*1024+1024);mod[950]=3;mod[952:955]=bytes((0,1,2));mod[1080:1084]=b'M.K.'
 mod[42:44]=(512).to_bytes(2,'big');mod[45]=32;mod[48:50]=(512 if test['loop'] else 0).to_bytes(2,'big')
 for i in range(1024):mod[1084+3072+i]=64 if i%32<16 else 192
 def event(row,ch,period,fx,param,sample=0):
  off=1084+row*16+ch*4;mod[off:off+4]=bytes(((sample&0xf0)|(period>>8),period&255,(sample<<4)|fx,param))
 event(0,0,428,0,0,1)
 for row,ch,period,fx,param in test['extra']:event(row,ch,period,fx,param,1 if row==0 else 0)
 if not name.startswith('global-'):event(test['row'],0,test['period'],test['fx'],test['param'])
 path=b/(name+'.MOD');path.write_bytes(mod)
 r=subprocess.run([str(b/'trace'),str(path),str(test['ticks']),*(['--silent-after-row1'] if not test['loop'] else [])],capture_output=True,text=True,check=True)
 (b/(name+'.trace')).write_text(r.stdout+r.stderr);trace=[json.loads(l) for l in r.stdout.splitlines()]
 if test['expect'] is not None:
  got=[t[test['field']] for t in trace[test['at']:test['at']+len(test['expect'])]]
  assert got==test['expect'],(name,got,test['expect'])
 for field,expected in test['checks']:
  assert [t[field] for t in trace[test['at']:test['at']+len(expected)]]==expected,(name,field,'fixed tick mismatch')
 for field,low,high in test['bounds']:
  assert all(low<=t[field]<=high for t in trace[test['at']:test['at']+6]),(name,field,'waveform out of bounds')
 if name in ('V-WAVE-3','T-WAVE-3'):
  field,base=(5,428) if name.startswith('V-') else (7,32)
  values=[t[field] for t in trace[7:12]]
  assert min(values)<base<max(values) and len(set(values))>=3,(name,'random waveform lacks signed variation')
  assert any(x<y for x,y in zip(values,values[1:])) and any(x>y for x,y in zip(values,values[1:])),(name,'random waveform is monotonic')
 m=subprocess.run([str(b/'micromod'),str(path),str(test['ticks'])],capture_output=True,text=True,check=True)
 (b/(name+'.micromod')).write_text(m.stdout);reference=[json.loads(l) for l in m.stdout.splitlines()]
 differences=compare(test,trace,reference)
 check_rejection(test,trace,reference)
 results.append(dict(test=test,native_gs_audio='EXACT',fixed_ticks='PASS' if test['expect'] is not None else 'BOUNDED_PASS',reference='CLASSIFIED' if differences else 'EXACT',differences=differences))
 for f in (path,b/(name+'.trace'),b/(name+'.micromod')):artifacts[f.name]=digest(f)
assert {str(f):digest(f) for f in sorted(inputs)} == input_hashes, 'inputs changed during HOST run'
report=dict(status='HOST_PASS / REAL_PENDING',reference_revision=revision,command_coverage=sorted(covered),commands=commands,inputs=input_hashes,results=results,artifacts=artifacts)
(b/'host-evidence.json').write_text(json.dumps(report,indent=2)+'\n');print('GS105',len(results),'tick fixtures (75 fixed, 2 bounded random waveforms)/native-GS exact audio; independent reference classified PASS')
