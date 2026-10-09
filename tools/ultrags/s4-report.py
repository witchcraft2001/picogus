#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import argparse,json,hashlib,subprocess,re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();b=a.build.resolve();root=Path(__file__).resolve().parents[2]
h=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def verify(ev):
 for path,digest in ev['inputs'].items():assert h(path)==digest,'stale S4 source '+path
 for name,digest in ev['outputs'].items():assert h(b/'host'/name)==digest,'stale S4 HOST output '+name
 assert h(b/'host/s4')==ev['executable'],'stale S4 executable'
ev=json.loads((b/'host/s4-host-evidence.json').read_text());verify(ev)
s3=json.loads((b/'ultrags/logs/s3-firmware.json').read_text())
host=json.loads((b/'host/s4-host.json').read_text());assert host['checks']>=26000000 and host['full_bytes']==8388608
expected_inputs=json.loads(subprocess.check_output(['node','--input-type=module','-e', 'import {executionInputs} from "./tools/ultrags/build-evidence.mjs"; process.stdout.write(JSON.stringify(executionInputs(process.argv[1])));',str(root)],cwd=root,text=True))
assembly=json.loads((b/'ultrags/dss/asm-manifest.json').read_text())
runs=[]
for log in ['s4-run.json','s4-full.json']:
 run=json.loads((b/'ultrags/logs'/log).read_text());assert run['inputs']==expected_inputs,'stale S4 execution source';assert run['results'] and all(r['ok'] for r in run['results'])
 assert run['buildInputs']==assembly['inputs'],'stale S4 assembly inputs'
 for exe in run['executed']:assert h(b/'ultrags/dss'/exe['name'])==exe['sha256'],'stale S4 executed EXE '+exe['name']
 assert all(r['maxWindowUs']<10000 for r in run['results']);runs+=run['results']
assert any(r['name']=='8MiB actual EXE' for r in runs)
assert any(r['name']=='non-DSS sticky error delayed reply' for r in runs),'missing non-DSS sticky-error regression'
report={**s3,'stage':'S4','host_s4':host,'s4_host_evidence':ev,'s4_exe_checks':len(runs),'s4_max_window_us':max(r['maxWindowUs'] for r in runs),'real_pending':s3['real_pending']+['C00 early 12-lane physical gate','8MiB SEAL <=30s on hardware','maximum physical uninterrupted service interval'],'diagnostic_symbols':['ug_seal_elapsed_us','ug_service_max_us','ug_spi_slice_max_us'],'features':226,'musical_formats':0}
report['timing_diagnostics']={}
for entry in report['images']:
 directory=b/entry['directory'];elf=directory/'pg-ultrags.elf'
 compiler=Path(re.search(r'^CMAKE_C_COMPILER:[^=]+=([^\n]+)',(directory/'CMakeCache.txt').read_text(),re.M)[1])
 symbols={}
 for line in subprocess.check_output([str(compiler.with_name('arm-none-eabi-nm')),'-g','--defined-only',str(elf)],text=True).splitlines():
  parts=line.split()
  if len(parts)==3 and parts[2] in report['diagnostic_symbols']:symbols[parts[2]]='0x'+parts[0]
 assert set(symbols)==set(report['diagnostic_symbols']),'missing SRAM timing diagnostic'
 report['timing_diagnostics'][entry['directory']]={'addresses':symbols,'elf_sha256':h(elf),'format':'volatile u32 microseconds; measure on hardware; mock values are not physical timing'}
(b/'ultrags/logs/s4-firmware.json').write_text(json.dumps(report,indent=2)+'\n')
(b/'REPORT-S4.txt').write_text('S4 HOST_PASS / DSS-EXE_PASS / REAL_PENDING\n'+f"Actual C/UBSan: {host['checks']} checks, full 8MiB upload/readback/SEAL.\nActual EXE: {len(runs)} checks including independent 8MiB ROUNDTRIP.\n"+'Protocol4/API1.0/Settings v6 preserved. FAST/VERIFY and manifest CRC checked separately.\nC00/physical PSRAM/ISA/frequency/temperature/SEAL time remain REAL_PENDING.\nSee ultrags/logs/s4-firmware.json, s4-run.json, s4-full.json and build provenance.\n')
# Freshness negative checks exercise the actual verifier, restoring files.
output=b/'host/s4-host.json';data=output.read_bytes()
try:
 output.write_bytes(data+b' ')
 try:verify(ev)
 except AssertionError:pass
 else:raise AssertionError('stale HOST accepted')
finally:output.write_bytes(data)
print(f"S4 HOST_PASS / DSS-EXE_PASS / REAL_PENDING: {host['checks']} C checks, {len(runs)} EXE cases")
