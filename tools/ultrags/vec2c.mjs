#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// vec2c.mjs - mechanical converter: tests/ultrags/protocol/vectors.json ->
// build/gen/vectors-expected.h. This is NOT a serializer: it reformats
// handwritten expected bytes into C arrays. The schema generator never sees
// or produces these values.
// Usage: node vec2c.mjs <vectors.json> <out.h>
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error('usage: vec2c.mjs <vectors.json> <out.h>'); process.exit(2); }
const v = JSON.parse(readFileSync(src, 'utf8'));

const toBytes = (s) => (s === '' || s === undefined ? [] : s.trim().split(/\s+/).map((h) => parseInt(h, 16)));
const emit = (name, bytes) =>
  `static const unsigned char ${name}[] = {${bytes.map((b) => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(',')}};\n` +
  `static const unsigned int ${name}_LEN = ${bytes.length};\n`;

let out = '/* Mechanical reformat of vectors.json - do not edit. */\n#ifndef VECTORS_EXPECTED_H\n#define VECTORS_EXPECTED_H\n\n';
let n = 0;
for (const f of v.frames || []) {
  if (f.expect_request) { out += emit(`V_REQ_${f.name.toUpperCase()}`, toBytes(f.expect_request)); n++; }
  if (f.expect_request_prefix) { out += emit(`V_REQP_${f.name.toUpperCase()}`, toBytes(f.expect_request_prefix)); n++; }
  if (f.expect_request_trailer) { out += emit(`V_REQT_${f.name.toUpperCase()}`, toBytes(f.expect_request_trailer)); n++; }
  if (f.resp_ok) { out += emit(`V_RESP_${f.name.toUpperCase()}`, toBytes(f.resp_ok)); n++; }
  if (f.expect_resp_header) { out += emit(`V_RH_${f.name.toUpperCase()}`, toBytes(f.expect_resp_header)); n++; }
}
for (const e of v.le_encoding || []) {
  out += emit(`V_LE_${e.name.toUpperCase()}`, toBytes(e.expect)); n++;
}
out += '\n#endif\n';
writeFileSync(dst, out);
console.log(`vec2c: ${n} expected arrays -> ${dst}`);
