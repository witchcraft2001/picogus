#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// gen-fixtures.mjs - deterministic synthetic RAW/WAV/MOD/FLT8 fixture
// generator (TZ S0b work item; matrix per TZ 10/14).  Output is a set of
// small blobs plus manifest.json with sha256 of every file.  Two runs
// produce byte-identical output: fixed content, no timestamps, sorted
// manifest entries.
//
//   node tools/ultrags/gen-fixtures.mjs --out build/ultrags/fixtures
//
// These are FORMAT fixtures only: their presence proves nothing about
// audio/parser acceptance; that remains a later-stage property.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outIdx = process.argv.indexOf('--out');
const outDir = resolve(outIdx >= 0 ? process.argv[outIdx + 1] : 'build/ultrags/fixtures');
mkdirSync(outDir, { recursive: true });

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const le16 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
const le32 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
const be16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const files = new Map();
const put = (name, buf) => files.set(name, Buffer.from(buf));

// --- deterministic waveform: 128-sample ramp+sine hybrid ------------------
function pcm(format, rate, seconds = 0.02) {
  const n = Math.floor(rate * seconds);
  const frames = Buffer.alloc(format.ch === 2 ? n * 2 * (format.bits / 8) : n * (format.bits / 8));
  for (let i = 0, w = 0; i < n; i++) {
    const v = Math.round(90 * Math.sin((2 * Math.PI * 220 * i) / rate) + (i % 37) - 18);
    for (let c = 0; c < format.ch; c++) {
      if (format.enc === 'u8') frames.writeUInt8((v + 128) & 0xff, w);
      else if (format.enc === 's8') frames.writeInt8(Math.max(-128, Math.min(127, v)), w);
      else frames.writeInt16LE(Math.max(-32768, Math.min(32767, v * 200 + c)), w);
      w += format.bits / 8;
    }
  }
  return frames;
}

function wav({ enc, bits, ch, rate, extraChunks = [], oddPad = false, truncate = 0, badFmt = null, badAudio = null }) {
  const data = pcm({ enc, bits, ch }, rate);
  const byteRate = rate * ch * (bits / 8), block = ch * (bits / 8);
  const fmtBody = Buffer.concat([
    le16(badAudio ?? (enc === 'u8' ? 1 : 1)), le16(ch), le32(rate), le32(byteRate), le16(block), le16(bits),
  ]);
  const chunks = [];
  chunks.push(Buffer.concat([Buffer.from('fmt '), le32(badFmt ?? fmtBody.length), fmtBody]));
  for (const c of extraChunks) chunks.push(c);
  chunks.push(Buffer.concat([Buffer.from('data'), le32(data.length), data]));
  let body = Buffer.concat(chunks.map((c) => (oddPad && c.readUInt32LE(4) % 2 === 1 ? Buffer.concat([c, Buffer.from([0])]) : c)));
  const riff = Buffer.concat([Buffer.from('RIFF'), le32(4 + body.length), Buffer.from('WAVE'), body]);
  return truncate ? riff.subarray(0, riff.length - truncate) : riff;
}

// --- RAW matrix (no header): encodings x channels x rates ----------------
const RATES = [8000, 11025, 22050, 44100, 48000];
for (const rate of RATES) {
  put(`raw-u8-mono-${rate}.raw`, pcm({ enc: 'u8', bits: 8, ch: 1 }, rate));
  put(`raw-s8-stereo-${rate}.raw`, pcm({ enc: 's8', bits: 8, ch: 2 }, rate));
  put(`raw-s16le-mono-${rate}.raw`, pcm({ enc: 's16', bits: 16, ch: 1 }, rate));
}
put('raw-u8-stereo-22050.raw', pcm({ enc: 'u8', bits: 8, ch: 2 }, 22050));
put('raw-s16le-stereo-44100.raw', pcm({ enc: 's16', bits: 16, ch: 2 }, 44100));

// Complete RAW format/channel matrix and exact signed/unsigned endpoints.
for (const rate of RATES) for (const [enc, bits, label] of [['u8',8,'u8'], ['s8',8,'s8'], ['s16',16,'s16le']])
  for (const ch of [1,2]) put(`raw-${label}-${ch === 1 ? 'mono' : 'stereo'}-${rate}.raw`, pcm({ enc,bits,ch }, rate));
for (const [label, values, bits] of [['u8',[0,128,255],8], ['s8',[-128,0,127],8], ['s16le',[-32768,0,32767],16]]) {
  for (const ch of [1,2]) {
    const b = Buffer.alloc(values.length * ch * bits / 8); let i = 0;
    for (const v of values) for (let c = 0; c < ch; c++) {
      if (label === 'u8') b.writeUInt8(v, i++);
      else if (label === 's8') b.writeInt8(v, i++);
      else { b.writeInt16LE(v, i); i += 2; }
    }
    put(`raw-${label}-${ch === 1 ? 'mono' : 'stereo'}-endpoints.raw`, b);
  }
}

