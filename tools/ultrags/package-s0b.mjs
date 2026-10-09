#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// package-s0b.mjs - honest S0b stage package builder.
// Produces, deterministically (fixed DOS timestamp, sorted entries,
// store-only ZIP, zero-padded FAT12 image):
//   <out>/ug-s0b.zip  - EXEs + fixtures + HELP.TXT + MANIFEST.TXT + LICENSE
//   <out>/ug-s0b.img  - 1.44MiB FAT12 DSS-readable image, same payload set
//   <out>/package-manifest.json - sha256/size of every payload + container
//
//   node tools/ultrags/package-s0b.mjs --exe-dir build/ultrags/dss \
//     --fixtures build/ultrags/fixtures --out build/ultrags/package
//
// Scope is declared in HELP.TXT: this is NOT the production 13.2 bundle
// (no UGCFG/eight apps/seven-mode firmware - those are later stages).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBuild, verifyExecution } from './build-evidence.mjs';

function arg(flag, dflt) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; }
const stage = arg('--stage', 'S0b');
if (!['S0b','S1','S2','S3'].includes(stage)) throw new Error('unknown package stage');
const slug = stage.toLowerCase();
const exeDir = resolve(arg('--exe-dir', 'build/ultrags/dss'));
const fixDir = resolve(arg('--fixtures', 'build/ultrags/fixtures'));
const outDir = resolve(arg('--out', 'build/ultrags/package'));
const repoRoot = resolve(arg('--repo', fileURLToPath(new URL('../..', import.meta.url))));
const provenance = verifyExecution(repoRoot, exeDir);
const assembly = verifyBuild(repoRoot, exeDir);
mkdirSync(outDir, { recursive: true });

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const DOS_TIME = 0, DOS_DATE = 0x0021; // 1980-01-01 00:00:00 - fixed for determinism

// ---- payload assembly ----------------------------------------------------
const payload = new Map(); // canonical name -> {buf, src, imgName}
// DOS 8.3 compliance: names longer than 8.3 get a deterministic ~N alias;
// the canonical<->imgName mapping is recorded in MANIFEST.TXT/manifest.json
const imgNames = new Set();
let aliasSeq = 0;
function imgNameFor(name) {
  const [b, e = ''] = name.split('.');
  const ok83 = b.length <= 8 && e.length <= 3 && /^[A-Z0-9_-]+$/.test(b) && /^[A-Z0-9_-]*$/.test(e);
  if (ok83 && !imgNames.has(name)) return name;
  for (;;) {
    const s = String(aliasSeq++);
    const cand = `${b.slice(0, 7 - s.length)}~${s}${e ? '.' + e.slice(0,3) : ''}`; // base <= 8 chars
    if (!imgNames.has(cand)) return cand;
  }
}
function add(name, buf, src) {
  if (payload.has(name)) throw new Error(`duplicate payload name ${name}`);
  const img = imgNameFor(name);
  imgNames.add(img);
  payload.set(name, { buf: Buffer.from(buf), src, imgName: img });
}
const exes = assembly.files.map(e => e.name).sort();
if (!exes.length) throw new Error(`no EXEs in ${exeDir} (run 'make -f Makefile.ultrags dss' first)`);
for (const f of exes) add(f.toUpperCase(), readFileSync(join(exeDir, f)), join('build/ultrags/dss', f));

const fixtureManifestBytes = readFileSync(join(fixDir, 'manifest.json'));
const fixMan = JSON.parse(fixtureManifestBytes);
if (fixMan.generatorSha256 !== sha256(readFileSync(join(repoRoot, 'tools/ultrags/gen-fixtures.mjs'))))
  throw new Error('stale fixture generator inputs; regenerate fixtures');
// DOS 8.3 name: 'raw-u8-mono-8000.raw' -> 'FX_RAWU8.RAW' (unique via index)
let fxIdx = 0;
for (const e of fixMan.files) {
  const b = readFileSync(join(fixDir, e.name));
  const want = sha256(b);
  if (want !== e.sha256) throw new Error(`stale fixture ${e.name}: ${want} != manifest ${e.sha256}`);
  const ext = (e.name.split('.').pop() || 'BIN').toUpperCase().slice(0, 3);
  const base = ('FX' + String(fxIdx++).padStart(2, '0') + '_' + e.name.split('.')[0].toUpperCase().replace(/[^A-Z0-9]/g, '')).slice(0, 8);
  add(`${base}.${ext}`, b, join('build/ultrags/fixtures', e.name));
}

