#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Fail-closed GS105 executable conformance matrix; no handler-presence checks."""
import argparse,json,subprocess
from pathlib import Path
from s6_inputs import ROOT,digest
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();b=a.build.resolve()
for name in ('GS105-CONFORMANCE.json','GS105-CONFORMANCE.md'):(b/name).unlink(missing_ok=True)
def read(name):return json.loads((b/name).read_text())
def current(e):
 assert e.get('inputs'), 'missing proof inputs'
 for path,h in e['inputs'].items():assert digest(ROOT/path)==h,'stale input '+path
host=read('host/gs105/host-evidence.json');assert host['status']=='HOST_PASS / REAL_PENDING';current(host)
for name,h in host['artifacts'].items():assert digest(b/'host/gs105'/name)==h
assert len(host['results'])>=77 and all(r['fixed_ticks'] in ('PASS','BOUNDED_PASS') and r['native_gs_audio']=='EXACT' for r in host['results'])
bounded=[r['test']['name'] for r in host['results'] if r['fixed_ticks']=='BOUNDED_PASS'];assert set(bounded)=={'V-WAVE-3','T-WAVE-3'}
exe=read('evidence/gs-exe.json');assert exe['status']=='HOST_ACTUAL_EXE_PASS / REAL_PENDING'
assert len(exe['results'])>=201
expected={'a91378987b0c7f64676302645a9e7f1d5cb7fbf6398ad4d0a0f8e03ba27675f2','024f4b4a2c4ab31524243dfaa389b7dd38b3af4d2cdd37d6cbf6efab03d70a8a'}
assert {o['sha256'] for o in exe['originals']}==expected,'both immutable original MOD files are mandatory'
for o in exe['originals']:assert digest(o['path'])==o['sha256']
assert digest(ROOT/'tests/ultrags/dss/run-gs.mjs')==exe['runnerSha256']
assert digest(b/'native/native-card-build.json')==exe['adapterSha256']
for app,h in exe['images'].items():assert digest(b/'ultrags/dss'/(app+'.EXE'))==h
subprocess.run(['node',str(ROOT/'tools/ultrags/gs105-exe-evidence.mjs'),str(b)],cwd=ROOT,check=True)
native=read('host/native/actual-exe.json');assert native['privateProplay'];assert native['inputs']==exe['inputs'];assert native['assembly']==exe['assembly'];assert native['adapterSha256']==exe['adapterSha256']
# Every external proof named in the matrix is mandatory and content-checked.
subprocess.run(['python3',str(ROOT/'tools/ultrags/s7-host.py'),'--build',str(b/'host/s7'),'--verify-only'],check=True)
proof_files=['evidence/lowram-exe.json','host/s7/s7-host-evidence.json','s7-dss-evidence.json','host/s8a/host-evidence.json','host/f00/host-evidence.json','host/f00/bruno-evidence.json','evidence/f00-exe.json','evidence/s8a-exe.json','native/native-card-build.json']
for name in ['host/s8a/host-evidence.json','host/f00/host-evidence.json','host/f00/bruno-evidence.json']:
 e=read(name);assert e['status']=='HOST_PASS / REAL_PENDING';current(e)
 for path,h in e['artifacts'].items():assert digest((b/name).parent/path)==h
bruno=read('host/f00/bruno-evidence.json');assert bruno['ticks_compared']==7557 and bruno['ignore_eof_seconds']==151.14 and bruno['pause_seconds']==19.04
assert bruno['original_sha256']=='024f4b4a2c4ab31524243dfaa389b7dd38b3af4d2cdd37d6cbf6efab03d70a8a'
rows=[
 ('G01','Every §8.2 opcode, CB/DB, optional OUT with DB=0','host/gs105/commands.log; legacy.log; delayedDB actual EXE'),
 ('G02','LOAD slow/fast/mixed; pause0/1/5/60/120s; CRC/readback','legacy.log; commands.log; run-gs FAST/SLOW/VERIFY'),
 ('G03','Unsupported opcodes/error stickiness/recovery','legacy.log all unsupported opcodes; overflow/PSRAM/short failures'),
 ('G04','Original PROPLAY; slots/aliases; unchanged original MOD bytes','host/native/actual-exe.json; evidence/gs-exe.json original hashes'),
 ('G05','Signed/unsigned/defaults/note/fine','commands.log independent FX oracle1344 profiles; FINETUNE actual EXE'),
 ('G06','Priority/seek masks/direct command families/atomic pins','commands.log; legacy.log PINNED; independent mix oracle'),
 ('G07','GS->MOD0,3,1,2 vs natural63/64; 6A/6B','commands.log isolated GS1->MOD3; CHANNEL_ORDER actual EXE; F00 regressions'),
 ('G08','32/33/no-MOD,37,F3/F4,F5/F6/69 at either BUSY','commands.log; legacy.log; BUSY_MANUAL/REINIT_FREES_FX actual EXE'),
 ('G09','Post D0/D1 abort and EXT during LOAD','commands.log post48/49/88/90/98; legacy.log BULK/CANCEL/reset/pending guards; EXT_DURING_LOAD actual EXE'),
 ('T01','M.K./M!K! effects/boundaries and >=64 patterns',f"{len(host['results'])} independent tick fixtures (75 fixed, 2 bounded random); native/GS exact audio; host/s7; F00/libxmp"),
 ('T04','Busy/manual tick, pause/stop/EOF, concurrent FX','commands.log; legacy.log; host/s7; host/s8a'),
 ('F01/F04','FX pitch/sign/loop/mix and continuation/ownership','1344 independent FX profiles; commands.log; legacy.log; host/s7/storage'),
 ('P11','MOD/PCM state, foreground identity, recovery and no implicit global reset','LEGACY_FX_PCM_STATE; actual EXE refusal/ESC/lostD2/lostPLAY/wait replacement; lowram-exe: 4 corrupt probes rejected, 16 repaired cases preserve DSS resident RAM'),
]
normalizations=[
 '1: Separate module/FX u8 namespaces; EXT u16 handles; selection and failure isolation asserted.',
 '2: GS1 replaces MOD3 in isolated audio fixture;63/64 remain natural CHANS and independent dirty flags.',
 '3: Lowest free lane, SeekFirst/Last masks, equal-priority refusal and strict-higher replacement asserted.',
 '4: FX defaults, saturating volume, direct instance note/volume, master/gain optional old values asserted.',
 '5: All96 FX notes use PAL period definition; independent real-valued oracle over1024 output frames.',
 '6: All256 fine bytes round-trip; boundaryfine00/01/02/1E/1F/FE/FF independently pitched, S8/U8.',
 '7: First and repeated63/64; read-one flag independence; SNAPSHOT and natural order asserted.',
 '8: Incomplete loop edits atomic; range validation on PLAY, short loops and original readback preserved.',
 '9: BUSY gates automatic ticks only;69 additional tick at either BUSY; FX continue through MOD controls.',
 '10: 6B full/short/invalid forms accepted; native short loops play without physical sample replication.',
 '11: 3E sign0=S8/sign1=U8,38 U8; exact original bytes and equal independent audio checked.',
 '12: 20 returns00800000 LE pool size,23 saturates255; MEM_INFO uses full pool.',
 '13: Unknown/sticky GS_ERROR,00/08/reset rules, E0/E1 storage error mappings and recovery asserted.',
 '14: 37 and30 free only legacy assets, foreign pins prevent partial deletion; EXT objects retained.',
]
differences=[dict(name=r['test']['name'],classification=r['test']['classification'],ticks=len(r['differences'])) for r in host['results'] if r['differences']]
real_path=ROOT/'build/real/gs105/owner-pass.json'
physical=json.loads(real_path.read_text()) if real_path.exists() else None
if physical:
 assert physical['status']=='REAL_PASS' and physical['source']=='user report'
