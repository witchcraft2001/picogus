#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Verify and inventory linked standalone images; all output goes in build/."""
import argparse, hashlib, json, struct, subprocess, sys
sys.dont_write_bytecode = True
from pathlib import Path
from budget_report import sections, sram_budget, pio_programs
from firmware_evidence import verify, verify_uf2, digest
p=argparse.ArgumentParser();p.add_argument('--build',required=True);args=p.parse_args()
root=Path(args.build).resolve(); results=[]
for variant in ['release','debug','no-dack']:
    directory=root/('ultrags-diag-'+variant); elf=directory/'pg-ultrags-diag.elf'
    evidence=verify(directory,elf)
    assert evidence['configuration']=={'PROJECT_TYPE':'ULTRAGS_DIAG','PGDEBUG':'ON' if variant=='debug' else 'OFF','UG_DIAG_NO_DACK':'ON' if variant=='no-dack' else 'OFF','UG_ISA_WRITE_PROFILE':'HANDSHAKE'}, evidence['configuration']
    nm=subprocess.check_output(['arm-none-eabi-nm',str(elf)],text=True)
    symbols={line.split()[-1]:int(line.split()[0],16) for line in nm.splitlines() if len(line.split())==3}
    origin=symbols['__flash_binary_start'];assert origin==0x10000000,hex(origin)
    memory=sram_budget(sections('arm-none-eabi',elf));assert memory['free_main']>=16384
    pio=pio_programs(directory);assert all(v['pio0_words']<=32 and v['pio1_words']<=32 for v in pio['layouts'])
    assert pio['programs']['diag_iow']['length']==11
    assert pio['programs']['diag_ior']['length']==10
    assert pio['programs']['diag_iow_no_dack']['length']==11
    for layout in pio['layouts']:
        layout['pio0_programs']=['diag_iow_no_dack' if variant=='no-dack' else 'diag_iow','diag_ior']
        layout['pio0_words']=sum(pio['programs'][name]['length'] for name in layout['pio0_programs'])
    pio['standalone_pio0_words']=21
    files={}
    for ext in ['elf','bin','uf2']:
        path=directory/('pg-ultrags-diag.'+ext);b=path.read_bytes();files[path.name]={'size':len(b),'sha256':hashlib.sha256(b).hexdigest()}
        if ext=='uf2':
            verify_uf2(b,(directory/'pg-ultrags-diag.bin').read_bytes(),origin)
    results.append({'variant':variant,'standalone':True,'origin':hex(origin),'sram':memory,'pio':pio,'files':files,'evidence_sha256':digest(directory/'standalone-evidence.json'),'configuration':evidence['configuration']})
report={'status':'HOST_PASS / DSS-EXE_PASS / REAL_PENDING','images':results,'resources':{'ISA':'PIO0 SM0/1 polling core0','I2S':'PIO1 SM3 DMA0/1 IRQ0 core1 priority0x40','PSRAM':'PIO1 SM1 DMA2/3/4 core1','guard':'alarm2 TIMER_IRQ_2 core1 priority0x00 standalone only','IRQ_PIN':'inactive','posted_FIFO':'S5_PENDING'}}
out=root/'ultrags/logs';out.mkdir(parents=True,exist_ok=True);(out/'s1-firmware.json').write_text(json.dumps(report,indent=2)+'\n')
print('PASS standalone 0x10000000; release/debug/no-DACK; SRAM>=16KiB, PIO<=32, UF2 origin, hashes')