const help = stage === 'S3' ? [
  'Ultra GS S3 memory stage - HOST_PASS / DSS-EXE_PASS / REAL_PENDING',
  'UGCFG MODE ULTRAGS -> UGMEM INFO -> UGMEM TEST QUICK -> UGMEM TEST FULL',
  'Expected on APS6404L: physical=pool=8388608; first_bad=0xFFFFFFFF.',
  'RESET WARM/COLD destroys all objects and changes session; no Flash writes.',
  'COLD also performs QUICK. TEST requires an empty store.',
  'UGMEM LIST; FREE handle; /SLOT:0|1 /BASE:hex /QUIET /VERIFY /?',
  'FULL deadline 120s; ESC cancels between card-side slices. No hidden BUSY reset.',
  'ROUNDTRIP, upload/SEAL/GS music/playback are not implemented until later stages.',
  'UGMEM supports both PGMULTI and standalone PGULTRA, protocol4/API1.0.',
  'PGSLOW is the separate nominal 50MHz SCK profile; PGULTRA uses 100MHz.',
  'These are calculated profiles; real PSRAM clocks/temperature remain pending.',
  'PGULTRA/PGSLOW replace multifw. UGCFG MODE needs the PGMULTI bundle.',
  'UGTEST/UGBENCH target ONLY standalone S1 diagnostic firmware.',
  'ST-*.EXE are intentionally defective HOST fixtures, never hardware utilities.',
  'Read S3-README.md, firmware-report.json and flash-map.json beside the firmware.',
].join('\r\n') : stage === 'S2' ? [
  'Ultra GS S2 configuration stage - HOST_PASS / DSS-EXE_PASS / REAL_PENDING',
  'UGCFG.EXE targets PGMULTI.UF2: seven modes, protocol4 and UGCF v1.0.',
  'UGCFG LIST -> MODE ULTRAGS -> VERIFY -> MODE GUS',
  'MODE ULTRAGS /SAVE persists startup mode. MODE without SAVE is volatile.',
  'PORTS 02A0 OFF /SAVE; GSALIAS ON is volatile and warns about conflicts.',
  'SAVE, power-cycle and RESET DRV require physical Sprinter acceptance.',
  'UGTEST/UGBENCH target ONLY standalone ULTRAGS_DIAG firmware from S1.',
  'UGDIAG and ST-*.EXE target the HOST model; not hardware utilities.',
  'ST-*.EXE include intentionally defective binaries. Never run on hardware.',
  'PGULTRA.UF2 is standalone at Flash origin: it replaces the bootloader.',
  'Standalone ULTRAGS has no multifw catalogue; UGCFG changes are refused.',
  'Keep a full-flash backup; restore PGMULTI.UF2 using BOOTSEL/SWD for recovery.',
  'No storage, MOD/PCM playback or complete GS dispatcher in this stage.',
  'Read S2-README.md and flash-map.json supplied beside the firmware.',
].join('\r\n') : stage === 'S1' ? [
  'Ultra GS S1 standalone diagnostic package',
  'HOST_PASS / DSS-EXE_PASS / REAL_PENDING. Not the production mode8 bundle.',
  'UGTEST BUS /SLOT:0 /CPU:21 (1048576 bytes in each direction).',
  '/MIRROR means the bench is isolated; disabled by default.',
  'UGBENCH /BYTES:65536 /LOOPS:4 /BLOCK:256 /CHECK:BOTH /CPU:UNKNOWN',
  'Only METHOD:FIXED is implemented. METHOD:ALL prints explicit SKIP reasons.',
  'Repeat with BLOCK:512 and 1024 and CPU:3.5. /CPU does not switch CPU.',
  '/SPIKE:1 or 2 starts a 64-second core1 spike; /SOAK:65 supplies ISA traffic.',
  'Time resolution is 1 second. Short intervals are insufficient for speed.',
  'ST-*.EXE are intentionally defective harness tests: never run on hardware.',
  'Firmware is supplied separately: standalone origin 0x10000000.',
  'Read host/sprinter/ultrags/docs/S1-README.md for backup, BOOTSEL recovery and REAL gates.',
].join('\r\n') : [
  'Ultra GS stage S0b package (incomplete stage artifact)',
  '=======================================================',
  '',
  'Contents: assembled Sprinter DSS EXE diagnostics + self-tests,',
  'synthetic RAW/WAV/MOD/FLT8 format fixtures, provenance manifest.',
  '',
  'This is a STAGE artifact, not the production bundle of TZ 13.2:',
  'UGCFG and the eight utility apps, and the seven-mode multifw image',
  'are planned for later stages. REAL hardware gates remain PENDING.',
  '',
  'UGDIAG.EXE runs the register/protocol roundtrip against an Ultra GS',
  'card at base 02A0h, ISA slot 0; no CLI arguments in this stage.',
  'UGTEST BUS and UGBENCH target the standalone S1 SRAM diagnostic.',
  'See host/sprinter/ultrags/docs/S1-README.md before a REAL bench run.',
  'ST-*.EXE are harness self-tests, including intentionally defective',
  'programs; run them through make test-dss, not on real hardware.',
  '',
  'License: GPL-2.0-or-later (see LICENSE.TXT).',
  '',
].join('\r\n');
add('HELP.TXT', Buffer.from(help, 'ascii'), 'generated');
if (stage==='S1') add('README.MD', readFileSync(join(repoRoot,'host/sprinter/ultrags/docs/S1-README.md')), 'host/sprinter/ultrags/docs/S1-README.md');
const license = [
  'Ultra GS S0b package',
  '',
  'Firmware-side and host-side sources carry SPDX-License-Identifier:',
  'GPL-2.0-or-later per file headers, following upstream picogus.',
  'Reference/third-party licenses live under tests/ultrags/reference/.',
  '',
].join('\r\n');
add('LICENSE.TXT', Buffer.from(license, 'ascii'), 'generated');