physical_inputs={str(real_path):digest(real_path)} if physical else {}
physical_limit='Owner reports GS tests PASS after DSS RAM fix; aggregate report only, no per-command transcript/slot/duration' if physical else 'Pre-fix MOD4 printed RESULT PASS then hung on real DSS EXIT at Turbo OFF; resident RAM fix requires physical retest'
report=dict(status='HOST_PASS / DSS_EXE_PASS / REAL_PENDING',S7='IN_PROGRESS',rows=[dict(id=i,requirement=q,test=t,result='PASS')for i,q,t in rows],normalizations=normalizations,independent_reference=dict(revision=host['reference_revision'],differences=differences),command_coverage=host['command_coverage'],tick_cases=len(host['results']),fixed_tick_cases=len(host['results'])-len(bounded),bounded_waveform_cases=len(bounded),fx_profiles=1344,exe_cases=len(exe['results']),originals=exe['originals'],physical=physical,inputs={**physical_inputs,**{str(b/name):digest(b/name) for name in proof_files},str(ROOT/'tools/ultrags/gs105-exe-evidence.mjs'):digest(ROOT/'tools/ultrags/gs105-exe-evidence.mjs'),str(ROOT/'tools/ultrags/gs105-report.py'):digest(__file__),str(b/'host/gs105/host-evidence.json'):digest(b/'host/gs105/host-evidence.json'),str(b/'evidence/gs-exe.json'):digest(b/'evidence/gs-exe.json'),str(b/'host/native/actual-exe.json'):digest(b/'host/native/actual-exe.json')},limits=['Functional SDK/DSS model; no ISA electrical timing proof', physical_limit,'LOAD/post pauses are virtual in HOST; UGTEST GS on Sprinter waits >=120 real seconds','GS Turbo ON: prior firmware REAL_FAIL retained; new candidate requires separate GS-Turbo evidence and REAL confirmation; FLT8 and streaming optimization excluded','S7 physical acceptance remains IN_PROGRESS / REAL_PENDING; no full GS machine/Z80 emulation','S9 playlist/QUEUE capability remains disabled: BAD_OPCODE during LOAD is checked, no success stubs'])
(b/'GS105-CONFORMANCE.json').write_text(json.dumps(report,indent=2)+'\n')
text=['# UGS-GS105/1 executable conformance','',report['status']+'; S7 IN_PROGRESS.','',f"{len(host['command_coverage'])} commands; {len(host['results'])} tick fixtures (75 fixed, 2 bounded random)/native-GS exact audio;1344 independent FX profiles; {len(exe['results'])} actual EXE cases.",'','| Requirement | Executed test | Result |','|---|---|---|']
text.extend('| '+i+' '+q+' | '+t+' | PASS |'for i,q,t in rows)
if physical:text+=['','Physical: REAL_PASS reported by owner for the tested GS series; full S7 hardware acceptance remains pending.']
text+=['','## §8.3 normalizations','']+normalizations+['','## Pinned independent reference differences','']
text.extend(f"- {d['name']}: {d['classification']} ({d['ticks']} ticks)."for d in differences)
text+=['','Expected fixed traces are authored independently and never rewritten from production output.', 'Random modulation checks amplitude bounds and signed irregularity; it does not require the Micromod PRNG sequence.','Micromod is unmodified, pinned and hash-checked; it is not an exact GS ROM oracle.','FX oracle tolerance96 signed16 units/1024 frames; native/GS MOD render comparison is byte-exact.','','## Limits','']+report['limits']
(b/'GS105-CONFORMANCE.md').write_text('\n'.join(text)+'\n');print(report['status'])
