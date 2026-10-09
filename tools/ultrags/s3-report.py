#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
import argparse,json,hashlib,subprocess
from pathlib import Path
from budget_report import sections,sram_budget
from firmware_evidence import verify_uf2
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();b=a.build.resolve();root=Path(__file__).resolve().parents[2]
h=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
s2=json.loads((b/'ultrags/logs/s2-firmware.json').read_text())
host_evidence=json.loads((b/'host/s3-host-evidence.json').read_text())
for file,digest in host_evidence['inputs'].items():assert h(file)==digest,'stale host source '+file
assert h(b/'host/s3')==host_evidence['executable']
assert h(b/'host/s3-backend')==host_evidence['backend_executable']
for name,digest in host_evidence['outputs'].items():assert h(b/'host'/name)==digest,'stale host output '+name
backend_test=json.loads((b/'host/s3-backend.json').read_text())
assert backend_test['checks']>=400 and backend_test['pinned_backend'] and backend_test['bounded_waits']
host=json.loads((b/'host/s3-fixtures.json').read_text());assert host['checks']>131000 and host['quick_tested']==92 and host['full_tested']==125829120
exe=json.loads((b/'ultrags/logs/s3-run.json').read_text());assert len(exe['results'])>=90 and all(r['ok'] for r in exe['results'])
assert h(b/'ultrags/dss/UGMEM.EXE')==exe['executed'][0]['sha256'],'stale executed UGMEM'
assert all(r['maxWindowUs']<10000 for r in exe['results'])
images=[]
for directory in ['ultrags-release','ultrags-slow','ultrags-debug']:
    stem=b/directory/'pg-ultrags';memory=sram_budget(sections('arm-none-eabi',stem.with_suffix('.elf')))
    assert memory['free_main']>=16384
    verify_uf2(stem.with_suffix('.uf2').read_bytes(),stem.with_suffix('.bin').read_bytes())
    evidence=stem.with_suffix('.evidence.json');ev=json.loads(evidence.read_text())
    for file,digest in ev['inputs'].items():assert h(file)==digest,'stale source '+file
    for ext,digest in ev['artifacts'].items():assert h(stem.with_suffix('.'+ext))==digest
    cache=(b/directory/'CMakeCache.txt').read_text()
    assert ('UG_PSRAM_SCK_MHZ:STRING=50' if directory.endswith('slow') else 'UG_PSRAM_SCK_MHZ:STRING=100') in cache
    images.append(dict(directory=directory,sram=memory,sha256=h(stem.with_suffix('.uf2')),provenance=str(evidence)))
backend=subprocess.check_output(['git','-C',str(root/'sw/rp2040-psram'),'rev-parse','HEAD'],text=True).strip();assert backend=='419375d5af2af2c72af63cdab6c6df2c558a3a9c'
assert not subprocess.check_output(['git','-C',str(root/'sw/rp2040-psram'),'status','--porcelain'],text=True)
for directory in ['multifw-release','s2-entrypoint']:
    assert 'UG_PSRAM_SCK_MHZ:STRING=100' in (b/directory/'CMakeCache.txt').read_text()
profiles=[dict(nominal_mhz=mhz,clk_sys=370000000,divider256=d,sck_hz=370000000*128//d,hardware='REAL_PENDING') for mhz,d in [(100,473),(50,947)]]
report=dict(status='HOST_PASS / DSS-EXE_PASS / REAL_PENDING',host=host,backend_test=backend_test,host_evidence=host_evidence,differential_fixtures=len(json.loads((b/'host/s3-commands.json').read_text())),exe_checks=len(exe['results']),max_window_us=max(r['maxWindowUs'] for r in exe['results']),images=images,profiles=profiles,backend=backend,settings=s2['settings_abi'],flash_map=s2['flash_map'],versions=s2['versions'],resource_map={'pio0':['IOW SM0','IOR SM1'],'pio1':['M62429 SM0=4 words','PSRAM SM1=9/10 words','I2S SM3=8 words'],'dma':['I2S 0/1','PSRAM 2/3/4','CRC reserve 5'],'registry':'core0 initialization completes before core1 writes'},real_pending=['physical memory capacity/QUICK/FULL','actual SCK/LRCLK/temperature','normal/fudge acceptance','ISA electrical gates, IOCHRDY, DACK','SAVE/RESET DRV and hardware audio'])
(b/'ultrags/logs/s3-firmware.json').write_text(json.dumps(report,indent=2)+'\n')
print(f"S3 HOST_PASS / DSS-EXE_PASS / REAL_PENDING; {host['checks']} C + {backend_test['checks']} pinned backend checks, {len(exe['results'])} actual-EXE cases")
