#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Verify current S5 evidence, artifacts and resource budgets before packaging."""
import argparse,hashlib,json,subprocess,struct,zlib
from pathlib import Path
from budget_report import sections,sram_budget
from firmware_evidence import verify,verify_uf2,configuration
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);a=p.parse_args();b=a.build.resolve();r=Path(__file__).resolve().parents[2]
h=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
ev=json.loads((b/'host/s5-host-evidence.json').read_text())
for file,digest in ev['inputs'].items():assert h(file)==digest,'stale S5 HOST source '+file
for file,digest in ev['outputs'].items():assert h(b/'host'/file)==digest,'stale S5 HOST output '+file
assert h(b/'host/s5')==ev['executable'] and h(b/'host/s5-front')==ev['front_executable']
assert set(ev['diagnostic_executables'])=={'s5-diag','s5-diag-no-dack'}
for name,digest in ev['diagnostic_executables'].items():
    assert h(b/'host'/name)==digest,'stale S5 posted diagnostic executable'
    assert 'HOST_PASS: 13 checks' in (b/'host'/(name+'.txt')).read_text()
host=json.loads((b/'host/s5-host.json').read_text());assert host['bulk'] and host['full_bytes']==8388608 and host['checks']>40000000
# Verify the current source tree and the complete executed EXE set, not just
# agreement between two potentially stale manifests.
subprocess.run(['node','--input-type=module','-e',
    'import {verifyExecution} from "./tools/ultrags/build-evidence.mjs"; verifyExecution(process.argv[1],process.argv[2]);',
    str(r),str(b/'ultrags/dss')],cwd=r,check=True)
assembly=json.loads((b/'ultrags/dss/asm-manifest.json').read_text())
expected=json.loads(subprocess.check_output(['node','--input-type=module','-e','import {executionInputs} from "./tools/ultrags/build-evidence.mjs"; process.stdout.write(JSON.stringify(executionInputs(process.argv[1])));',str(r)],cwd=r,text=True))
runs=[]
for name in ['s5-run.json','s5-full.json','s5-variants.json']:
    run=json.loads((b/'ultrags/logs'/name).read_text())
    assert run['inputs']==expected and run['buildInputs']==assembly['inputs'],'stale S5 execution sources'
    assert run['results'] and all(x['ok'] for x in run['results'])
    for exe in run['executed']:assert h(b/'ultrags/dss'/exe['name'])==exe['sha256'],'stale S5 executed EXE '+exe['name']
    assert all(x['maxWindowUs']<10000 for x in run['results']);runs+=run['results']
    if name=='s5-variants.json':assert run['scriptSha256']==h(r/'tools/ultrags/s5-variants.mjs'),'stale S5 variant verifier'
assert any(x['name']=='8MiB actual EXE' and not x['hostCrcCalls'] for x in runs)
assert any(x['name']=='bench default' for x in runs)
assert sum(x['name'].startswith('benchmark known-NMI') for x in runs)==8
assert any(x['name']=='ROUNDTRIP older CAPS preserves foreign object' for x in runs)
assert {'benchmark counter saturation','benchmark signed CRC cost','benchmark older CAPS SLOW','benchmark older CAPS ALL'}<={x['name'] for x in runs},'missing S5 code-review regressions'
assert {x['wireBytes'] for case in runs for x in case.get('compact',[])}=={25,45,49}
pio=json.loads((b/'host/s5-pio.json').read_text());assert pio['checks']>=34
for f,d in pio['inputs'].items():assert h(f)==d,'stale S5 PIO evidence'
images=[]
for directory,stem,diag in [('ultrags-posted','pg-ultrags',False),('diag-posted','pg-ultrags-diag',True),('diag-posted-no-dack','pg-ultrags-diag',True)]:
    path=b/directory/stem;memory=sram_budget(sections('arm-none-eabi',path.with_suffix('.elf')));assert memory['free_main']>=16384
    verify_uf2(path.with_suffix('.uf2').read_bytes(),path.with_suffix('.bin').read_bytes())
    if not diag:
        symbols=subprocess.check_output(['arm-none-eabi-nm','-g','--defined-only',str(path.with_suffix('.elf'))],text=True)
        assert 'pico_firmware_start' not in symbols and 'pico_firmware_write' not in symbols and 'firmware_loop' not in symbols,'blocking reflasher linked into POSTED'
    if diag:evidence=verify(b/directory,path.with_suffix('.elf'))
    else:
        evidence=json.loads(path.with_suffix('.evidence.json').read_text())
        for f,d in evidence['inputs'].items():assert h(f)==d,'stale S5 firmware source '+f
        for ext,d in evidence['artifacts'].items():assert h(path.with_suffix('.'+ext))==d
    assert 'UG_ISA_WRITE_PROFILE:STRING=POSTED' in (b/directory/'CMakeCache.txt').read_text()
    images.append({'directory':directory,'sha256':h(path.with_suffix('.uf2')),'sram':memory,'evidence':evidence})
