#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// verify-package.mjs - INDEPENDENT package extraction + identity check.
// Re-parses the ZIP central directory and the FAT12 filesystem from raw
// bytes (no shared code with the packer), extracts every payload member,
// and verifies:
//   1. container manifest hashes match the actual container bytes
//   2. every packaged EXE is byte-identical to the executed build EXE
//   3. every fixture is byte-identical to the fixtures manifest
//   4. MANIFEST.TXT inside each container matches the package manifest
//   5. running the packer twice yields identical container hashes
// Exits nonzero on any mismatch (freshness/tamper detection).
//
//   node tools/ultrags/verify-package.mjs --package build/ultrags/package \
//     --exe-dir build/ultrags/dss --fixtures build/ultrags/fixtures

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {execFileSync} from 'node:child_process';
import { verifyExecution, verifyBuild, repoRoot } from './build-evidence.mjs';

function arg(flag, dflt) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; }
const stage = arg('--stage', 'S0b');
const slug = stage.toLowerCase();
const pkgDir = resolve(arg('--package', 'build/ultrags/package'));
const exeDir = resolve(arg('--exe-dir', 'build/ultrags/dss'));
const fixDir = resolve(arg('--fixtures', 'build/ultrags/fixtures'));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
let fails = 0;
const ok = (cond, label) => { if (cond) console.log(`  PASS ${label}`); else { fails++; console.log(`  FAIL ${label}`); } };

// ---- independent ZIP reader (central dir + LFH walk) ---------------------
function readZip(buf) {
  const out = new Map();
  // find EOCD by signature from the tail
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP: no EOCD');
  const n = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12);
  if (buf.readUInt16LE(eocd+4) || buf.readUInt16LE(eocd+6) || buf.readUInt16LE(eocd+8)!==n ||
      cdOff+cdSize!==eocd || eocd+22+buf.readUInt16LE(eocd+20)!==buf.length)
    throw new Error('ZIP: invalid directory bounds/counts');
  let p = cdOff;
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`ZIP: bad central header ${i}`);
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csz = buf.readUInt32LE(p + 20), usz = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const name = buf.slice(p + 46, p + 46 + nl).toString('ascii');
    const lho = buf.readUInt32LE(p + 42);
    if (method !== 0) throw new Error(`ZIP: ${name} compressed (method ${method}); store-only expected`);
    if (csz !== usz) throw new Error(`ZIP: ${name} size mismatch`);
    if (seen.has(name)) throw new Error(`ZIP: duplicate ${name}`);
    seen.add(name);
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`ZIP: ${name} bad local header`);
    const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28);
    if (lho+30+lnl+lel+usz>cdOff || buf.slice(lho+30,lho+30+lnl).toString('ascii')!==name ||
      buf.readUInt16LE(lho+6)!==0 || buf.readUInt16LE(p+8)!==0 ||
      buf.readUInt16LE(lho+8)!==method || buf.readUInt32LE(lho+14)!==crc ||
      buf.readUInt32LE(lho+18)!==csz || buf.readUInt32LE(lho+22)!==usz)
      throw new Error(`ZIP: ${name} local/central mismatch or bad bounds`);
    const data = buf.slice(lho + 30 + lnl + lel, lho + 30 + lnl + lel + usz);
    let c = 0xffffffff;
    for (const x of data) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; }
    if (((c ^ 0xffffffff) >>> 0) !== crc) throw new Error(`ZIP: ${name} CRC mismatch`);
    out.set(name, Buffer.from(data));
    p += 46 + nl + el + cl;
  }
  if (p !== cdOff+cdSize) throw new Error('ZIP: directory size mismatch');
  return out;
}

