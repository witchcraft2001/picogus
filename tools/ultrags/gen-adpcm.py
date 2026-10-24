#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Generate IMA ADPCM (WAV 0x11) fixtures with an independent codec (ffmpeg).

For every case: a deterministic synthetic S16 source, its ffmpeg IMA ADPCM
WAV, ffmpeg's own decode of that WAV (the reference the firmware must match)
and a PCM S16 WAV of the reference trimmed to the source length. The
firmware decoder is never used here. manifest.txt lists one case per line:
name rate channels block_size frames.
"""
import argparse, math, struct, subprocess, wave
from pathlib import Path

CASES = [  # name, rate, channels, block_size, seconds
    ('m48k', 48000, 1, 1024, 0.50),
    ('m11k', 11025, 1, 256, 0.70),
    ('s22k', 22050, 2, 2048, 0.90),
    ('s44k', 44100, 2, 1024, 0.40),
    ('m8k32', 8000, 1, 32, 0.25),
    ('m48k8192', 48000, 1, 8192, 0.30),
    ('s48k', 48000, 2, 512, 0.20),
]

def source(rate, channels, frames):
    """Chirp + square bursts + LCG noise: exercises small and large steps."""
    seed = 12345
    out = []
    for n in range(frames):
        t = n / rate
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        noise = ((seed >> 8) & 0xfff) - 2048
        for c in range(channels):
            f = 220.0 * (1 + c) * (1 + 3 * t)
            v = 14000 * math.sin(2 * math.pi * f * t)
            if (n // 700) % 3 == c:
                v += 9000 if (n // 37) % 2 else -9000
            v += noise
            out.append(max(-32768, min(32767, int(round(v)))))
    return out

def run(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--ffmpeg', default='ffmpeg')
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    lines = []
    for name, rate, ch, block, seconds in CASES:
        frames = int(rate * seconds)
        src = a.out / f'{name}.src.raw'
        src.write_bytes(struct.pack(f'<{frames * ch}h', *source(rate, ch, frames)))
        wav = a.out / f'{name}.wav'
        run([a.ffmpeg, '-hide_banner', '-y', '-f', 's16le', '-ar', str(rate), '-ac', str(ch),
             '-i', str(src), '-c:a', 'adpcm_ima_wav', '-block_size', str(block), str(wav)])
        ref = a.out / f'{name}.ref.raw'
        run([a.ffmpeg, '-hide_banner', '-y', '-i', str(wav), '-f', 's16le', '-c:a', 'pcm_s16le', str(ref)])
        data = ref.read_bytes()
        need = frames * ch * 2
        assert len(data) >= need, f'{name}: ffmpeg decoded {len(data)} < {need} bytes'
        with wave.open(str(a.out / f'{name}.pcm.wav'), 'wb') as w:
            w.setnchannels(ch); w.setsampwidth(2); w.setframerate(rate)
            w.writeframes(data[:need])
        lines.append(f'{name} {rate} {ch} {block} {frames}')
    (a.out / 'manifest.txt').write_text('\n'.join(lines) + '\n')

if __name__ == '__main__':
    main()
