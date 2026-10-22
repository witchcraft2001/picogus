#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Linked CONFIG FIFO-to-WAIT regression. Synthetic instruction deadlines only.

R14's old test called capture directly. Exercise the preceding has_read and
take_read as well, on the delivered machine code and its generated PIO tail.
This is still not a full boot, main-loop latency or electrical timing model.
"""
import argparse, importlib.util, json, re, struct, subprocess
from functools import lru_cache
from pathlib import Path
from unicorn import UC_HOOK_MEM_READ
from unicorn.arm_const import UC_ARM_REG_R0, UC_ARM_REG_R10, UC_ARM_REG_SP

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('config_arm', ROOT/'tools/ultrags/config-read-arm.py')
arm = importlib.util.module_from_spec(spec); spec.loader.exec_module(arm)

@lru_cache(None)
def old_decode_fragment(elf,nm):
    dis=subprocess.check_output([nm.replace('-nm','-objdump'),'-d',str(elf)],text=True)
    main=dis.split('<main>:',1)[1].split('\n\n',1)[0]
    # Execute R14's real main instructions between take_read and capture.
    # Its earlier test omitted this port/tag decode and the call boundary.
    tail=main.split('<ug_handshake_take_read>\n',1)[1]
    start=int(re.match(r'([0-9a-f]+):',tail)[1],16)
    call=re.search(r'([0-9a-f]+):[^\n]*\bbl\s+[^\n]*<ug_handshake_capture>',tail)
    fragment=tail[:call.end()]
    assert 'mov\tr3, sl' in fragment and 'ldr\tr3, [sp, #8]' in fragment
    return start,int(call[1],16)+4

def run(fw, nm, port, deadline, old=False, queued=False, expired=False):
    m = arm.ConfigRead(fw/'pg-ultrags-multifw.elf', nm, fw/'ug_handshake_ior.pio.h', port, deadline=deadline)
    # Other SM is idle. Late CONFIG cleanup may freeze it to arbitrate WAIT.
    m.uc.mem_write(0x502000d4, struct.pack('<I', m.labels['write_restart']))
    # A real raw address/strobe snapshot, as produced by this ELF's PIO.
    raw = ((port & 31) << 27) | (port >> 5) | (1 << 25)
    fifo = [raw]
    def read(uc, access, address, size, value, _):
        if address == 0x50200004: uc.mem_write(address, struct.pack('<I', 0 if fifo else 1 << 9))
        if address == 0x50200024: uc.mem_write(address, struct.pack('<I', fifo.pop(0)))
    m.uc.hook_add(UC_HOOK_MEM_READ, read, begin=0x50200000, end=0x502000ff)
    if queued:
        fifo.clear()
        m.uc.mem_write(m.sym.get('ug_handshake_read_queued',m.sym.get('read_queued')), b'\1')
        m.uc.mem_write(m.sym['read_snapshot'], struct.pack('<I', raw))
        m.uc.mem_write(m.sym['read_reg'], struct.pack('<i', -1))
    if expired: m.advance(deadline+4)
    assert m.call('ug_handshake_has_read', [])
    assert m.call('ug_handshake_take_read', [m.OUT, m.OUT+4]) == raw
    if old:
        start,end=old_decode_fragment(fw/'pg-ultrags-multifw.elf',nm)
        # The frozen main keeps the port destination in r10 and the owned
        # byte destination at SP+8. Match those operands, not a guessed delay.
        m.uc.reg_write(UC_ARM_REG_R0,raw)
        m.uc.reg_write(UC_ARM_REG_R10,m.OUT+8)
        m.uc.reg_write(UC_ARM_REG_SP,m.STACK)
        m.uc.mem_write(m.STACK+8,struct.pack('<I',m.OUT+12))
        m.uc.emu_start(start|1,end,count=10000)
        service=m.uc.reg_read(UC_ARM_REG_R0)
    else: service = m.uc.mem_read(m.OUT+4, 1)[0]
    m.advance(4096)
    delivered = bool(m.call('ug_handshake_reply', [0xff24])) if service else False
    if not service: m.call('ug_handshake_put', [1, 0])
    m.advance(deadline+512)
    assert not fifo and not m.sm.dirs and not m.sm.hold and not m.sm.ads
    return dict(port=port, deadline=deadline, queued=queued, expired=expired,
                sampled=m.sample, delivered=delivered, first_wait_tick=m.first_hold)

def main():
    p=argparse.ArgumentParser(); p.add_argument('--build', type=Path, required=True)
    a=p.parse_args(); b=a.build.resolve(); fw=b/'multifw-release'
    old=ROOT/'build/gs-turbo-r14-failure/build/multifw-release'
    nm=re.search(r'^CMAKE_NM:[^=]+=(.*)$', (fw/'CMakeCache.txt').read_text(), re.M)[1]
    rows=[]
    for port in (0x1d0, 0x1d1, 0x1d2):
        for queued in (False, True):
            before=run(old,nm,port,10000,old=True,queued=queued)
            after=run(fw,nm,port,10000,queued=queued)
            assert after['first_wait_tick'] < before['first_wait_tick'], (before,after)
            # Fixed synthetic window, shared by all ports and queue states.
            # Do not derive a per-case deadline which forces R14 to fail.
            deadline=80
            negative=run(old,nm,port,deadline,old=True,queued=queued)
            positive=run(fw,nm,port,deadline,queued=queued)
            stale=run(fw,nm,port,deadline,queued=queued,expired=True)
            assert negative['sampled']==(36 if queued else 255) and negative['delivered']==queued, negative
            assert positive['sampled']==36 and positive['delivered'], positive
            assert stale['sampled']==255 and not stale['delivered'] and stale['first_wait_tick'] is None, stale
            short=run(fw,nm,port,48,queued=queued)
            ample=run(old,nm,port,128,old=True,queued=queued)
            assert short['sampled']==255 and not short['delivered'], short
            assert ample['sampled']==36 and ample['delivered'], ample
            rows.append(dict(before=before,after=after,negative=negative,positive=positive,stale=stale,short=short,ample=ample))
    files=[Path(__file__), ROOT/'tools/ultrags/config-read-arm.py',ROOT/'tools/ultrags/pio-isa-check.py',
           ROOT/'sw/ultrags/ug_handshake.c', ROOT/'sw/ultrags/ug_handshake.h',ROOT/'sw/picogus.cpp']
    for d in (fw,old): files += [d/'pg-ultrags-multifw.elf',d/'ug_handshake_ior.pio.h']
    report=dict(status='LINKED_CONFIG_ENTRY_PASS / REAL_PENDING',cases=rows,
                inputs={str(f.resolve()):arm.digest(f) for f in files},
                limits=['Fixed 48/80/128 instruction windows are synthetic, not measured Sprinter limits; 48 is too short for both.',
                        'Includes has_read, FIFO extraction, capture and PIO reply; excludes full main loop and boot.'])
    out=b/'host/gs-turbo/config-entry.json'; out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(report,indent=2)+'\n')
    for row in rows: print(row['after']['port'],row['after']['queued'],row['before']['first_wait_tick'],row['after']['first_wait_tick'])
    print('Linked CONFIG entry: 3 R14 fresh-FIFO negatives, 3 queued controls, 6 fixed/stale/short/ample cases PASS')

if __name__=='__main__': main()
