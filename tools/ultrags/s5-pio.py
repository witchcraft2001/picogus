#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute generated PIO opcodes. Timing is a PIO model, never REAL ISA evidence."""
import argparse,json,re,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--header',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
text=a.header.read_text();checks=0;traces=[]
for name in ['ug_posted_iow','ug_posted_iow_no_dack']:
    body=re.search(rf'{name}_program_instructions\[\] = {{(.*?)}};',text,re.S)[1]
    code=[int(n,16) for n in re.findall(r'^\s*(0x[0-9a-f]+),',body,re.M)]
    assert len(code)==8 and all(w>>13!=3 for w in code)
    class SM:
        def __init__(self):self.pc=0;self.delay=0;self.ads=0;self.isr=0;self.fifo=[];self.stall=False;self.pushes=0
        def step(self,iow,addr,data,dack=False):
            if self.delay:self.delay-=1;return
            w=code[self.pc];op=w>>13;delay=(w>>8)&7
            if w&0x1000:self.ads=(w>>11)&1
            advance=True
            if op==1:advance=bool(iow)==bool(w&128)
            elif op==0:
                if ((w>>5)&7)==6 and dack:self.pc=w&31;return
                # NOP is MOV Y,Y, op5.
            elif op==2:
                bits=w&31;self.isr=((self.isr<<bits)|(data if self.ads and bits==8 else addr))&0xffffffff
            elif op==4:
                if len(self.fifo)==8:self.stall=True;advance=False
                else:self.fifo.append(self.isr);self.isr=0;self.pushes+=1;assert self.ads==0
            elif op==5:pass
            else:raise AssertionError(('unexpected opcode',w))
            if advance:self.pc=(self.pc+1)%len(code);self.delay=delay
    for low in [16,32,128,1024]:
        sm=SM()
        for _ in range(8):sm.step(1,0x2a0,0x5a)
        for _ in range(low):sm.step(0,0x2a0,0x5a)
        assert sm.pushes==1 and sm.fifo==[0x2a05a];checks+=1
    sm=SM()
    for i in range(9):
        for _ in range(8):sm.step(1,0x200+i,i)
        for _ in range(24):sm.step(0,0x200+i,i)
    assert len(sm.fifo)==8 and sm.stall and sm.ads==0;checks+=1
    sm.fifo.pop(0);sm.step(0,0x208,8);assert sm.pushes==9;checks+=1
    for q in range(9):
        sm=SM()
        for i in range(q):
            for _ in range(8):sm.step(1,0x280+((i*13)&31),i)
            for _ in range(24):sm.step(0,0x280+((i*13)&31),i)
        assert len(sm.fifo)==q;checks+=1
    sm=SM()
    for _ in range(8):sm.step(1,0x2a0,7,True)
    for _ in range(64):sm.step(0,0x2a0,7,True)
    assert sm.pushes==(name.endswith('no_dack'));checks+=1
    init=re.search(rf'void {name}_program_init\(.*?\n}}',text,re.S)[0]
    assert 'PIO_FIFO_JOIN_RX' in init and 'sm_config_set_out_shift' not in init
    assert 'IOCHRDY' not in init and 'sm, 27, 1, true' in init;checks+=1
    traces.append({'program':name,'instructions':code,'length':len(code),'rx_words':8,'long_iow':'single_capture','overflow':'RXSTALL','ADS_before_push':0,'write_TX_IOCHRDY':False})
a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(json.dumps({'checks':checks,'inputs':{str(p.resolve()):hashlib.sha256(p.read_bytes()).hexdigest() for p in [a.header,Path(__file__),Path(__file__).resolve().parents[2]/'sw/ultrags/ug_posted_iow.pio']},'level':'HOST_PIO_MODEL','programs':traces},indent=2)+'\n');print('S5 generated PIO HOST_PASS:',checks)