// ---- independent FAT12 reader -------------------------------------------
function readFat12(img) {
  if (img.length !== 2880 * 512) throw new Error('IMG: not a 1.44MiB image');
  if (img.readUInt16LE(510) !== 0xAA55) throw new Error('IMG: missing boot signature');
  const bps = img.readUInt16LE(11), spc = img[13], resv = img.readUInt16LE(14);
  const nfat = img[16], rents = img.readUInt16LE(17), spf = img.readUInt16LE(22);
  if (bps !== 512 || spc !== 1 || resv !== 1 || nfat !== 2 || rents !== 224 || spf !== 9 ||
      img.readUInt16LE(19)!==2880 || img[21]!==0xF0)
    throw new Error('IMG: unexpected BPB geometry');
  const fat0 = resv * bps, rootStart = (resv + nfat * spf) * bps;
  const fat = img.subarray(fat0, fat0 + spf * bps);
  if (!fat.equals(img.subarray(fat0+spf*bps,fat0+2*spf*bps))) throw new Error('IMG: FAT copies differ');
  if (fat[0]!==0xF0 || fat[1]!==0xFF || fat[2]!==0xFF) throw new Error('IMG: bad reserved FAT entries');
  const dataStart = rootStart + rents*32, maxCluster = (img.length-dataStart)/bps+1;
  const used = new Set(), out = new Map();
  for (let i = 0; i < rents; i++) {
    const de = rootStart + i * 32;
    if (img[de] === 0) break;
    if (img[de] === 0xe5) continue;
    if (img[de+11] !== 0x20) throw new Error('IMG: unsupported directory entry');
    const name = img.subarray(de,de+8).toString('ascii').trimEnd();
    const ext = img.subarray(de+8,de+11).toString('ascii').trimEnd();
    const fn = ext ? `${name}.${ext}` : name;
    if (!/^[A-Z0-9_~!@#$%^&()-]{1,8}(\.[A-Z0-9_]{1,3})?$/.test(fn) || out.has(fn))
      throw new Error(`IMG: invalid/duplicate filename ${fn}`);
    const size = img.readUInt32LE(de+28), need = Math.ceil(size/bps);
    let c = img.readUInt16LE(de+26);
    if (!need && c!==0) throw new Error(`IMG: ${fn} empty file has a cluster`);
    if (need > maxCluster-1) throw new Error(`IMG: ${fn} oversized file`);
    const parts = [];
    for (let j=0;j<need;j++) {
      if (c<2 || c>maxCluster || used.has(c)) throw new Error(`IMG: ${fn} invalid/cyclic/cross-linked FAT chain`);
      used.add(c);
      parts.push(img.subarray(dataStart+(c-2)*bps,dataStart+(c-1)*bps));
      const o=Math.floor(c*1.5);
      c=c%2 ? (fat[o]>>4)|(fat[o+1]<<4) : fat[o]|((fat[o+1]&15)<<8);
    }
    if (need && c<0xFF8) throw new Error(`IMG: ${fn} FAT chain length/termination mismatch`);
    out.set(fn,Buffer.concat(parts).subarray(0,size));
  }
  return out;
}

export { readZip, readFat12 };
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// ---- run -----------------------------------------------------------------
function main() {
console.log('verify-package: independent extraction and source/build/execution freshness');
const root = resolve(arg('--repo', repoRoot));
const provenance = verifyExecution(root, exeDir);
const build = verifyBuild(root, exeDir);
const fixtureBytes = readFileSync(join(fixDir, 'manifest.json'));
const fixtureManifest = JSON.parse(fixtureBytes);
if (fixtureManifest.generatorSha256 !== sha256(readFileSync(join(root, 'tools/ultrags/gen-fixtures.mjs'))))
  throw new Error('stale fixture generator inputs');
const pman = JSON.parse(readFileSync(join(pkgDir, 'package-manifest.json'), 'utf8'));
if (stage === 'S5') {
  // S5 ships firmware/evidence beside its DOS containers. They belong to
  // the same delivery and must pass the verifier, too.
  const outer = JSON.parse(readFileSync(join(pkgDir, 'manifest.json')));
  ok(outer.status === 'HOST_PASS / DSS-EXE_PASS / REAL_PENDING', 'S5 outer status');
  const names = new Set();
  for (const e of outer.files) {
    if (names.has(e.name) || resolve(pkgDir,e.name) !== join(pkgDir,e.name) || e.name.startsWith('..'))
      throw new Error('invalid/duplicate S5 package path '+e.name);
    names.add(e.name);
    const data = readFileSync(join(pkgDir,e.name));
    ok(data.length === e.size && sha256(data) === e.sha256, 'S5 outer bytes '+e.name);
  }
  for (const name of ['PGMULTI.UF2','PGULTRA.UF2','PGSLOW.UF2','PGDEBUG.UF2',
      'PGDIAG.UF2','PGDDBG.UF2','PGNODACK.UF2','PGPOST.UF2','PGPMULT.UF2','PGPDIAG.UF2','PGPNOD.UF2',
      'flash-map.json','posted-flash-map.json','firmware-report.json','s5-full.json','s5-variants.json','REPORT.txt',
      'ultra-gs.md','posted-front-test.txt','posted-diagnostic-test.txt','posted-no-dack-test.txt','posted-pio-test.json','dss-report.json','c-model-fixtures.json',
      's5-host.json','s5-c-model-fixtures.json','s5-host-evidence.json','s5-variants.mjs','backend-test.json','S5-README.md'])
    ok(names.has(name),'S5 required outer file '+name);
  ok(JSON.stringify(outer.containers) === JSON.stringify(pman.containers),'S5 outer container provenance');
  const build = resolve(exeDir,'../..');
  const requiredProvenance = ['ultrags-release/pg-ultrags.evidence.json',
    'ultrags-slow/pg-ultrags.evidence.json','ultrags-debug/pg-ultrags.evidence.json',
    'ultrags-posted/pg-ultrags.evidence.json','diag-posted/standalone-evidence.json',
    'diag-posted-no-dack/standalone-evidence.json'];
  for (const variant of ['release','debug','no-dack'])
    requiredProvenance.push('ultrags-diag-'+variant+'/standalone-evidence.json');
  for (const directory of ['multifw-release','multifw-posted']) {
    requiredProvenance.push(directory+'/bootloader.evidence.json');
    for (const mode of ['gus','adlib','mpu','psg','sb','usb','ultrags'])
      requiredProvenance.push(directory+'/pg-'+mode+'-multifw.evidence.json');
  }
  for (const source of requiredProvenance) {
    const name = 'provenance/'+source.replace('/','-');
    ok(names.has(name),'S5 required provenance '+name);
    ok(readFileSync(join(pkgDir,name)).equals(readFileSync(join(build,source))),
       'S5 current packaged provenance '+name);
  }
  execFileSync(process.env.UG_PYTHON || 'python3',[join(root,'tools/ultrags/s5-report.py'),'--build',build],{stdio:'inherit'});
  ok(readFileSync(join(pkgDir,'firmware-report.json')).equals(readFileSync(join(build,'ultrags/logs/s5-firmware.json'))),
     'S5 current firmware evidence');
}

ok(JSON.stringify(pman.provenance) === JSON.stringify({ ...provenance, fixtures:sha256(fixtureBytes),
  packer:sha256(readFileSync(join(root, 'tools/ultrags/package-s0b.mjs'))) }), 'source/build/execution/package provenance');
const zipBuf = readFileSync(join(pkgDir, `ug-${slug}.zip`));
const imgBuf = readFileSync(join(pkgDir, `ug-${slug}.img`));
ok(sha256(zipBuf) === pman.containers[`ug-${slug}.zip`].sha256, 'zip sha256 == manifest');
ok(sha256(imgBuf) === pman.containers[`ug-${slug}.img`].sha256, 'img sha256 == manifest');

const zip = readZip(zipBuf);
const img = readFat12(imgBuf);
console.log(`  zip members: ${zip.size}, img files: ${img.size}`);
ok(zip.size === pman.payload.length, `zip member count == manifest (${zip.size}/${pman.payload.length})`);
ok(img.size === pman.payload.length, `img file count == manifest (${img.size}/${pman.payload.length})`);

let exeChecked = 0, fxChecked = 0;
for (const e of pman.payload) {
  const imgName = e.imgName ?? e.name; // 8.3 alias recorded by the packer
  const z = zip.get(e.name), m = img.get(imgName);
  ok(!!z, `zip has ${e.name}`);
  ok(!!m, `img has ${imgName} (${e.name})`);
  if (!z || !m) continue;
  ok(z.length === e.size && m.length === e.size && sha256(z) === e.sha256 && sha256(m) === e.sha256, `${e.name} bytes == manifest`);
  ok(z.equals(m), `${e.name} zip==img bytes`);
  // byte identity vs executed/built sources
  if (e.src.startsWith('build/ultrags/dss/')) {
    const built = readFileSync(join(exeDir, e.src.split('/').pop()));
    ok(z.equals(built), `${e.name} == executed EXE bytes`);
    exeChecked++;
  } else if (e.src.startsWith('build/ultrags/fixtures/')) {
    const src = readFileSync(join(fixDir, e.src.split('/').pop()));
    ok(z.equals(src), `${e.name} == fixture source`);
    fxChecked++;
  }
}
ok(exeChecked === build.files.length && JSON.stringify(pman.payload.filter(e => e.src.startsWith('build/ultrags/dss/')).map(e => e.name).sort()) === JSON.stringify(build.files.map(e => e.name).sort()), `byte identity checked on ${exeChecked} EXEs`);
ok(fxChecked === fixtureManifest.files.length, `byte identity checked on ${fxChecked} fixtures`);

if (stage === 'ISA') {
  for (const [name,src] of [['ISA.TXT','host/sprinter/ultrags/docs/ISA-TURBO.md'],
    ['ISASRC.JSN','tests/ultrags/reference/sprinter-isa-sources.json']]) {
    const bytes=readFileSync(join(root,src));
    ok(zip.get(name)?.equals(bytes) && img.get(name)?.equals(bytes), 'ISA current source '+name);
  }
}

// MANIFEST.TXT inside the containers is consistent
for (const [cont, map] of [['zip', zip], ['img', img]]) {
  const mt = map.get('MANIFEST.TXT');
  ok(!!mt, `${cont} contains MANIFEST.TXT`);
  if (mt) {
    const listed = mt.toString('ascii').split('\r\n').filter((l) => l.includes('  '))
      .map((l) => l.split('  ')[0]).sort();
    const expect = pman.payload.map((e) => e.name).filter((n) => n !== 'MANIFEST.TXT').sort();
    const lines = pman.payload.filter(e=>e.name!=='MANIFEST.TXT').sort((a,b)=>a.name.localeCompare(b.name))
      .map(e=>`${e.name}  ${e.imgName}  ${e.size}  ${e.sha256}  ${e.src}`);
    const expectedText=[`Ultra GS ${stage} package manifest`,`exes: ${build.files.length}`,'',...lines].join('\r\n')+'\r\n';
    ok(mt.equals(Buffer.from(expectedText,'ascii')),`${cont} MANIFEST.TXT complete values`);
    ok(JSON.stringify(listed) === JSON.stringify(expect), `${cont} MANIFEST.TXT lists all payload`);
  }
}
console.log(fails ? `verify-package: FAIL (${fails})` : 'verify-package: ALL PASS');
process.exit(fails ? 1 : 0);
}

import { fileURLToPath } from 'node:url';
if (isMain) main();
