#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Independent zlib oracle for every supported block length and chained tails."""
import random, runpy, zlib
from pathlib import Path
root=Path(__file__).resolve().parents[3]
g=runpy.run_path(str(root/'tools/ultrags/gen-crc-combine.py'))
assert (root/'host/sprinter/ultrags/lib/ugcrc_combine_table.asm').read_text()==g['assembly']()
matrices=list(g['operators']())
def combine(a,b,n):
    bit=0
    while n:
        if n&1:a=g['multiply'](matrices[bit],a)
        n>>=1;bit+=1
    return a^b
rng=random.Random(0x55475331)
prefix=rng.randbytes(317)
for n in range(1,1025):
    data=rng.randbytes(n)
    assert combine(zlib.crc32(prefix),zlib.crc32(data),n)==zlib.crc32(prefix+data)
for total in (0,1,7,255,256,257,1023,1024,1025,65537,8388608):
    data=rng.randbytes(total);value=0
    for off in range(0,total,1024):
        block=data[off:off+1024];value=combine(value,zlib.crc32(block),len(block))
    assert value==zlib.crc32(data)
print('CRC combine: generated ASM table, all1024 lengths, exact8-MiB chaining/tails vs zlib PASS')
