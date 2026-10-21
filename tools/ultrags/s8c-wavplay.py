#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Read-only checks of the supplied Sprinter WAVPLAY executable."""
import argparse,hashlib,json,struct
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('exe',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
b=a.exe.read_bytes();assert b[:4]==b'EXE\0';header=struct.unpack_from('<H',b,4)[0];load=struct.unpack_from('<H',b,16)[0]
assert (header,load)==(22,0x8100)
def code(addr,n):return b[header+addr-load:header+addr-load+n]
assert code(0x8770,11)==bytes.fromhex('e51100200e133a4588d7e1') # READ 8192
assert code(0x8421,16)==bytes.fromhex('11f085ed53ffa03ea0ed47ed5e3a4688') # IM2 -> 85f0
assert code(0x8405,8)==bytes.fromhex('014e00ed79014f00') # CBL programming
assert code(0x85f0,2)==bytes.fromhex('f3f5') and code(0x8639,3)==bytes.fromhex('fbed4d')
a.out.parent.mkdir(parents=True,exist_ok=True)
a.out.write_text(json.dumps(dict(status='STATIC_EXE_PASS / physical cost unmeasured',exe=str(a.exe.resolve()),sha256=hashlib.sha256(b).hexdigest(),bytes=len(b),load_address=load,read_bytes=8192,read_routine='8770h',irq='IM2 -> 85F0h',cbl_ports=['004Eh','004Fh'],comparison='UGPLAY/UGPF retain 4096-byte READ and single-RPC FEED. SYSTIME/CMOS, ACK and disk/ISA costs require physical measurement.',checker_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()),indent=2)+'\n')
print('WAVPLAY supplied EXE: 8 KiB DSS READ / CBL / IM2 handler PASS; physical costs pending')