for directory in ['multifw-release','s2-entrypoint','multifw-posted','entrypoint-posted']:
    prefix=b/directory
    expected_profile='POSTED' if directory.endswith('posted') else 'HANDSHAKE'
    assert configuration(prefix)['UG_ISA_WRITE_PROFILE']==expected_profile
    mapping=json.loads((prefix/'generated/multifw/flash-map.json').read_text())
    raw=(prefix/'picogus.bin').read_bytes();catalog=raw[0x7c00:0x7c00+148]
    assert catalog[:8]==b'UGCF\1\0\10\20' and zlib.crc32(catalog[:144])==struct.unpack_from('<I',catalog,144)[0]
    assert len(raw)<0x1ff000 and len(raw)%256==0
    assert (prefix/'bootloader.bin').stat().st_size<=0x7c00
    assert [entry['mode'] for entry in mapping['images']]==[1,2,3,4,5,6,8]
    for entry in mapping['images']:
        binary=(prefix/(entry['name']+'-multifw.bin')).read_bytes()
        assert len(binary)==entry['length'] and zlib.crc32(binary)==entry['crc']
        assert raw[entry['offset']:entry['offset']+entry['length']]==binary
        record=struct.unpack_from('<BBHIII',catalog,16+(entry['mode']-1)*16)
        assert record==(entry['mode'],1,0,entry['offset'],len(binary),entry['crc'])
        memory=sram_budget(sections('arm-none-eabi',prefix/(entry['name']+'-multifw.elf')))
        assert memory['free_main']>=(16384 if entry['mode']==8 else 0)
    assert catalog[112:128]==bytes([7])+bytes(15)
    uf=(prefix/'picogus.uf2').read_bytes();count=len(raw)//256
    assert len(uf)==count*512
    for i in range(count):
        assert struct.unpack_from('<8I',uf,i*512)==(0x0a324655,0x9e5d5157,0x2000,0x10000000+i*256,256,i,count,0xe48bff56)
        assert uf[i*512+32:i*512+288]==raw[i*256:(i+1)*256]
        assert struct.unpack_from('<I',uf,i*512+508)[0]==0x0ab16f30
    evidence_paths=[prefix/(entry['name']+'-multifw.evidence.json') for entry in mapping['images']]+[prefix/'bootloader.evidence.json']
    for path in evidence_paths:
        data=json.loads(path.read_text())
        for f,d in data['inputs'].items():assert h(f)==d,'stale S5 bundle source '+f
        for ext,d in data['artifacts'].items():assert h(path.with_name(path.name.replace('.evidence.json','.'+ext)))==d
assert (b/'multifw-release/picogus.bin').read_bytes()==(b/'s2-entrypoint/picogus.bin').read_bytes()
assert (b/'multifw-posted/picogus.bin').read_bytes()==(b/'entrypoint-posted/picogus.bin').read_bytes()
for entry in json.loads((b/'multifw-release/generated/multifw/flash-map.json').read_text())['images']:
    if entry['mode']!=8:
        name=entry['name']+'-multifw.bin';assert (b/'multifw-release'/name).read_bytes()==(b/'multifw-posted'/name).read_bytes(),'POSTED altered other mode'
s4=json.loads((b/'ultrags/logs/s4-firmware.json').read_text())
for evidence,key in [(s4['host_evidence'],'executable'),(s4['s4_host_evidence'],'executable')]:
    for file,digest in evidence['inputs'].items():assert h(file)==digest,'stale S5 regression source '+file
    for name,digest in evidence['outputs'].items():assert h(b/'host'/name)==digest,'stale S5 regression output '+name
    executable='s4' if evidence is s4['s4_host_evidence'] else 's3'
    assert h(b/'host'/executable)==evidence[key],'stale S5 regression executable'
