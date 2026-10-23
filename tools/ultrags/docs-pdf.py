#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""A4 PDF from the sole Markdown source, with Cyrillic fonts, TOC and outline."""
import html, os, re, textwrap
from pathlib import Path
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
    Spacer, PageBreak, CondPageBreak, KeepTogether, LongTable, TableStyle, XPreformatted)
from reportlab.platypus.tableofcontents import TableOfContents
ROOT=Path(__file__).resolve().parents[2]
DOC=ROOT/'host/sprinter/ultrags/docs/ULTRAGS-PROGRAMMING.md'
OUT=ROOT/'build/ULTRAGS-PROGRAMMING.pdf'
# Explicit overrides make this renderer usable on Linux too.
fonts={
 'Body':os.environ.get('UG_DOC_FONT','/System/Library/Fonts/Supplemental/Arial.ttf'),
 'Bold':os.environ.get('UG_DOC_BOLD','/System/Library/Fonts/Supplemental/Arial Bold.ttf'),
 'Mono':os.environ.get('UG_DOC_MONO','/System/Library/Fonts/Supplemental/Andale Mono.ttf')}
for name,path in fonts.items():pdfmetrics.registerFont(TTFont(name,path))
pdfmetrics.registerFontFamily('Body',normal='Body',bold='Bold',italic='Body',boldItalic='Bold')
styles={
 'body':ParagraphStyle('body',fontName='Body',fontSize=10,leading=14,spaceAfter=7),
 'list':ParagraphStyle('list',fontName='Body',fontSize=10,leading=14,spaceAfter=4,leftIndent=16,bulletIndent=0,bulletFontName='Body',bulletFontSize=10),
 'cell':ParagraphStyle('cell',fontName='Body',fontSize=8,leading=10.5,splitLongWords=True),
 'code':ParagraphStyle('code',fontName='Mono',fontSize=8,leading=10,spaceAfter=0,leftIndent=5),
}
for level,sz in [(1,25),(2,18),(3,13),(4,11)]:
 styles['h'+str(level)]=ParagraphStyle('h'+str(level),fontName='Bold',fontSize=sz,leading=sz*1.2,spaceBefore=14,spaceAfter=9,keepWithNext=True,textColor=colors.HexColor('#173b59'))
def inline(s):
 s=html.escape(s)
 s=re.sub(r'\[([^]]+)\]\(([^)]+)\)',lambda m:('<a href="'+m[2]+'" color="#14628a">'+m[1]+'</a>') if '://' in m[2] else m[1],s)
 s=re.sub(r'`([^`]+)`',r'<font name="Mono">\1</font>',s)
 s=re.sub(r'\*\*(.*?)\*\*',r'<b>\1</b>',s)
 return s.replace('&amp;#124;','|')
W,H=A4; margin=43; width=W-margin*2
class Guide(BaseDocTemplate):
 def afterFlowable(self,f):
  if hasattr(f,'heading'):
   level,title,key=f.heading
   self.canv.bookmarkPage(key)
   self.canv.addOutlineEntry(title,key,level-1,False)
   if 2<=level<=3:self.notify('TOCEntry',(level-2,title,self.page,key))
def footer(c,d):
 c.saveState();c.setStrokeColor(colors.HexColor('#c2cdd5'));c.line(margin,35,W-margin,35)
 c.setFont('Body',8);c.setFillColor(colors.HexColor('#425969'))
 c.drawString(margin,23,'UltraGS • API 1.0 / VLS1');c.drawRightString(W-margin,23,str(d.page));c.restoreState()
