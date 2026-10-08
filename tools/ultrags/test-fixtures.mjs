#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture structure/content checks independent of the generator. No parser
// or audio-engine acceptance is inferred from these checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './build-evidence.mjs';
const [a,b] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(a,'manifest.json')));
assert.deepEqual(readFileSync(join(a,'manifest.json')),readFileSync(join(b,'manifest.json')));
const read = name => readFileSync(join(a,name));
for (const e of manifest.files) {
  const bytes = read(e.name);
  assert.equal(bytes.length,e.size,e.name);
  assert.equal(sha256(bytes),e.sha256,e.name);
  assert.deepEqual(bytes,readFileSync(join(b,e.name)),`${e.name} determinism`);
}
for (const label of ['u8','s8','s16le']) for (const ch of [1,2]) {
  const bytes = read(`raw-${label}-${ch===1?'mono':'stereo'}-endpoints.raw`);
  const values = label==='u8' ? [0,128,255] : label==='s8' ? [-128,0,127] : [-32768,0,32767];
  const want = values.flatMap(v=>Array(ch).fill(v));
  const actual = label==='u8' ? [...bytes] : label==='s8' ? [...bytes].map((_,i)=>bytes.readInt8(i)) :
    Array.from({length:bytes.length/2},(_,i)=>bytes.readInt16LE(i*2));
  assert.deepEqual(actual,want);
}
for (const rate of [8000,11025,22050,44100,48000]) for (const ch of [1,2]) {
  for (const [label,width] of [['u8',1],['s8',1],['s16le',2]])
    assert.equal(read(`raw-${label}-${ch===1?'mono':'stereo'}-${rate}.raw`).length,Math.floor(rate*.02)*ch*width);
  for (const [label,bits] of [['u8',8],['s16le',16]]) {
    const w = read(`wav-${label}-${ch===1?'mono':'stereo'}-${rate}.wav`);
    assert.equal(w.readUInt32LE(4)+8,w.length);
    assert.equal(w.readUInt16LE(22),ch); assert.equal(w.readUInt32LE(24),rate);
    assert.equal(w.readUInt16LE(34),bits); assert.equal(w.readUInt32LE(40),w.length-44);
  }
}
// M!K! is four channels; a positive FLT8 pair must have both distinct
// halves and exactly the sample area declared in its header (32 words).
const mik = read('mod-mik-4ch.mod'); assert.equal(mik.length,1084+1024+64);
const f = read('flt8-basic.flt8'); assert.equal(f.length,1084+2*1024+64);
assert.equal(f.readUInt16BE(42)*2,64);
assert.notDeepEqual(f.subarray(1084,2108),f.subarray(2108,3132));
assert.equal(f[1086],0x10); // sample 1, rather than a silent sample 0 note
for (const kind of ['valid','oob']) {
  const m=read(`mod-loop-${kind}.mod`);
  const end=(m.readUInt16BE(46)+m.readUInt16BE(48))*2;
  assert.equal(end <= m.readUInt16BE(42)*2,kind==='valid');
}
console.log(`fixtures PASS: ${manifest.files.length} byte-identical files; independent endpoint/rate/WAV/MOD/FLT8 checks`);