assert h(b/'host/s3-backend')==s4['host_evidence']['backend_executable']
for entry in s4['images']:
    stem=b/entry['directory']/'pg-ultrags'
    evidence=json.loads(Path(entry['provenance']).read_text())
    for file,digest in evidence['inputs'].items():assert h(file)==digest,'stale S5 handshake source '+file
    for ext,digest in evidence['artifacts'].items():assert h(stem.with_suffix('.'+ext))==digest,'stale S5 handshake artifact'
    assert h(stem.with_suffix('.uf2'))==entry['sha256'],'stale S5 handshake report'
    assert configuration(stem.parent)['UG_ISA_WRITE_PROFILE']=='HANDSHAKE'
    verify_uf2(stem.with_suffix('.uf2').read_bytes(),stem.with_suffix('.bin').read_bytes())
for directory in ['ultrags-diag-release','ultrags-diag-debug','ultrags-diag-no-dack']:
    verify(b/directory,b/directory/'pg-ultrags-diag.elf')
    assert configuration(b/directory)['UG_ISA_WRITE_PROFILE']=='HANDSHAKE'

physical_budgets={'status': 'REAL_PENDING', 'capture_evidence': None, 'time_unit': 'ns', 'rate_unit': 'bytes/s', 'handshake': {'minimum_capture_gap_ns': None, 'service_max_ns': None, 'formula': 'service_max<=floor(0.75*minimum_capture_gap)'}, 'posted': {'ingress_sustained_bytes_per_s': None, 'drain_sustained_bytes_per_s': None, 'service_hiatus_max_ns': None, 'backlog_max': None, 'capacity': 8, 'required_backlog_max': 6, 'formula': 'drain>=1.25*ingress; Q=Q0+arrivals-drained<=6/8; no loss/duplication/RXSTALL'}, 'read': {'T_ready_validated_ns': None, 'T_assert_validated_ns': None, 'fence_plus_tail_max_ns': None, 'hold_max_ns': None, 'assertion_max_ns': None, 'uncertainty_ns': None, 'formula': 'fence+tail+uncertainty and hold+uncertainty<=floor(0.75*T_ready_validated); assertion+uncertainty<=floor(0.75*T_assert_validated)'}}
report={**s4,'stage':'S5','host_s5':host,'s5_evidence':ev,'s5_exe_checks':len(runs),'verifiers':{name:h(r/'tools/ultrags'/name) for name in ['s5-report.py','build-evidence.mjs','verify-package.mjs']},'posted_images':images,'pio':pio,'features':230,'aliases_features':238,'musical_formats':0,'release_profile':'HANDSHAKE','posted_status':'EXPERIMENTAL / REAL_PENDING','s5_model_max_window_us':max(x['maxWindowUs'] for x in runs),'physical_budgets':physical_budgets,'real_pending':s4['real_pending']+['C00/P06/B05/B06 physical S5 acceptance','posted worst service hiatus/backlog/fence/hold/assertion','fastest stable physical write/read method']}
(b/'ultrags/logs/s5-firmware.json').write_text(json.dumps(report,indent=2)+'\n')
(b/'REPORT-S5.txt').write_text('S5 HOST_PASS / DSS-EXE_PASS / REAL_PENDING\n'+f"Actual C/UBSan: {host['checks']} checks, full 1/2/4/8MiB BULK VERIFIED upload/readback/SEAL.\nActual EXE: {len(runs)} S5 checks including full 8MiB BULK ROUNDTRIP.\n"+'S0a-S4 regression gates pass. All shipped EXEs are executed and byte-verified.\nHANDSHAKE release default; POSTED is experimental. Protocol4/API1.0/Settingsv6 preserved.\nModel CPU/NMI/chunk injection is software evidence, not a physical profile.\nPhysical C00/P06/B05/B06, service gaps, FIFO loss, read assertion/hold/fence, NMI and fastest stable method remain pending.\nSee host/s5-host-evidence.json, s5-front.txt, s5-pio.json; ultrags/logs/s5-run.json, s5-full.json, s5-firmware.json; S5-README.md.\n')
# Freshness rejection is exercised with the real verifier in s5-compare.py.
print('S5 HOST_PASS / DSS-EXE_PASS / REAL_PENDING:',host['checks'],'C checks;',len(runs),'EXE cases')