doc=Guide(str(OUT),pagesize=A4,leftMargin=margin,rightMargin=margin,topMargin=42,bottomMargin=48,title='UltraGS: руководство программиста',author='PicoGUS / UltraGS project',invariant=1)
doc.addPageTemplates(PageTemplate(id='normal',frames=[Frame(margin,48,width,H-90,leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)],onPage=footer))
story=[];lines=DOC.read_text().splitlines();i=0;heading_count=0
while i<len(lines):
 line=lines[i];i+=1
 if not line.strip() or line.startswith('<!--'):continue
 if line.startswith('#'):
  m=re.match(r'(#+) (.*)',line);level=len(m[1]);title=m[2];heading_count+=1
  if level==2:
   story.append(PageBreak())
   if title.startswith('1.'):
    story.append(Paragraph('Оглавление',styles['h2']))
    toc=TableOfContents();toc.levelStyles=[ParagraphStyle('toc0',fontName='Body',fontSize=10,leading=12,spaceBefore=2),ParagraphStyle('toc1',fontName='Body',fontSize=9,leading=11,leftIndent=14,spaceBefore=0)]
    toc.tableStyle.add('TOPPADDING',(0,0),(-1,-1),1)
    toc.tableStyle.add('BOTTOMPADDING',(0,0),(-1,-1),1)
    story.extend([toc,PageBreak()])
  p=Paragraph(inline(title),styles['h'+str(min(level,4))]);p.heading=(level,title,'heading-'+str(heading_count));story.append(p);continue
 if line.startswith('```'):
  code_lines=[]
  while i<len(lines) and not lines[i].startswith('```'):
   # Visible continuation prefix; no source character is dropped.
   code=lines[i].expandtabs(4);i+=1
   pieces=textwrap.wrap(code,width=100,expand_tabs=False,replace_whitespace=False,drop_whitespace=False,break_long_words=True,break_on_hyphens=False) or [' ']
   for n,piece in enumerate(pieces):
    code_lines.append(html.escape(('    ' if n else '')+piece))
  i+=1
  block=XPreformatted('\n'.join(code_lines),styles['code'])
  story.append(KeepTogether([block]) if len(code_lines)<=24 else block)
  story.append(Spacer(1,8));continue
 if line.startswith('|'):
  rows=[line]
  while i<len(lines) and lines[i].startswith('|'):rows.append(lines[i]);i+=1
  cells=[]
  for row in rows:
   if re.match(r'^\|[\s:|\-]+$',row):continue
   cells.append([Paragraph(inline(x.strip()),styles['cell']) for x in re.split(r'(?<!\\)\|',row)[1:-1]])
  n=len(cells[0]);ratios={2:[.30,.70],3:[.16,.28,.56],4:[.12,.20,.12,.56],5:[.09,.28,.15,.10,.38]}.get(n,[1/n]*n)
  if 'ISA / Z80' in rows[0]:ratios=[.08,.27,.23,.21,.21]
  t=LongTable(cells,colWidths=[width*x for x in ratios],repeatRows=1,hAlign='LEFT')
  t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#dde9f0')),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#f5f7f9')]),('VALIGN',(0,0),(-1,-1),'TOP'),('LINEBELOW',(0,0),(-1,0),.5,colors.HexColor('#7994a5')),('LEFTPADDING',(0,0),(-1,-1),5),('RIGHTPADDING',(0,0),(-1,-1),5),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
  story.extend([KeepTogether([t]) if len(cells)<=6 else t,Spacer(1,9)]);continue
 item=re.match(r'^(-|\d+\.)\s+(.*)',line)
 paragraph=[item[2] if item else line]
 while i<len(lines) and lines[i].strip() and not lines[i].startswith(('#','|','```','<!--','- ')) and not re.match(r'^\d+\.\s',lines[i]):
  paragraph.append(lines[i]);i+=1
 p=Paragraph(inline(' '.join(paragraph)),styles['list'] if item else styles['body'],bulletText=item[1] if item else None)
 if line.startswith('**Запрос') or line.startswith('**Ответ'):
  # Leave room for the caption, header and first row, but allow a long
  # table to split instead of moving it whole and leaving half a page blank.
  story.append(CondPageBreak(80))
 story.append(p)
doc.multiBuild(story)
print(OUT)
