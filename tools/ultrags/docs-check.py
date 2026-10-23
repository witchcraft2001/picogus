#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Document/PDF integrity and reproducible source manifest (not hardware proof)."""
import hashlib,json,re,subprocess
from pathlib import Path
import pdfplumber
from pypdf import PdfReader
ROOT=Path(__file__).resolve().parents[2]; OUT=ROOT/'build/host/docs'
subprocess.run(['python3',str(ROOT/'tools/ultrags/docs-sync.py'),'--check'],check=True)
doc=ROOT/'host/sprinter/ultrags/docs/ULTRAGS-PROGRAMMING.md'
pdf=ROOT/'build/ULTRAGS-PROGRAMMING.pdf';reader=PdfReader(pdf)
published=doc.with_suffix('.pdf')
assert published.is_file() and published.read_bytes()==pdf.read_bytes(),'Repository PDF differs from the build; run make -f Makefile.ultrags docs'
assert reader.outline,'Missing PDF bookmarks'
issues=[];extracted=[]
with pdfplumber.open(pdf) as p:
 for n,page in enumerate(p.pages,1):
  assert abs(page.width-595.276)<1 and abs(page.height-841.89)<1
  extracted.append(page.crop((0,0,page.width,page.height-40)).extract_text() or '')
  for c in page.chars:
   if c['x0']<40 or c['x1']>page.width-40 or c['top']<30 or c['bottom']>page.height-15:issues.append([n,c['text'],c['x0'],c['top']])
  for font in reader.pages[n-1]['/Resources']['/Font'].get_object().values():
   f=font.get_object()
   # ReportLab's unused default Helvetica resource is harmless.
   if '/FontDescriptor' in f:
    d=f['/FontDescriptor'].get_object();assert '/FontFile2' in d or '/FontFile3' in d
assert not issues,issues[:20]
text='\n'.join(extracted);flat=re.sub(r'\s','',text)
assert '\ufffd' not in text and 'Оглавление' in text
for listing in re.findall(r'<!-- (?:source|excerpt|snippet):.*?-->\s*```asm\n(.*?)```',doc.read_text(),re.S):
 assert re.sub(r'\s','',listing) in flat,'Missing or reordered code in PDF'
paths={doc,pdf,published,ROOT/'README.md'}
for folder in ['host/sprinter/ultrags','sw/ultrags','common','tests/ultrags/dss']:
 paths.update(p for p in (ROOT/folder).rglob('*') if p.is_file())
paths.update((ROOT/'tools/ultrags').glob('docs-*'))
paths.update([ROOT/'tools/ultrags/wire-schema.json',ROOT/'ultra-gs-docs/ultra-gs.md',ROOT/'Makefile.ultrags',ROOT/'tools/ultrags/requirements-docs.txt'])
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
result={'status':'HOST_PASS; REAL_PENDING','revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'pages':len(reader.pages),'checks':['Markdown schema and listings match','local links resolve','repository PDF matches build','PDF A4 and outline','embedded TrueType fonts','all glyph bounds inside page','every source listing preserved in extracted PDF'],'source_sha256':{str(p.relative_to(ROOT)):sha(p) for p in sorted(paths)},'historical_sources':{p.name:sha(p) for p in sorted((OUT/'sources').glob('*')) if p.suffix in ('.odt','.pdf')},'execution':json.loads((OUT/'examples-check.json').read_text()),'wire':json.loads((OUT/'wire-check.json').read_text()),'tool_versions':{'python':subprocess.check_output([__import__('sys').executable,'--version'],text=True).strip(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'reportlab':__import__('reportlab').Version},'commands':['make -f Makefile.ultrags docs-check'],'limits':['Functional Z80/production-C model, no new hardware result','Raster pages require human visual inspection','External links checked on acquisition, not required for offline build']}
(OUT/'check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print('PDF checks PASS:',len(reader.pages),'pages')