// manifest.txt embedded in both containers
function buildManifestTxt() {
  const lines = [`Ultra GS ${stage} package manifest`, `exes: ${exes.length}`, ''];
  for (const [name, p] of [...payload.entries()].sort()) {
    if (name === 'MANIFEST.TXT') continue;
    lines.push(`${name}  ${p.imgName}  ${p.buf.length}  ${sha256(p.buf)}  ${p.src}`);
  }
  return Buffer.from(lines.join('\r\n') + '\r\n', 'ascii');
}
add('MANIFEST.TXT', buildManifestTxt(), 'generated');

// ---- deterministic store-only ZIP ---------------------------------------
const CRC_TAB = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c; } return t; })();
function crc32(b) { let c = 0xffffffff; for (const x of b) c = CRC_TAB[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function zipName(dos) { return dos; } // keep 8.3-style names verbatim
function makeZip(entries) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, buf] of entries) {
    const n = Buffer.from(zipName(name), 'ascii'), crc = crc32(buf);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(buf.length, 18); lh.writeUInt32LE(buf.length, 22);
    lh.writeUInt16LE(n.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, n, buf);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(buf.length, 20);
    ch.writeUInt32LE(buf.length, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(Buffer.concat([ch, n]));
    off += 30 + n.length + buf.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50); eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

// ---- FAT12 1.44MiB image -------------------------------------------------
const SECTORS = 2880, SPF = 9, ROOT_ENTS = 224, ROOT_SECTS = 14, DATA_START = 1 + 2 * SPF + ROOT_SECTS;
const CLUSTERS_FREE = SECTORS - DATA_START; // cluster = 1 sector
function makeImg(entries) {
  const img = Buffer.alloc(SECTORS * 512, 0);
  const bpb = img;
  bpb[0] = 0xeb; bpb[1] = 0x3c; bpb[2] = 0x90;
  bpb.write('MSDOS5.0', 3, 'ascii');
  bpb.writeUInt16LE(512, 11); bpb[13] = 1; bpb.writeUInt16LE(1, 14);
  bpb[16] = 2; bpb.writeUInt16LE(ROOT_ENTS, 17); bpb.writeUInt16LE(SECTORS, 19);
  bpb[21] = 0xf0; bpb.writeUInt16LE(SPF, 22); bpb.writeUInt16LE(18, 24); bpb.writeUInt16LE(2, 26);
  bpb.writeUInt32LE(0, 28); bpb.writeUInt32LE(0, 32);
  bpb[38] = 0x29; bpb.write('ULTRAGS S0B ',43,'ascii'); bpb.write('FAT12   ',54,'ascii');
  bpb.writeUInt16LE(0xAA55,510);
  const fat0 = 512;
  img[fat0] = 0xf0; img[fat0 + 1] = 0xff; img[fat0 + 2] = 0xff;
  let cl = 2, rootOff = (1 + 2 * SPF) * 512, dataOff = DATA_START * 512;
  const dirEntries = [];
  for (const [name, buf] of entries) {
    const need = Math.ceil(buf.length / 512);
    if (cl + need - 2 > CLUSTERS_FREE || dirEntries.length >= ROOT_ENTS)
      throw new Error(`image overflow at ${name} (need ${need} clusters)`);
    const de = Buffer.alloc(32);
    const [base, ext] = name.split('.');
    de.write(base.padEnd(8, ' ').slice(0, 8), 0, 'ascii');
    de.write((ext ?? '').padEnd(3, ' ').slice(0, 3), 8, 'ascii');
    de[11] = 0x20; // archive
    de.writeUInt16LE(DOS_TIME, 22); de.writeUInt16LE(DOS_DATE, 24);
    de.writeUInt16LE(need ? cl : 0, 26); de.writeUInt32LE(buf.length, 28);
    dirEntries.push(de);
    for (let i = 0; i < need; i++) {
      const next = i + 1 < need ? cl + i + 1 : 0xfff;
      const fo = fat0 + Math.floor((cl + i) * 1.5);
      const v = next;
      if ((cl + i) % 2 === 0) { img[fo] = v & 0xff; img[fo + 1] = (img[fo + 1] & 0xf0) | ((v >> 8) & 0x0f); }
      else { img[fo] = (img[fo] & 0x0f) | ((v << 4) & 0xf0); img[fo + 1] = (v >> 4) & 0xff; }
      buf.copy(img, dataOff + (cl + i - 2) * 512, i * 512, (i + 1) * 512);
    }
    cl += need;
  }
  Buffer.concat(dirEntries).copy(img, rootOff);
  img.copy(img, fat0 + SPF * 512, fat0, fat0 + SPF * 512); // copy FAT to FAT2
  return img;
}

const sorted = [...payload.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, p]) => [n, p.buf]);
const imgSorted = [...payload.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, p]) => [p.imgName, p.buf]);
const zipBuf = makeZip(sorted);
const imgBuf = makeImg(imgSorted);
writeFileSync(join(outDir, `ug-${slug}.zip`), zipBuf);
writeFileSync(join(outDir, `ug-${slug}.img`), imgBuf);
const pman = {
  stage: 'S0b', schema: 2, deterministic: true,
  provenance: { ...provenance, fixtures: sha256(fixtureManifestBytes),
    packer: sha256(readFileSync(fileURLToPath(import.meta.url))) },
  scope: 'stage artifact; production 13.2 bundle NOT included (later stages)',
  containers: {
    [`ug-${slug}.zip`]: { size: zipBuf.length, sha256: sha256(zipBuf) },
    [`ug-${slug}.img`]: { size: imgBuf.length, sha256: sha256(imgBuf) },
  },
  payload: sorted.map(([n, b]) => ({ name: n, imgName: payload.get(n).imgName, size: b.length, sha256: sha256(b), src: payload.get(n).src })),
};
writeFileSync(join(outDir, 'package-manifest.json'), JSON.stringify(pman, null, 2) + '\n');
console.log(`package: ${sorted.length} entries -> ${outDir}`);
console.log(`  ug-s0b.zip ${zipBuf.length}B sha256 ${sha256(zipBuf)}`);
console.log(`  ug-s0b.img ${imgBuf.length}B sha256 ${sha256(imgBuf)}`);
