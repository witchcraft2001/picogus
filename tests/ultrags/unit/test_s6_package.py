# SPDX-License-Identifier: GPL-2.0-or-later
"""Reject rehashed substitutions and omitted provenance, beyond manifest checks."""
import argparse, hashlib, json, shutil, subprocess, tempfile
from pathlib import Path

p=argparse.ArgumentParser(); p.add_argument('--build',type=Path,required=True); a=p.parse_args()
root=Path(__file__).resolve().parents[3]; build=a.build.resolve(); original=build/'ultrags/s6-package'
verifier=root/'tools/ultrags/verify-s6-package.mjs'
def verify(package, expected):
    result=subprocess.run(['node',str(verifier),'--build',str(build),'--package',str(package)],capture_output=True,text=True)
    assert (result.returncode==0)==expected, result.stdout+result.stderr

verify(original,True)
with tempfile.TemporaryDirectory(prefix='ultrags-s6-package-') as directory:
    temp=Path(directory)
    for name in ('PGULTRA.UF2','s6-storage-host','s6-pcm-host','s6-render-host','s6-math-host','s6-device-host',
                 's6-host-evidence.json','firmware-evidence.json','REPORT-S6.txt','s6-storage.log',
                 'fixtures/raw-u8-mono-11025.raw','UGPLAY.EXE','UGMON.EXE','ug-s6.zip','ug-s6.img',
                 's6-run.json','s6-commands.jsonl','s6-audio.s16le','s6-audio-index.jsonl'):
        package=temp/'package'; shutil.copytree(original,package)
        file=package/name; data=bytearray(file.read_bytes()); data[len(data)//2]^=1; file.write_bytes(data)
        manifest=json.loads((package/'manifest.json').read_text())
        for record in manifest['files']:
            if record['name']==name: record['sha256']=hashlib.sha256(data).hexdigest()
        (package/'manifest.json').write_text(json.dumps(manifest))
        verify(package,False); shutil.rmtree(package)
    package=temp/'package'; shutil.copytree(original,package)
    (package/'PGULTRA.UF2').unlink()
    manifest=json.loads((package/'manifest.json').read_text())
    manifest['files']=[f for f in manifest['files'] if f['name']!='PGULTRA.UF2']
    (package/'manifest.json').write_text(json.dumps(manifest)); verify(package,False)
    # Empty provenance used to pass vacuous loops in the report generator.
    for file in (build/'host/s6/s6-host-evidence.json',build/'ultrags-release/pg-ultrags.evidence.json'):
        saved=file.read_bytes()
        try:
            ev=json.loads(saved); ev['inputs']={}; file.write_text(json.dumps(ev))
            verify(original,False)
        finally: file.write_bytes(saved)
verify(original,True)
print('S6 package negatives PASS: 18 rehashed substitutions, omitted UF2, empty HOST/firmware inputs rejected')
