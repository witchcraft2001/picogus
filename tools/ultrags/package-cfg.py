#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Add the freshly built multifw and exact hashes beside the verified DSS disks."""
import argparse,hashlib,json,shutil,subprocess,sys
from pathlib import Path
from cfg_evidence import verify_multifw,verify_isa_reports
p=argparse.ArgumentParser();p.add_argument('--build',type=Path,required=True);p.add_argument('--compare-exe-dir',type=Path);a=p.parse_args()
r=Path(__file__).resolve().parents[2];b=a.build.resolve();out=b/'ultrags/cfg-package'
files=[]
def digest(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
bundle_evidence=verify_multifw(b/'multifw-release')
verification=subprocess.run(['node',str(r/'tools/ultrags/verify-package.mjs'),'--stage','CFG',
    '--exe-dir',str(b/'ultrags/dss'),'--fixtures',str(b/'ultrags/fixtures'),'--package',str(out)],
    capture_output=True,text=True)
if verification.returncode:
    raise ValueError('CFG package verification failed:\n'+verification.stdout+verification.stderr)
print('CFG ZIP/IMG current source/build/execution identity PASS')
# These are required gates, not optional reports that can be omitted while
# the high-level C/EXE mocks still pass. Reject missing or stale inputs/output.
isa_reports=verify_isa_reports(b)
print('Linked ARM / generated PIO / PSRAM READ ID / core1 fuse required gates PASS')
for source,h in json.loads((b/'host/config-exchange-inputs.json').read_text()).items():
    source=Path(source);assert digest(source if source.is_absolute() else r/source)==h,source

def add(src,name):
    shutil.copyfile(src,out/name);data=(out/name).read_bytes()
    files.append(dict(name=name,size=len(data),sha256=hashlib.sha256(data).hexdigest()))
add(b/'multifw-release/picogus.uf2','PGMULTI.UF2')
add(b/'multifw-release/generated/multifw/flash-map.json','FLASHMAP.JSN')
add(r/'host/sprinter/ultrags/docs/CFG-FIX.md','TESTER.TXT')
add(r/'host/sprinter/ultrags/docs/CFG-REVIEW.md','REVIEW.TXT')
add(r/'host/sprinter/ultrags/docs/CFG-REAL-FAIL.md','REALFAIL.TXT')
add(r/'ultra-gs-docs/ultra-gs.md','SPEC.TXT')
for src,name in [(isa_reports[0],'ISAPATH.JSN'),(isa_reports[1],'PIOISA.JSN'),(isa_reports[2],'GUARD.JSN'),(isa_reports[3],'PSRAMID.JSN'),
                 (b/'host/firmware-paths/REPORT.md','ISAPATH.TXT'),
                 (b/'host/firmware-paths/gus-paths.dis','GUSARM.TXT'),
                 (b/'host/firmware-paths/ultrags-paths.dis','ULTRARM.TXT')]:
    add(src,name)
for name in ['ug-cfg.zip','ug-cfg.img']:
    data=(out/name).read_bytes();files.append(dict(name=name,size=len(data),sha256=hashlib.sha256(data).hexdigest()))
exes=json.loads((b/'ultrags/dss/asm-manifest.json').read_text())['files']
comparison=None
if a.compare_exe_dir:
    other=a.compare_exe_dir.resolve()
    subprocess.run(['node','--input-type=module','-e',
        "const {pathToFileURL}=await import('node:url');const {verifyBuild}=await import(pathToFileURL(process.argv[1]));verifyBuild(process.argv[2],process.argv[3]);",
        str(r/'tools/ultrags/build-evidence.mjs'),str(r),str(other)],check=True)
    other_exes=json.loads((other/'asm-manifest.json').read_text())['files']
    assert other_exes==exes, 'second assembly EXE set differs'
    for entry in exes:
        assert digest(other/entry['name'])==entry['sha256'], 'second assembly differs: '+entry['name']
    comparison=dict(directory=str(other),matched_exes=len(exes))
    other_firmware=other.parent.parent/'multifw-release'
    if other_firmware.is_dir():
        other_evidence=verify_multifw(other_firmware)
        assert other_evidence['sha256']==bundle_evidence['sha256'], 'second MULTIFW build differs'
        comparison['firmware']=dict(directory=str(other_firmware),sha256=other_evidence['sha256'])
        other_package=other.parent/'cfg-package'
        checked=subprocess.run(['node',str(r/'tools/ultrags/verify-package.mjs'),'--stage','CFG',
            '--exe-dir',str(other),'--fixtures',str(other.parent/'fixtures'),'--package',str(other_package)],
            capture_output=True,text=True)
        if checked.returncode:
            raise ValueError('second CFG package verification failed:\n'+checked.stdout+checked.stderr)
        comparison['containers']=[]
        for name in ['ug-cfg.zip','ug-cfg.img']:
            assert digest(other_package/name)==digest(out/name), 'independent package differs: '+name
            comparison['containers'].append(dict(name=name,sha256=digest(out/name)))
# Always replace an earlier build's proof, including when no second assembly
# is requested. It must never survive as a stale unlisted REPRO.JSN sidecar.
repro=dict(firmware_sha256=bundle_evidence['sha256'],containers=[e for e in files if e['name'] in ['ug-cfg.zip','ug-cfg.img']],
           executed_exes=[dict(name=e['name'],sha256=e['sha256']) for e in exes],second_assembly=comparison)
data=(json.dumps(repro,indent=2)+'\n').encode();(out/'REPRO.JSN').write_bytes(data)
files.append(dict(name='REPRO.JSN',size=len(data),sha256=hashlib.sha256(data).hexdigest()))
main=json.loads((b/'ultrags/logs/ugdiag-run.json').read_text())
for log in ['s2-run.json','config-regression.json','turbo-contract.json']:
    report=json.loads((b/'ultrags/logs'/log).read_text())
    assert report['results'] and all(x['ok'] for x in report['results']),log
    script={'config-regression.json':'config-regression.mjs','turbo-contract.json':'turbo-contract.mjs'}.get(log)
    if script: assert report['scriptSha256']==hashlib.sha256((r/'tests/ultrags/dss'/script).read_bytes()).hexdigest()
    if log!='turbo-contract.json':
        assert report['catalogSha256']==digest(b/'multifw-release/generated/multifw/catalog.bin'), 'wrong catalogue in '+log
    else:
        assert report['inputs']==main['executionInputs'], 'stale Turbo model inputs'
        assert report['buildInputs']==main['buildInputs'], 'stale Turbo assembly inputs'
    if log=='s2-run.json':
        assert report['scriptSha256']==digest(r/'tests/ultrags/dss/run-s2.mjs'), 'stale UGCFG runner'
        assert report['productionTraceSha256']==digest(b/'host/config-exchange.json'), 'stale C trace'
        assert report['productionInputsSha256']==digest(b/'host/config-exchange-inputs.json'), 'stale C inputs'
    for e in report['executed']:
        assert any(f['name']==e['name'] and f['sha256']==e['sha256'] for f in exes),e
    add(b/'ultrags/logs'/log,{'s2-run.json':'CFGTEST.JSN','config-regression.json':'MATRIX.JSN','turbo-contract.json':'TURBO.JSN'}[log])
add(b/'host/config-exchange-inputs.json','CSOURCE.JSN')
add(b/'host/config-exchange.json','CTRACE.JSN')
main=json.loads((b/'ultrags/logs/ugdiag-run.json').read_text())
assert main['fail']==0 and main['pass']>0
summary={}
for log in ['s2-run','config-regression','turbo-contract']:
    rows=json.loads((b/'ultrags/logs'/(log+'.json')).read_text())['results']
    summary[log]=len(rows)
cache=(b/'multifw-release/CMakeCache.txt').read_text().splitlines()
compiler=next(line.split('=',1)[1] for line in cache if line.startswith('CMAKE_C_COMPILER:'))
def version(args): return subprocess.check_output(args,stderr=subprocess.STDOUT,text=True).splitlines()[0]
versions={'arm_gcc':version([compiler,'--version']),'node':version(['node','--version']),
          'host_cc':version(['cc','--version']),
          'sjasmplus':version(['sjasmplus','--version']),'cmake':version(['cmake','--version']),
          'python':sys.version.split()[0]}
report='\n'.join([
 'UGCFG configuration correction - 2026-10-18',
 'HOST_PASS / DSS-EXE_PASS / REAL_PENDING; S7 IN_PROGRESS (not accepted).',
 'Firmware: early BASE/ALIAS PIO read wait; inline ARM decode; direct STATUS/response; IOW before IOR; native write IO_WAIT before work.',
 'Reflash this PGMULTI.UF2; S7-review UF2 is an older image. Firmware/EXE hashes are in HASHES.TXT.',
 'Finite decode-delay injection rejects the previous IOR ordering; physical timing margins remain REAL_PENDING.',
 'Linked ARM polling loops/callees and compiled PIO bytes verified. PIO0 uses 32/32 words; runtime comparisons update before write acknowledgement.',
 'Generated PIO executes all 256 BASE/ALIAS maps and 1024 addresses, delayed INFO/CRC, full RX stalls and IOW DACK/ADS. A core1 timer releases a stuck read independently of core0.',
 'Actual native IOW/IOR + INFO framing/CRC run together; lost length and IO_END-only write mutations rejected on 16 BASE maps.',
 'Config port differential: production picogus.cpp branches + ug_config.c, actual MULTIFW catalogue.',
 'Wrong magic port and unconfirmed selector mutations fail against corrected models.',
 'MODE -> one REBOOT -> active/boot/INFO/READY verification -> one SAVE.',
 'No Flash write after failed startup verification; uncertain SAVE is never replayed.',
 'Actual EXE matrix: slots 0/1, EI/DI, PAGE3, software/hardware Turbo, DSS clobbers.',
 'CRC/layout/fallback/late-ready/dropped select/SAVE errors/power cycles/ESC/stopped clocks tested in model.',
 f'Full actual-EXE regression: {main["pass"]} passed, {main["fail"]} failed.',
 'Focused counts: '+json.dumps(summary,sort_keys=True),
 'Versions: '+json.dumps(versions,sort_keys=True),
 'DSS ZIP/IMG: independent extraction, exact executed hashes, 8.3 names, deterministic repeat and tamper tests.',
 'No physical Sprinter, IOCHRDY, PSRAM or audio acceptance is claimed.',
 'See TESTER.TXT for Russian hardware commands and HASHES.TXT for exact UF2/EXE hashes.',
 'SPEC.TXT is the updated local ignored ultra-gs-docs/ultra-gs.md.',
 'Reproduce: make -f Makefile.ultrags cfg-package BUILD=build/cfg-native-a',
 'Use SDK/extras/GCC/Python environment from specification 13.2.1; logs stay in build/.',
])+'\n'
(out/'REPORT.TXT').write_text(report)
files.append(dict(name='REPORT.TXT',size=len(report.encode()),sha256=hashlib.sha256(report.encode()).hexdigest()))
(out/'HASHES.TXT').write_text('\n'.join(f"{x['sha256']}  {x['name']}" for x in files+exes)+'\n')
(out/'manifest.json').write_text(json.dumps(dict(status='HOST_PASS / DSS-EXE_PASS / REAL_PENDING; S7 IN_PROGRESS',files=files,executed_exes=exes,versions=versions,checks=summary,multifw=bundle_evidence,multifw_verifier_sha256=digest(r/'tools/ultrags/cfg_evidence.py')),indent=2)+'\n')
print('CFG bundle: fresh PGMULTI + verified EXE/ZIP/IMG, REAL_PENDING; S7 IN_PROGRESS')
