// SPDX-License-Identifier: GPL-2.0-or-later
// Deterministic DSS ZIP/FAT12 writers, independently checked by verify-package.
const DOS_TIME = 0, DOS_DATE = 0x0021;
// ---- deterministic store-only ZIP ---------------------------------------
const CRC_TAB = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c; } return t; })();
function crc32(b) { let c = 0xffffffff; for (const x of b) c = CRC_TAB[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function zipName(dos) { return dos; } // keep 8.3-style names verbatim
export function makeZip(entries) {
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
export function makeImg(entries) {
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

