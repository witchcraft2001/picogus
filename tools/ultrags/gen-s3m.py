#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Original deterministic PCM S3M fixtures. No third-party music."""
import math, struct, sys
from pathlib import Path

def module(patterns=None, orders=None, channels=1, stereo=False, bits=8, signed=False,
           speed=6, version=0x1321, flags=0, pan=None, instruments=1, c2spd=8363):
    if patterns is None:
        patterns = [{0:[(c,0x40,1,48,0,0) for c in range(channels)],8:[(0,255,0,255,3,0)]}]
    if orders is None: orders=list(range(len(patterns)))+[255]
    b=bytearray(96+len(orders)+2*(instruments+len(patterns))+(32 if pan is not None else 0))
    b[:18]=b'UltraGS S3M tests!';b[28:30]=b'\x1a\x10'
    struct.pack_into('<6H',b,32,len(orders),instruments,len(patterns),flags,version,1 if signed else 2)
    b[44:48]=b'SCRM';b[48:54]=bytes([64,speed,125,0x80|48,0,252 if pan is not None else 0])
    b[64:96]=bytes([0 if c%4 in (0,3) else 8 for c in range(channels)]+[255]*(32-channels))
    b[96:96+len(orders)]=bytes(orders)
    if pan is not None:b[-32:]=bytes([0x20|pan]*32)
    def align():
        b.extend(bytes((-len(b))%16));return len(b)
    headers=[]
    for ins in range(instruments):
        off=align();struct.pack_into('<H',b,96+len(orders)+2*ins,off//16);headers.append(off);b.extend(bytes(80))
    for index,rows in enumerate(patterns):
        if rows is None:continue
        packed=bytearray()
        for row in range(64):
            for c,n,i,v,f,a in rows.get(row,[]):packed.extend([c|224,n,i,v,f,a])
            packed.append(0)
        off=align();struct.pack_into('<H',b,96+len(orders)+2*(instruments+index),off//16)
        b.extend(struct.pack('<H',len(packed)+2)+packed)
    for ins,h in enumerate(headers):
        off=align();n=8192
        b[h]=1;b[h+13]=off>>20;struct.pack_into('<H',b,h+14,(off>>4)&65535)
        struct.pack_into('<III',b,h+16,n,16,n);b[h+28]=48;b[h+31]=1|(2 if stereo else 0)|(4 if bits==16 else 0)
        struct.pack_into('<I',b,h+32,c2spd);b[h+76:h+80]=b'SCRS'
        for side in range(2 if stereo else 1):
            for k in range(n):
                # Distinct planes and symmetric values detect sign/order errors.
                v=round(math.sin(k*math.tau/(32 if side else 64))*(12000 if bits==16 else 47))
                if not signed:v+=32768 if bits==16 else 128
                b.extend(struct.pack('<H',v&65535) if bits==16 else bytes([v&255]))
    return bytes(b)

def generate(out):
    out.mkdir(parents=True,exist_ok=True)
    for stereo in (False,True):
        for bits in (8,16):
            for signed in (False,True):
                name=f'{"ST" if stereo else "MO"}{"S" if signed else "U"}{bits}'
                (out/(name+'.S3M')).write_bytes(module(stereo=stereo,bits=bits,signed=signed,pan=8))
    effects={'A':0x03,'A255':255,'A00':0,'D':0x03,'DFINE':0x2f,'DFINE_DN':0xf2,'D0F':15,'DF0':240,
             'E':0x04,'EFINE':0xf4,'EEXTRA':0xe4,'F':0x04,'FFINE':0xf4,'FEXTRA':0xe4,
             'G':0x08,'H':0x47,'I':0x32,'J':0x37,'K':0x02,'L':0x02,'O':0x02,
             'Q':0x93,'R':0x47,'T':0x91,'U':0x47,'V':32,'X':0x60,
             'S1':0x11,'S2':0x28,'S3':0x31,'S4':0x41,'S8':0x84,'SC':0xc3,'SD':0xd3,'SE':0xe2}
    for name,arg in effects.items():
        fx=ord(name[0])-64
        rows={0:[(0,0x40,1,48,8,0x47)],1:[(0,0x44 if fx in (7,12) else 255,0,255,fx,arg)],
              2:[(0,255,0,255,fx,0)],3:[(0,0x43,1,40,fx,arg)],8:[(0,255,0,255,3,0)]}
        (out/(name+'.S3M')).write_bytes(module(patterns=[rows],pan=8))
    for wave in (0,1,2):
        for effect in (8,18):
            sub=3 if effect==8 else 4
            rows={0:[(0,0x40,1,48,19,sub*16+wave)],1:[(0,255,0,255,effect,0x47)],2:[(0,255,0,255,effect,0)],8:[(0,255,0,255,3,0)]}
            (out/f'W{effect}_{wave}.S3M').write_bytes(module(patterns=[rows],pan=8))
    for tune in (0,7,15):
        (out/f'TUNE{tune}.S3M').write_bytes(module(patterns=[{0:[(0,0x40,1,48,19,0x20+tune)],8:[(0,255,0,255,3,0)]}],pan=8))
    for rate in (7895,16000,48000):
        (out/f'RATE{rate}.S3M').write_bytes(module(c2spd=rate))
    for note in (0,0x80):
        (out/f'AMIGA{note}.S3M').write_bytes(module(patterns=[{0:[(0,note,1,48,0,0)],8:[(0,255,0,255,3,0)]}],flags=16))
    for shape in (0x11,0x61,0x71,0xe1,0xf1):
        (out/f'Q{shape:02X}.S3M').write_bytes(module(patterns=[{0:[(0,0x40,1,48,17,shape)],1:[(0,255,0,255,17,0)],8:[(0,255,0,255,3,0)]}],pan=8))
    (out/'GLISS.S3M').write_bytes(module(patterns=[{0:[(0,0x40,1,48,19,0x11)],1:[(0,0x47,0,255,7,8)],2:[(0,255,0,255,7,0)],8:[(0,255,0,255,3,0)]}],pan=8))
    (out/'ST300.S3M').write_bytes(module(patterns=[{0:[(0,0x40,1,48,4,3)],1:[(0,255,0,255,4,0)],8:[(0,255,0,255,3,0)]}],version=0x1300))
    (out/'LOOP.S3M').write_bytes(module(patterns=[{0:[(0,0x40,1,48,19,0xb0)],2:[(0,255,0,255,19,0xb2)],3:[(0,255,0,255,3,0)]}]))
    (out/'FLOW.S3M').write_bytes(module(patterns=[{0:[(0,0x40,1,48,2,2)]},None,{0:[(0,255,0,255,3,0x12)]},None],orders=[0,254,2,3,255]))
    for ch in (4,16,17,31,32):
        (out/f'M{ch}.S3M').write_bytes(module(channels=ch))
        (out/f'S{ch}.S3M').write_bytes(module(channels=ch,stereo=True))
    sparse=bytearray(module(channels=32));sparse[65:95]=bytes([255])*30
    (out/'SPARSE.S3M').write_bytes(sparse)
    # Duplicate partial fields are merged, not duplicated at playback time.
    (out/'DUP.S3M').write_bytes(module(patterns=[{0:[(0,0x40,1,48,0,0),(0,0x43,1,32,8,0x47)],8:[(0,255,0,255,3,0)]}]))
    mixed=bytearray(module(patterns=[{0:[(0,0x40,1,32,0,0),(1,255,2,48,0,0)],1:[(0,255,0,255,2,1)]},{0:[(1,0x47,0,255,0,0)],8:[(0,255,0,255,3,0)]}],channels=2,instruments=2,stereo=True))
    ih=struct.unpack_from('<H',mixed,99)[0]*16;mixed[ih+31]&=~2
    (out/'MEMORY.S3M').write_bytes(mixed)
    (out/'LIMITS.S3M').write_bytes(module(patterns=[None]*254,orders=[253]*255+[255],instruments=255))
    (out/'DEMO.S3M').write_bytes(module(patterns=[{r:[(c,0x40+(r//4+c*3)%12,1,24,0,0) for c in range(4)] for r in range(0,64,4)}],channels=4,pan=8))
if __name__=='__main__':generate(Path(sys.argv[1]))
