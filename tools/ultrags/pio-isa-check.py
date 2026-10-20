#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Execute the pioasm words used by GUS and ULTRAGS, with a delayed ARM peer.

Instruction-clock evidence only: not an electrical model of the Sprinter,
IOCHRDY setup, GPIO synchronizers, or real I2S/PSRAM SRAM arbitration.
"""
import argparse
import hashlib
import json
import re
import subprocess
import zlib
from pathlib import Path


def program(header, name):
    text = Path(header).read_text()
    body = re.search(rf'{name}_program_instructions\[\]\s*=\s*\{{(.*?)\}};', text, re.S)[1]
    words = [int(w, 16) for w in re.findall(r'0x([0-9a-fA-F]{4})', body)]
    labels = {key: int(value) for key, value in re.findall(rf'#define {name}_offset_(\w+) (\d+)', text)}
    wrap = [int(re.search(rf'#define {name}_{key} (\d+)', text)[1]) for key in ('wrap_target', 'wrap')]
    return words, labels, wrap


class SM:
    def __init__(self, words, wrap, *, early=False, write=False):
        self.words, self.wrap = list(words), wrap
        self.early, self.write = early, write
        self.shared = early == "shared"
        self.pc = self.x = self.y = self.isr = self.osr = self.inc = 0
        self.outc = 32
        self.tx, self.rx = [], []
        self.ior = self.iow = self.dack = 1
        self.port = self.data = self.ads = self.hold = self.dirs = self.value = self.irq = 0
        self.delay = 0
        self.mux_delay = self.mux_age = 0
        self.held = False
        self.fast = False
        self.side_write = None
        self.hold_lag = 0
        self.hold_history = [0] * 8
        self.feedback_pin = None
        self.jmp_pin = 19

    def pins(self):
        bus = (self.data if self.mux_age>=self.mux_delay else 255) if self.ads else self.port
        observed_hold = self.hold_history[-1-self.hold_lag] if self.hold_lag else self.hold
        if self.feedback_pin is not None: observed_hold = self.feedback_pin
        pins = (bus << 6) | (self.ior << 5) | (self.iow << 4) | (self.dack << 19) | (observed_hold << 26)
        base = 11 if self.early else 6
        return ((pins >> base) | (pins << (32 - base))) & 0xffffffff

    def step(self):
        self.hold_history = self.hold_history[1:] + [self.hold]
        self.mux_age=self.mux_age+1 if self.ads else 0
        self.side_write = None
        if self.delay:
            self.delay -= 1
            return
        w = self.words[self.pc]
        pins = self.pins()  # sampled inputs precede this instruction's mux change
        if w & 0x1000:
            self.side_write = (w >> 10) & 3
            self.hold, self.ads = (w >> 10) & 1, (w >> 11) & 1
            self.held |= bool(self.hold)
        op, arg, dest = w >> 13, w & 31, (w >> 5) & 7
        nxt = self.wrap[0] if self.pc == self.wrap[1] else self.pc + 1
        if op == 0:  # JMP
            conditions = [True, not self.x, bool(self.x), not self.y, bool(self.y), self.x != self.y,
                          bool(self.port & 512) if self.jmp_pin == 15 else bool(self.dack),
                          self.outc < (32 if self.shared else 24)]
            if dest == 2: self.x = (self.x - 1) & 0xffffffff
            if dest == 4: self.y = (self.y - 1) & 0xffffffff
            if conditions[dest]: nxt = arg
        elif op == 1:  # WAIT GPIO
            assert (w >> 5) & 3 == 0
            pin = {4: self.iow, 5: self.ior}[arg]
            if pin != ((w >> 7) & 1): return
        elif op == 2:  # IN PINS, left shift, baseline autopush
            assert dest==0
            count = arg or 32
            if self.shared and self.inc+count>=32 and len(self.rx)==4: return
            self.isr = ((self.isr << count) | (pins & ((1 << count) - 1))) & 0xffffffff
            self.inc += count
            if (self.shared and self.inc >= 32) or (not self.early and self.inc >= (18 if self.write else 10)):
                assert len(self.rx) < 4
                self.rx.append(self.isr)
                self.isr = self.inc = 0
        elif op == 3:  # OUT, right shift with autopull
            if self.outc >= (32 if self.write or self.shared else 24):
                if not self.tx: return
                self.osr, self.outc = self.tx.pop(0), 0
                return  # RP2040 3.5.4.2: OUT stalls on the refill cycle
            count = arg or 32
            value = self.osr & ((1 << count) - 1)
            self.osr >>= count
            self.outc = min(32, self.outc + count)
            if dest == 0: self.value = value
            elif dest == 1: self.x = value
            elif dest == 4: self.dirs = value
            elif dest == 5: nxt = value & 31
            else: assert dest == 3
        elif op == 4:  # PUSH / PULL
            assert not w & 0x40 and w & 0x20
            if w & 0x80:
                # With AUTOPULL, PULL is a barrier when OSR is not empty.
                if self.outc >= (32 if self.write or self.shared else 24):
                    if not self.tx: return
                    self.osr, self.outc = self.tx.pop(0), 0
            else:
                if len(self.rx) == 4: return
                self.rx.append(self.isr)
                self.isr = self.inc = 0
        elif op == 5:  # MOV, including NOP MOV Y,Y
            source, transform = w & 7, (w >> 3) & 3
            assert transform in (0, 1)
            value = {0: pins, 1: self.x, 2: self.y, 3: 0, 6: self.isr, 7: self.osr}[source]
            if transform == 1: value ^= 0xffffffff
            if dest == 1: self.x = value
            elif dest == 2: self.y = value
            elif dest == 6: self.isr, self.inc = value, 0
            elif dest == 7: self.osr, self.outc = value, 0
            else: raise AssertionError(('MOV', dest))
        elif op == 6:
            assert w & 0xff == 0
            self.irq = 1
        elif op == 7:
            if dest == 1: self.x = arg
            elif dest == 2: self.y = arg
            elif dest == 0 and self.shared: self.ads = arg & 1
            else: raise AssertionError(("SET",dest))
        else: raise AssertionError(w)
        # AUTOPULL can also refill between OUTs, including the final OUT's
        # trailing phase; MOV OSR/PULL have already reset the counter above.
        if self.outc >= (32 if self.write or self.shared else 24) and self.tx:
            self.osr, self.outc = self.tx.pop(0), 0
        self.pc, self.delay = nxt, (w >> 8) & 3


def native(words, labels, wrap, base, alias, *, gs=False, write=False):
    read_wrap=(labels['parked'],labels['address_only']) if 'address_only' in labels else (labels['restart'],labels['read_release'])
    sm = SM(words, (labels['decode'],labels['dack']) if write else read_wrap, early='shared',write=write)
    sm.fast='arm_value' in labels
    sm.explicit_tag='owned' in labels
    sm.pc=labels['write_restart'] if write else labels['restart']
    sm.words[labels['base_compare']] = 0xe040 | (base >> 5)
    sm.words[labels['alias_compare']] = 0xe040 | ((base if alias == 0xffff else alias) >> 5)
    sm.words[labels['gs_compare']] = 0xe045 if gs else labels['submit']
    # Model a quiescent bus before the first test cycle. Initialising while
    # IOR is already low is tested separately: restart must await its rise.
    if not write and labels['idle'] != labels['restart']:
        sm.step()
    return sm


def deliver(sm,labels,value):
    if 'arm_value' in labels:
        # The actual ARM peer is checked separately. Its two forced OUTs
        # execute while held, before the autonomous WAIT/release tail.
        sm.osr=0;sm.outc=16;sm.tx=[];sm.value=value;sm.dirs=255;sm.hold=1;sm.ads=1
    else:
        sm.osr=0;sm.outc=32;sm.tx=[0xff00|value]
    sm.pc=labels['value'];sm.delay=0


def address(sm,word):
    if getattr(sm,'explicit_tag',False) and tag(sm,word):word^=0xffffffff
    return ((word>>27)&31)|((word&31)<<5)
def data_byte(sm,word):return ((word>>27)|((word&7)<<5))&255
def tag(sm,word):return bool(word&(1<<((25 if sm.write else 26) if getattr(sm,'explicit_tag',False) else 15)))


def shared_read(sm, labels, port, value, delay, *, sample=32, verify_tag=True):
    sm.port,sm.ior,sm.held=port,0,False
    received=None;at=None;sampled=None;consumed=0
    for tick in range(delay+160):
        sm.step()
        if len(sm.rx)==(1 if 'address_only' in labels else 2) and received is None:
            received=sm.rx[:];sm.rx.clear();at=tick+delay
            assert address(sm,received[0])==port
            if verify_tag: assert tag(sm,received[0 if 'address_only' in labels else 1])==sm.held
        if at==tick:
            consumed+=1;deliver(sm,labels,value)
        if tick>=sample and sampled is None and not sm.hold:
            sampled=sm.value if sm.dirs==255 and sm.ads else 255;sm.ior=1
    assert received is not None and consumed==1
    assert not sm.dirs and not sm.hold and not sm.ads and not sm.tx and not sm.rx
    return sampled


def read(sm, port, value, delay, *, sample=24):
    sm.port, sm.ior, sm.held = port, 1, False
    for _ in range(4): sm.step()
    assert not sm.dirs and not sm.hold
    sm.ior = 0
    received = None
    consumed = 0
    response_at = None
    sampled = None
    for tick in range(delay + 128):
        sm.step()
        if sm.rx and received is None:
            received = sm.rx.pop(0)
            response_at = tick + delay
        if response_at == tick:
            sm.tx.extend([0xffffffff, 0xff00 | value])
            consumed += 1
        if tick >= sample and sampled is None and not sm.hold:
            sampled = sm.value if sm.dirs == 255 and sm.ads else 255
            sm.ior = 1
    assert received is not None and consumed == 1
    assert not sm.hold and not sm.dirs and not sm.ads
    assert not sm.tx and not sm.rx
    if sm.early:
        assert received & (1 << 26)
        received ^= 0xffffffff
        decoded = ((received >> 27) & 31) | ((received & 31) << 5)
        assert decoded == port
    else: assert received == port
    return sampled


def coupled(iow, iow_wrap, words, labels, wrap, *, mutate=False, writer_period=1, writer_phase=0):
    """SM1 must retain IOCHRDY while an earlier SM0 write completes."""
    writer = SM(iow, iow_wrap, write=True)
    writer.pc, writer.port, writer.data, writer.dack = 1, 0x2a3, 0x80, 0
    writer.iow = 0
    for _ in range(40): writer.step()
    assert writer.rx == [(0x2a3 << 8) | 0x80]
    writer.iow = 1
    reader = native(words, labels, wrap, 0x2a0, 0xffff)
    if mutate: reader.words[labels['owned_condition']] &= ~0x1000
    reader.pc, reader.port, reader.ior = 1, 0x2a3, 0
    hold = ads = 0
    seen = released_early = False
    sampled = None
    for tick in range(256):
        for sm in (writer, reader): sm.hold, sm.ads = hold, ads
        writer.side_write = None
        if (tick + writer_phase) % writer_period == 0: writer.step()
        reader.step()
        side = reader.side_write if reader.side_write is not None else writer.side_write
        if side is not None: hold, ads = side & 1, side >> 1
        if tick == 20: writer.tx = [0xffffffff]
        if tick == 40: writer.tx.append(0)
        if tick == 80: reader.tx.append(getattr(reader, 'native_entry', 0xffffffff))
        if tick == 100: reader.tx.append(0xff24)
        if hold: seen = True
        if seen and not hold and sampled is None:
            if reader.dirs != 255 or not ads: released_early = True
            else: sampled = reader.value
            reader.ior = 1
    return not released_early and sampled == 36 and not hold and not ads and not reader.dirs


def coupled_shared(words,labels,wrap,*,owned_write,phase,period,mutate=False):
    writer=native(words,labels,wrap,0x2a0,0xffff,write=True)
    writer.dack=0;writer.port=0x2a3 if owned_write else 0x123;writer.data=0x80;writer.iow=1;writer.step();writer.iow=0
    for _ in range(64):writer.step()
    assert len(writer.rx)==2 and bool(writer.hold)==owned_write and not writer.ads
    reader=native(words,labels,wrap,0x2a0,0xffff);reader.port=0x2a3
    hold=writer.hold;ads=0;sampled=None;write_done=False;read_started=False
    reader_ready=None;early=False
    if mutate:writer.words[labels['write_restart']]|=0x1000  # forbidden passive cleanup side-set
    for tick in range(256):
        # Own writes complete first; foreign writes can finish before ARM sees them.
        if tick==(20 if owned_write else 60):
            if owned_write:hold=0
            writer.pc=labels['write_restart'];writer.delay=0;writer.rx.clear()
        if tick==(21 if owned_write else 32):writer.iow=1;write_done=True
        if write_done and tick==(22 if owned_write else 33):reader.ior=0;read_started=True
        side=None
        for sm,active in ((writer,(tick+phase)%period==0),(reader,True)):
            sm.hold,sm.ads=hold,ads
            if not active:continue
            before_ads=sm.ads;sm.step()
            if sm.side_write is not None:hold,ads=sm.hold,sm.ads;side=sm.side_write
            elif sm.ads!=before_ads:ads=sm.ads
        if len(reader.rx)==(1 if 'address_only' in labels else 2) and reader_ready is None:reader_ready=tick+64;reader.rx.clear();early=bool(hold)
        if tick==reader_ready:
            deliver(reader,labels,36);hold,ads=reader.hold,reader.ads
        if read_started and tick>=65 and sampled is None and not hold:
            sampled=reader.value if reader.dirs==255 and ads else 255;reader.ior=1
    return early and sampled==36 and not hold and not ads and not reader.dirs


def check(build, out):
    old_header, new_header = build / 'isa_io.pio.h', build / 'ug_handshake_ior.pio.h'
    old, _, old_wrap = program(old_header, 'ior')
    iow, _, iow_wrap = program(old_header, 'iow')
    new, labels, wrap = program(new_header, 'ug_handshake_ior')
    reference=Path(__file__).resolve().parents[2]/'tests/ultrags/reference/handshake-r2.pio'
    reference_header=out.parent/'handshake-r2.pio.h';reference_header.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run([str(build/'pioasm-install/pioasm/pioasm'),'-o','c-sdk','-v','0',str(reference),str(reference_header)],check=True)
    r2,r2labels,r2wrap=program(reference_header,'ug_handshake_ior')
    assert len(new)==32 and len(old)==9 and len(iow)==10
    maps=ports=writes=0
    for base in range(0x200,0x400,32):
        for alias in [0xffff,*range(0x200,0x400,32)]:
            if alias==base:continue
            for gs in (False,True):
                maps+=1
                for write in (False,True):
                    sm=native(new,labels,wrap,base,alias,gs=gs,write=write)
                    for port in range(1024):
                        sm.pc=labels['decode'];sm.x=sm.y=sm.isr=sm.inc=sm.hold=sm.ads=sm.delay=0
                        sm.outc=32;sm.tx.clear();sm.rx.clear()
                        sm.port,sm.data,sm.ior,sm.iow,sm.dack=port,(port*73)&255,0,0,0
                        for _ in range(64):
                            sm.step()
                            if sm.pc==labels['parked']:break
                        expected=port//32 in (base//32,alias//32) or (gs and port in (0xb3,0xbb))
                        assert sm.pc==labels['parked'] and len(sm.rx)==(1 if 'address_only' in labels and not write else 2),(base,alias,port,write)
                        assert bool(sm.hold)==expected and not sm.ads and not sm.dirs,(base,alias,port,write)
                        a=sm.rx[0];b=sm.rx[-1]
                        assert address(sm,a)==port
                        if write:assert data_byte(sm,b)==sm.data
                        assert tag(sm,a if sm.explicit_tag else b)==expected
                        ports+=1;writes+=write
    # Old transport advances every consuming read even though the host sees FF.
    frame=bytes([0,40])+b'UGS1'+bytes(range(32))+b'VLS1'
    frame+=zlib.crc32(frame).to_bytes(4,'little')
    old_sm=SM(old,old_wrap)
    # Compare a 1us ARM delay at 370MHz upstream / 366MHz candidate.
    # Sampling is approximately 200ns (quantized to instruction clocks).
    assert bytes(read(old_sm,0x2a3,v,370,sample=74) for v in frame)==bytes([255])*len(frame)
    matched=native(new,labels,wrap,0x2a0,0xffff)
    assert bytes(shared_read(matched,labels,0x2a3,v,366,sample=73) for v in frame)==frame
    frames=0
    for base in range(0x200,0x400,32):
        for port in (base+3,0xb3,0xbb):
            for delay in (0,1,8,64,1024,10000):
                sm=native(new,labels,wrap,base,0xffff,gs=True)
                observed=bytes(shared_read(sm,labels,port,v,delay) for v in frame)
                assert observed==frame and zlib.crc32(observed[:-4])==int.from_bytes(observed[-4:],'little')
                frames+=1
    # Missing early side-set must reproduce the late FF failure.
    sm=native(new,labels,wrap,0x2a0,0xffff)
    sm.words=[w&~0x1000 if (w>>13) in (0,5) else w for w in sm.words]
    assert shared_read(sm,labels,0x2a3,36,64,verify_tag=False)!=36
    # A stopped ARM cannot suppress early wait even if the RX FIFO is full.
    sm=native(new,labels,wrap,0x2a0,0xffff);sm.rx=[0]*4;sm.port=0x2a3;sm.ior=0
    for _ in range(64):sm.step()
    assert sm.hold and sm.pc==labels['submit'] and not sm.ads and not sm.dirs
    for dack in (0,1):
        sm=native(new,labels,wrap,0x2a0,0xffff,write=True);sm.dack=dack;sm.port=0x2a3;sm.data=0xa5
        sm.step();sm.iow=0
        for _ in range(64):sm.step()
        assert bool(sm.rx)==(not dack) and bool(sm.hold)==(not dack) and not sm.ads and not sm.dirs
    # Explicit AUTOPULL barrier semantics and delayed preceding IOW cleanup.
    barrier=SM([0x80a0],(0,0));barrier.osr=0x123;barrier.outc=5;barrier.tx=[0xffffffff];barrier.step()
    assert (barrier.osr,barrier.outc,barrier.tx)==(0x123,5,[0xffffffff])
    phases=0
    for owned in (False,True):
        for period in (1,2,3):
            for phase in range(period):
                assert coupled_shared(new,labels,wrap,owned_write=owned,phase=phase,period=period),(owned,phase,period)
                phases+=1
    assert not coupled_shared(new,labels,wrap,owned_write=False,phase=0,period=1,mutate=True),'foreign cleanup mutation survived'
    # Retain the GUS mux setup time:8 clocks at183MHz equal16 at366MHz.
    # The propagation model uses the same absolute delay for both. R2
    # captures after only4 of its required8 clocks.
    def mux_capture(sm,data):
        sm.mux_delay=16 if sm.fast else 8;sm.port=0x1d0;sm.data=data;sm.dack=0
        sm.step();sm.iow=0;ads_at=None;captured_at=None
        for tick in range(96):
            was_ads=sm.ads;sm.step()
            if not was_ads and sm.ads:ads_at=tick
            if len(sm.rx)==(2 if sm.shared else 1):captured_at=tick;break
        assert captured_at is not None and ads_at is not None
        value=data_byte(sm,sm.rx[1]) if sm.shared else sm.rx[0]&255
        return value,captured_at-ads_at
    mux_bad=0
    for data in range(256):
        gus=SM(iow,iow_wrap,write=True)
        previous=native(r2,r2labels,r2wrap,0x2a0,0xffff,write=True)
        fixed=native(new,labels,wrap,0x2a0,0xffff,write=True)
        g,gap=mux_capture(gus,data);p,pgap=mux_capture(previous,data);f,fgap=mux_capture(fixed,data)
        assert g==f==data and gap==8 and fgap==16 and pgap==4,(data,g,p,f,gap,pgap,fgap)
        mux_bad+=p!=data
    assert mux_bad==255
    # A SIO-observed rising IOR need not already be visible to this SM.
    # Forced restart while its input is still low must not duplicate the
    # previous cycle. Test the actual generated words, with R5 as control.
    r5ref=Path(__file__).resolve().parents[2]/'tests/ultrags/reference/handshake-r5.pio'
    r5header=out.parent/'handshake-r5.pio.h'
    subprocess.run([str(build/'pioasm-install/pioasm/pioasm'),'-o','c-sdk','-v','0',str(r5ref),str(r5header)],check=True)
    r5,r5labels,r5wrap=program(r5header,'ug_handshake_ior')
    rearm_cases=0
    for port in range(1024):
        for lag in (1,2,3,4):
            previous=native(r5,r5labels,r5wrap,0x2a0,0xffff,gs=True)
            fixed=native(new,labels,wrap,0x2a0,0xffff,gs=True)
            for sm,lab in ((previous,r5labels),(fixed,labels)):
                sm.pc=lab['restart'];sm.ior=0;sm.port=port
                for _ in range(lag+32):sm.step()
            assert previous.rx and not fixed.rx and not fixed.hold and not fixed.ads and not fixed.dirs
            fixed.ior=1
            for _ in range(5):fixed.step()
            fixed.ior=0
            for _ in range(64):
                fixed.step()
                if fixed.pc==labels['parked']:break
            assert len(fixed.rx)==1 and address(fixed,fixed.rx[0])==port
            rearm_cases+=1
    # Historical feedback-lag control. The candidate's tag now comes from
    # the classifier branch, not from this pad-feedback timing assumption.
    for port in (0x2a0,0x2bf,0xb3,0xbb):
        for words,lab,wr,expected in ((r5,r5labels,r5wrap,False),(new,labels,wrap,True)):
            sm=native(words,lab,wr,0x2a0,0xffff,gs=True);sm.hold_lag=3;sm.port=port;sm.ior=0
            for _ in range(64):
                sm.step()
                if sm.pc==lab['parked']:break
            assert sm.hold and tag(sm,sm.rx[0])==expected
    source=Path(__file__).resolve().parents[2]/'sw/picogus.cpp'
    assert 'ug_handshake_sm_init(pio0,IOW_PIO_SM,ior_offset,false,ug_isa_clkdiv)' in source.read_text()
    assert 'ug_isa_div256=((uint32_t)(iow_clkdiv*256.0f)+1u)/2u' in source.read_text()
    old_div256=int(370000/183000*256);new_div256=max(256,(old_div256+1)//2)
    assert 16*new_div256>=8*old_div256 and new_div256<old_div256
    assert (old_div256,new_div256)==(517,259)
    report=dict(status='HOST_PIO_INSTRUCTION_PASS / REAL_PENDING',maps=maps,addresses=ports,
        writes=writes,pio0_words=len(new),delayed_info_frames=frames,autopull_barrier="PASS",simultaneous_iow_ior="PASS",write_clock_phases=phases,
        same_delay_old_sample='FF with index advanced once',same_delay_new_crc='PASS',
        matched_delay_ticks={'old':370,'new':366,'old_host_sample':74,'new_host_sample':73},
        mux_settle={'patterns':256,'gus_pio_clocks':8,'r2_pio_clocks':4,'fixed_pio_clocks':16,'r2_wrong_bytes':mux_bad,'iow_clock_multiple_of_gus':2,'mux_setup_not_shorter_than_gus':True,'divider256_gus':old_div256,'divider256_candidate':new_div256},
        read_rearm={'cases':rearm_cases,'r5_duplicates':'REPRODUCED','candidate_duplicates':0,'historical_feedback_lag_ticks':3,'ownership_cases':4,'explicit_classifier_tag':True,'timing':'declared functional skew; not measured RP2040 pad timing'},
        inputs={str(p.resolve()):hashlib.sha256(p.read_bytes()).hexdigest() for p in [old_header,new_header,reference,reference_header,r5ref,r5header,source,Path(__file__)]},
        limitations='Generated instruction semantics, finite ARM delays; electrical setup and real SRAM/I2S/PSRAM latency require REAL. Core0 verdict and fuse are exercised separately in production C.')
    out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,indent=2)+'\n')
    print(f'Generated shared PIO: {maps} maps / {ports} read+write addresses; {frames} full INFO+CRC delayed frames; DACK/ADS/full RX PASS (32/32 words)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    check(args.build.resolve(), args.out)