// --- WAV matrix ------------------------------------------------------------
put('wav-u8-mono-8000.wav', wav({ enc: 'u8', bits: 8, ch: 1, rate: 8000 }));
put('wav-s16le-stereo-44100.wav', wav({ enc: 's16', bits: 16, ch: 2, rate: 44100 }));
put('wav-oddchunk-pad.wav', wav({ enc: 'u8', bits: 8, ch: 1, rate: 11025,
  extraChunks: [Buffer.concat([Buffer.from('LIST'), le32(3), Buffer.from('abc')])], oddPad: true }));
put('wav-unknown-chunks.wav', wav({ enc: 's16', bits: 16, ch: 1, rate: 22050,
  extraChunks: [Buffer.concat([Buffer.from('JUNK'), le32(8), Buffer.alloc(8, 0x51)])] }));
put('wav-truncated.wav', wav({ enc: 'u8', bits: 8, ch: 1, rate: 8000, truncate: 17 }));
put('wav-bad-format.wav', wav({ enc: 'u8', bits: 8, ch: 1, rate: 8000, badFmt: 4 }));
put('wav-bad-audiofmt.wav', wav({ enc: 'u8', bits: 8, ch: 1, rate: 8000, badAudio: 85 }));

for (const rate of RATES) for (const [enc,bits,label] of [['u8',8,'u8'],['s16',16,'s16le']])
  for (const ch of [1,2]) put(`wav-${label}-${ch === 1 ? 'mono' : 'stereo'}-${rate}.wav`, wav({enc,bits,ch,rate}));
put('wav-partial-stereo-frame.wav', wav({ enc:'s16', bits:16, ch:2, rate:48000, truncate:1 }));

// --- MOD builder (31-instrument, M.K./M!K!/8CHN per TZ 10.1) --------------
function mod({ sig = 'M.K.', channels = 4, songLen = 1, orders = [0], tailFill = 0,
               extraPatterns = 0, samples = null, badSongLen = false }) {
  const hdr = Buffer.alloc(1084, 0);
  hdr.write('fixture-mod', 0, 'ascii');
  for (let i = 0; i < 31; i++) {
    const o = 20 + i * 30;
    const s = samples?.[i];
    hdr.write(s?.name ?? `sample${i}`, o, 'ascii');
    be16(s ? s.len / 2 : 0).copy(hdr, o + 22);   // length in words BE
    hdr[o + 24] = s?.fine ?? 0;
    hdr[o + 25] = s?.vol ?? (s ? 64 : 0);        // volume 0..64
    be16((s?.loopStart ?? 0) / 2).copy(hdr, o + 26);                   // loop start
    be16((s?.loopLength ?? 2) / 2).copy(hdr, o + 28);                   // loop len (off)
  }
  hdr[950] = badSongLen ? 0 : songLen;           // song length (0 -> FORMAT in FLT8/MOD)
  hdr[951] = 127;                                // restart
  const ord = Buffer.alloc(128, tailFill);
  orders.forEach((v, i) => { ord[i] = v; });
  ord.copy(hdr, 952);
  hdr.write(sig, 1080, 'ascii');
  const patBytes = 64 * channels * 4;
  // TZ 10.1: stored patterns = max over ALL 128 order bytes (valid <128)
  const nPat = Math.max(...ord.filter((o) => o < 128)) + 1 + extraPatterns;
  const pats = Buffer.alloc(patBytes * nPat, 0);
  // stamp one C-2 note (period 428) on channel0 of every pattern
  for (let p = 0; p < nPat; p++) { pats[p * patBytes] = 0x01; pats[p * patBytes + 1] = 0xAC; pats[p * patBytes + 2] = 0x10; }
  const sdata = Buffer.concat((samples ?? []).filter(Boolean).map((s) => s.data ?? Buffer.alloc(s.len)));
  return Buffer.concat([hdr, pats, sdata]);
}
const smp = { name: 'sqr', len: 64, vol: 64, data: Buffer.alloc(64, 0x80) };
put('mod-mk-4ch.mod', mod({ sig: 'M.K.', channels: 4, orders: [0, 1, 0], songLen: 3, samples: [smp] }));
put('mod-mik-4ch.mod', mod({ sig: 'M!K!', channels: 4, orders: [0], songLen: 1, samples: [smp] }));
put('mod-8chn-8ch.mod', mod({ sig: '8CHN', channels: 8, orders: [0, 1], songLen: 2, samples: [smp] }));
put('mod-tail-ff-ok.mod', mod({ sig: 'M.K.', channels: 4, orders: [0], songLen: 1, tailFill: 0xff, samples: [smp] }));
put('mod-tail-phys-extra.mod', mod({ sig: 'M.K.', channels: 4, orders: [0], songLen: 1, tailFill: 1, extraPatterns: 1, samples: [smp] }));
put('mod-order-oob-active.mod', mod({ sig: 'M.K.', channels: 4, orders: [0, 200], songLen: 2, samples: [smp] }));
put('mod-missing-pattern.mod', mod({ sig: 'M.K.', channels: 4, orders: [0, 5], songLen: 2, extraPatterns: -5, samples: [smp] }));
put('mod-zero-songlen.mod', mod({ sig: 'M.K.', channels: 4, badSongLen: true, samples: [smp] }));
put('mod-truncated.mod', mod({ sig: 'M.K.', channels: 4, orders: [0, 1], songLen: 2, samples: [smp] }).subarray(0, 1084 + 900));

