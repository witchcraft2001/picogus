#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Freeze and execute the pre-fix GS Turbo negative control.

This is deliberately NOT a firmware acceptance test. --require-early-gs fails
on the control. Instruction ticks below are synthetic, not Sprinter timings.
No CURRENT file is written by this tool.
"""
import argparse
import hashlib
import importlib.util
import json
import re
import struct
import subprocess
from pathlib import Path
from cfg_evidence import verify_multifw


ROOT = Path(__file__).resolve().parents[2]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def freeze(path, data):
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f"refusing to replace frozen control: {path}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def linked_words(fw, elf, arrays):
    """Check generated instructions against loadable bytes, not ELF strings."""
    cache = (fw / 'CMakeCache.txt').read_text()
    nm = re.search(r'^CMAKE_NM:[^=\n]+=(.*)$', cache, re.M)[1]
    symbols = {}
    for line in subprocess.check_output([nm, '--defined-only', str(elf)], text=True).splitlines():
        fields = line.split()
        if len(fields) == 3:
            symbols[fields[2]] = int(fields[0], 16)
    data = elf.read_bytes()
    assert data[:6] == b'\x7fELF\x01\x01'
    phoff = struct.unpack_from('<I', data, 28)[0]
    stride, count = struct.unpack_from('<HH', data, 42)
    segments = [struct.unpack_from('<8I', data, phoff + i * stride) for i in range(count)]
    for name, words in arrays.items():
        found = [v for k, v in symbols.items() if k.endswith(name + '_program_instructions')]
        assert len(found) == 1, name
        address = found[0]
        expected = struct.pack('<' + 'H' * len(words), *words)
        actual = [data[off + address - va:off + address - va + len(expected)]
                  for kind, off, va, _, n, _, _, _ in segments
                  if kind == 1 and va <= address and address + len(expected) <= va + n]
        assert actual == [expected], f'PIO/ELF mismatch: {name}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', type=Path, default=ROOT / 'build')
    parser.add_argument('--require-early-gs', action='store_true')
    parser.add_argument('--frozen', action='store_true', help='replay the immutable pre-fix snapshot after upgrading the main build')
    args = parser.parse_args()
    build = args.build.resolve()
    fw = build / 'multifw-release'
    out = build / 'gs-turbo-baseline'
    if args.frozen:
        fw = out / 'build/multifw-release'
    spec = importlib.util.spec_from_file_location('pio_model', ROOT / 'tools/ultrags/pio-isa-check.py')
    model = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(model)
    header = fw / 'ug_compat_ior.pio.h'
    words, labels, wrap = model.program(header, 'ug_compat_ior')
    iow, _, iow_wrap = model.program(fw / 'isa_io.pio.h', 'iow')
    assert len(words) == 22 and len(iow) == 10, 'not the pre-fix COMPAT control'
    elf = fw / 'pg-ultrags-multifw.elf'
    if args.frozen:
        manifest = json.loads((out/'manifest.json').read_text())
        for name, entry in manifest['files'].items():
            assert sha((out/name).read_bytes()) == entry['sha256'], name
        inputs = {str((out/name).relative_to(ROOT)): entry['sha256'] for name, entry in manifest['files'].items()}
        for path in [Path(__file__), ROOT/'tools/ultrags/pio-isa-check.py', ROOT/'tools/ultrags/gs-turbo-control-independent.cjs']:
            inputs[str(path.relative_to(ROOT))] = sha(path.read_bytes())
        linked_words(fw, elf, {'ug_compat_ior': words, 'iow': iow})
    else:
        verify_multifw(fw)
        assert (build / 'CURRENT.UF2').read_bytes() == (fw / 'picogus.uf2').read_bytes()
        linked_words(fw, elf, {'ug_compat_ior': words, 'iow': iow})

        paths = [build / ('CURRENT.' + ext) for ext in ('UF2', 'ZIP', 'IMG')]
        paths += [elf, header, fw / 'isa_io.pio.h', fw / 'CMakeCache.txt',
                  ROOT / 'sw/ultrags/ug_compat_ior.pio', ROOT / 'sw/isa/isa_io.pio',
                  ROOT / 'sw/ultrags/ug_compat.c', ROOT / 'sw/picogus.cpp',
                  ROOT / 'tools/ultrags/pio-isa-check.py', Path(__file__),
                  ROOT / 'tools/ultrags/gs-turbo-control-independent.cjs']
        inputs = {}
        for path in paths:
            relative = path.relative_to(ROOT)
            data = path.read_bytes()
            # Firmware/control bytes are immutable. Test runners are hashed, but
            # may evolve while investigating the control; never overwrite a
            # frozen firmware input to accommodate a changed test.
            if not str(relative).startswith('tools/'):
                freeze(out / relative, data)
            else:
                snapshot = out / relative
                snapshot.parent.mkdir(parents=True, exist_ok=True)
                snapshot.write_bytes(data)
            inputs[str(relative)] = sha(data)

        manifest = out / 'manifest.json'
        if not manifest.exists():
            manifest.write_text(json.dumps({
                'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                'status': 'Pre-fix control; no new hardware evidence',
                'files': {name: {'sha256': digest, 'size': (ROOT / name).stat().st_size}
                          for name, digest in inputs.items() if not name.startswith('tools/')}
            }, indent=2) + '\n')
        for name, entry in json.loads(manifest.read_text())['files'].items():
            assert sha((out / name).read_bytes()) == entry['sha256'], f'corrupt frozen control: {name}'

    # Reassemble the actual source, so a stale generated header cannot certify
    # modified PIO. The linked array check above independently checks the ELF.
    for source, name in [('sw/ultrags/ug_compat_ior.pio', 'ug_compat_ior'),
                         ('sw/isa/isa_io.pio', 'iow')]:
        generated = out / (name + '.fresh.h')
        subprocess.run([str(build / 'multifw-release/pioasm-install/pioasm/pioasm'), '-o', 'c-sdk',
                        str((out if args.frozen else ROOT) / source), str(generated)], check=True)
        assert model.program(generated, name)[0] == (words if name == 'ug_compat_ior' else iow)

    def reader(base=0x2a0, alias=0xffff):
        sm = model.SM(words, wrap, early=True)
        sm.jmp_pin = 15
        sm.words[labels['base_compare']] = 0xe040 | (base >> 5)
        sm.words[labels['alias_compare']] = 0xe040 | ((base if alias == 0xffff else alias) >> 5)
        return sm

    # Exhaustive decoded-address matrix. GSALIAS does not reach the old PIO;
    # both software settings therefore have precisely the same early holds.
    captures = 0
    for base in range(0x200, 0x400, 32):
        for alias in [0xffff, *range(0x200, 0x400, 32)]:
            if alias == base:
                continue
            sm = reader(base, alias)
            for port in range(1024):
                sm.pc = labels['idle']
                sm.isr = sm.osr = sm.inc = sm.hold = sm.ads = sm.dirs = sm.delay = 0
                sm.outc = 32
                sm.tx.clear()
                sm.rx.clear()
                sm.port, sm.ior = port, 0
                for _ in range(40):
                    sm.step()
                    if sm.rx:
                        break
                assert len(sm.rx) == 1
                owned = bool(sm.rx[0] & (1 << 26))
                assert owned == (port // 32 in (base // 32, alias // 32))
                raw = (~sm.rx[0] & 0xffffffff) if owned else sm.rx[0]
                assert ((raw >> 27) & 31) | ((raw & 31) << 5) == port
                assert bool(sm.hold) == owned and not sm.dirs and not sm.ads
                captures += 1

    traces = []
    for port in (0xb3, 0xbb, 0x2b3, 0x2bb):
        for latency in (8, 128, 4096):
            sm = reader()
            sm.port = port
            sm.step()
            sm.ior = 0
            captured = held = sample = None
            for tick in range(latency + 256):
                sm.step()
                if sm.rx and captured is None:
                    captured = tick
                    sm.rx.clear()
                if sm.hold and held is None:
                    held = tick
                if captured is not None and tick == captured + latency:
                    # Simulate the production stale-cycle check: ended GS
                    # reads receive IO_END and must not consume a DATA byte.
                    if sm.ior:
                        sm.tx.append(0)
                    else:
                        sm.tx.extend([labels['value'] if port >= 0x200 else 0xffffffff, 0xff7e])
                if tick >= 74 and sample is None and not sm.hold:
                    sample = sm.value if sm.dirs == 255 and sm.ads else 255
                    sm.ior = 1
            expected = 255 if port < 0x200 and latency > 74 else 0x7e
            assert sample == expected and not sm.dirs and not sm.hold and not sm.ads
            assert not sm.tx and not sm.rx
            traces.append(dict(port=port, latencyTicks=latency, captureTick=captured,
                               holdTick=held, sampled=sample))

    independent = out / ('replayed-independent.json' if args.frozen else 'independent.json')
    subprocess.run(['node', str(ROOT / 'tools/ultrags/gs-turbo-control-independent.cjs'),
                    str(header), str(independent)], check=True, cwd=ROOT)
    other = json.loads(independent.read_text())
    assert [[t['port'], t['latencyTicks'], t['sampled']] for t in traces] == other['samples']
    report = dict(status='NEGATIVE_CONTROL_REPRODUCED / BASELINE_ONLY / REAL_PENDING',
                  captures=captures, traces=traces, inputs=inputs,
                  independentSha256=sha(independent.read_bytes()),
                  limits=['Synthetic sampling deadline, not measured Sprinter timing.',
                          'PIO words verified against linked ELF; ARM execution is not modeled.',
                          'No write-path, new diagnostic EXE, or new firmware acceptance claim.'])
    (out / ('replayed.json' if args.frozen else 'control.json')).write_text(json.dumps(report, indent=2) + '\n')
    print(f'Negative control reproduced: {captures} decoded addresses, {len(traces)} delayed reads in two models.')
    if args.require_early_gs:
        raise SystemExit('FAIL: low GS aliases have no early PIO WAIT; Turbo fix is not accepted')


if __name__ == '__main__':
    main()