put('mod-loop-valid.mod', mod({ samples: [{ ...smp, loopStart:16, loopLength:32 }] }));
put('mod-loop-oob.mod', mod({ samples: [{ ...smp, loopStart:48, loopLength:32 }] }));
put('mod-bad-volume.mod', mod({ samples: [{ ...smp, vol:65 }] }));
put('mod-sample-truncated.mod', mod({ samples:[smp] }).subarray(0, 1084+1024+63));

// --- FLT8 (TZ 10.2): logical 8ch pattern = two consecutive 4ch blocks -----
function flt8({ orders = [0], songLen = 1, tailFill = 0, dropBlock = 0, onlyBlocks = 0 }) {
  const hdr = Buffer.alloc(1084, 0);
  hdr.write('fixture-flt8', 0, 'ascii');
  for (let i = 0; i < 31; i++) {
    const o = 20 + i * 30;
    hdr.write(`flt${i}`, o, 'ascii');
    be16(i === 0 ? 32 : 0).copy(hdr, o + 22);
    hdr[o + 25] = i === 0 ? 64 : 0;
  }
  hdr[950] = songLen;
  hdr[951] = 127;
  const ord = Buffer.alloc(128, tailFill);
  orders.forEach((v, i) => { ord[i] = v; });
  ord.copy(hdr, 952);
  hdr.write('FLT8', 1080, 'ascii');
  // TZ 10.2: logical patterns = max(order>>1)+1 over ALL 128 entries
  const nLogical = Math.max(...[...ord].map((o) => o >> 1)) + 1;
  const blk = (pat) => {
    const b = Buffer.alloc(1024, 0);
    // ch0 note C-2 sample1; ch3 a distinguishable G-2 (period ~322) in 2nd half
    b[0] = 0x01; b[1] = pat % 2 ? 0x42 : 0xac; b[2] = 0x10;
    b[3 * 4] = 0x01; b[3 * 4 + 1] = pat % 2 ? 0xac : 0x42; b[3 * 4 + 2] = 0x10;
    return b;
  };
  const nEmit = onlyBlocks || Math.max(0, nLogical * 2 - dropBlock);
  const pats = Buffer.concat(Array.from({ length: nEmit }, (_, i) => blk(i)));
  const body = Buffer.concat([hdr, pats]);
  return Buffer.concat([body, Buffer.alloc(64, 0x80)]); // 32 sample words = 64 bytes
}
put('flt8-basic.flt8', flt8({ orders: [0], songLen: 1 }));
put('flt8-odd-order.flt8', flt8({ orders: [3], songLen: 1 }));       // odd -> logical pattern 1
put('flt8-two-logical.flt8', flt8({ orders: [0, 2], songLen: 2 }));  // orders 0,2 -> logical 0,1
put('flt8-incomplete-pair.flt8', flt8({ orders: [0], songLen: 1, dropBlock: 1 }));
put('flt8-ff-tail.flt8', flt8({ orders: [0], songLen: 1, tailFill: 0xff, onlyBlocks: 2 })); // FF tail -> logical 127 declared, 2 blocks present -> FORMAT
put('flt8-zero-songlen.flt8', flt8({ orders: [0], songLen: 0 }));

// --- manifest: sorted, no timestamps --------------------------------------
const entries = [...files.keys()].sort().map((name) => {
  const b = files.get(name);
  writeFileSync(join(outDir, name), b);
  return { name, size: b.length, sha256: sha256(b) };
});
const manifest = {
  generator: 'gen-fixtures.mjs', generatorSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), schema: 1,
  note: 'FORMAT fixtures only; no audio/parser acceptance is implied',
  files: entries,
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`gen-fixtures: ${entries.length} files -> ${outDir}`);
console.log(`manifest sha256: ${sha256(Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))}`);
