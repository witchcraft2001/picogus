#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
//
// stage-excerpt.mjs - normative stage excerpt generator (TZ 13.5).
// Reads ultra-gs.md, finds a stage (S0a..S11) by heading, expands its
// "Чтение:" reference list, and emits a derived excerpt containing the
// referenced sections verbatim plus mandatory 1/2/16/17 and the stage
// block itself.  The output is NOT a second source of requirements.
//
//   node tools/ultrags/stage-excerpt.mjs --stage S5 --output out.md
//
// Errors (hard fail): unknown stage, unresolved/ambiguous reference,
// missing referenced section, output path equal to the source MD.
// Determinism: fixed content order, no timestamps, no line numbers.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SPEC = resolve(repoRoot, 'ultra-gs-docs/ultra-gs.md');

function fail(msg) { console.error(`stage-excerpt: error: ${msg}`); process.exit(1); }
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function parseArgs(argv) {
  const a = { stage: null, output: null, spec: DEFAULT_SPEC };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--stage') a.stage = argv[++i];
    else if (argv[i] === '--output') a.output = argv[++i];
    else if (argv[i] === '--spec') a.spec = resolve(argv[++i]);
    else fail(`unknown argument '${argv[i]}'`);
  }
  if (!a.stage || !a.output) fail('usage: stage-excerpt.mjs --stage <S0a..S11> --output <file> [--spec md]');
  return a;
}

// ---------------------------------------------------------------------------
// markdown structure: split into numbered sections (## N.) and subsections
// (### N.M. / ### N.M.K).  Stage headings "### S0a." etc. live inside 15.
// ---------------------------------------------------------------------------

const H2 = /^## (\d+)\.\s+(.*)$/;                // top-level numbered section
const HN = /^#{3,4} (\d+(?:\.\d+)+)\.\s+(.*)$/;  // numbered subsection (### N.M / #### N.M.K)
const HST = /^### (S\d+[ab]?)\.\s+(.*)$/;        // stage heading inside 15

function* linesOf(text) { let s = 0; for (;;) { const e = text.indexOf('\n', s); yield e < 0 ? [text.slice(s), s, text.length] : [text.slice(s, e), s, e + 1]; if (e < 0) return; s = e + 1; } }

function parseDoc(text) {
  // sections map: id ("5", "5.2", "17.1") -> {id, title, start, end, level}
  const sections = new Map();
  const stages = new Map(); // S0b -> {id, title, start, end}
  const order = [];
  const marks = [];
  let fenced = false;
  for (const [line, start, end] of linesOf(text)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    let m;
    if ((m = line.match(H2))) marks.push({ kind: 'sec', id: m[1], title: m[2].trim(), start });
    else if ((m = line.match(HN))) marks.push({ kind: 'sec', id: m[1], title: m[2].trim(), start });
    else if ((m = line.match(HST))) marks.push({ kind: 'stage', id: m[1], title: m[2].trim(), start });
    else if (/^## /.test(line) || /^### /.test(line)) marks.push({ kind: 'other', start });
  }
  for (let i = 0; i < marks.length; i++) {
    const mk = marks[i];
    const level = text.slice(mk.start).match(/^#+/)[0].length;
    const next = marks.slice(i + 1).find(m => text.slice(m.start).match(/^#+/)[0].length <= level);
    const end = next ? next.start : text.length;
    if (mk.kind === 'sec') {
      if (sections.has(mk.id)) fail(`ambiguous section §${mk.id}: duplicate heading`);
      sections.set(mk.id, { ...mk, end }); order.push(mk.id);
    } else if (mk.kind === 'stage') {
      if (stages.has(mk.id)) fail(`ambiguous stage ${mk.id}: duplicate heading`);
      stages.set(mk.id, { ...mk, end });
    }
  }
  return { sections, stages, order };
}

// ids that "contain" a given section: "8.3" is inside "8", "9.2.1" inside "9.2".
function isInside(id, parent) { return id === parent || id.startsWith(parent + '.'); }

// ---------------------------------------------------------------------------
// Чтение: reference grammar (as used by all 14 stage blocks):
//   "§2-4" range            -> sections 2,3,4
//   "§9"                    -> section 9
//   "§17.1"                 -> subsection 17.1
//   "§3.2/3.6"              -> subsections 3.2 and 3.6
//   "§9.2-9.3"              -> subsection range inside 9
//   "§5-8.1/8.4"            -> range 5..8.1 + subsection 8.4 (superset: all of 8)
//   "§14 B05/B06/C00"       -> test ids -> whole 14
//   "P/M-тесты §14"         -> test classes -> whole 14
//   "§3 целиком"            -> section 3
//   "§17 пункт 6"           -> section 17
//   "reports S1/S5/S8a"     -> stage blocks S1,S5,S8a (conservative superset)
//   "§13-18"                -> range through 18
// Free prose without § / ids is an obligation note, not a section reference.
// ---------------------------------------------------------------------------

const SEC_REF = /^§(\d+(?:\.\d+)*)(?:[–-](\d+(?:\.\d+)*))?(?:\/(\d+(?:\.\d+)*))*$/;
const TEST_ID = /^[A-Z]{1,2}\d{2}$/;

function expandNumeric(lo, hi, ctx) {
  // numeric range "a-b": same dotted depth -> expand last component
  const la = lo.split('.').map(Number), lb = hi.split('.').map(Number);
  if (lb[0] < la[0]) fail(`malformed range '${ctx}': ${lo}-${hi} descends`);
  if (la.length !== lb.length || la.slice(0, -1).join('.') !== lb.slice(0, -1).join('.')) {
    // e.g. "5-8.1": expand top-level 5..8, then endpoint subsection 8.1
    const out = [];
    for (let n = la[0]; n <= lb[0]; n++) out.push(String(n));
    out.push(hi); // exact endpoint subsection too (superset of the tail)
    return out;
  }
  const out = [];
  const base = la.slice(0, -1), a0 = la[la.length - 1], b0 = lb[lb.length - 1];
  if (b0 < a0) fail(`malformed range '${ctx}': ${lo}-${hi} descends`);
  for (let n = a0; n <= b0; n++) out.push([...base, n].join('.'));
  return out;
}

function parseReading(readText, sections, stages, text) {
  const wanted = new Set();
  const wantedStages = new Set();
  const addSec = (id, ctx) => {
    if (sections.has(id)) { wanted.add(id); return; }
    // depth >= 3 ids that lack a heading are numbered list items inside the
    // parent subsection (e.g. "8.3.6" = item 6 of §8.3): the conservative
    // superset includes the whole parent.  A missing depth-2 subsection is a
    // genuinely broken reference.
    if (id.split('.').length >= 3) {
      const parent = id.split('.').slice(0, -1).join('.');
      const item = id.split('.').at(-1);
      const p = sections.get(parent);
      if (p && new RegExp(`^${item}\\.\\s`, 'm').test(text.slice(p.start, p.end))) {
        wanted.add(parent); return;
      }
    }
    fail(`unresolved reference '${ctx}': section §${id} does not exist in the MD`);
  };
  // split the reading list into comma/semicolon/period-separated items;
  // the line ends at "**Работы:**" or a full stop before it.
  const body = readText.replace(/\*\*Работы[:：].*$/s, '').replace(/\s+/g, ' ').trim();
  const items = body.split(/[;,]|(?<=\S)\.\s+/).map((s) => s.trim()).filter(Boolean);
  for (const itemRaw of items) {
    const item = itemRaw.replace(/[.。]+$/, '').trim();
    if (!item) continue;
    // item may contain several § tokens, e.g. "§14 B05/B06/C00" or
    // "§3.2/3.6" or "P/M-тесты §14" or "§2.3 R01-R12"
    const secTokens = item.match(/§\d+(?:\.\d+)*(?:[–-]\d+(?:\.\d+)*)?/g) || [];
    let bare = item;
    for (const t of secTokens) bare = bare.replace(t, ' ');
    if (bare.includes('§')) fail(`malformed reference in '${itemRaw}'`);
    bare = bare.replace(/\([^)]*\)/g, ' ');
    const idTokens = bare.match(/\b[A-Z]{1,2}\d{2}\b/g) || [];
    const stageTokens = bare.match(/\bS\d+[ab]?\b/g) || [];
    const hasExplicit14 = /§14/.test(item);
    if (!secTokens.length && !idTokens.length && !stageTokens.length) continue; // prose obligation
    for (const t of secTokens) {
      const norm = t.replace(/–/g, '-');
      const m = norm.match(/^§(\d+(?:\.\d+)*)(?:-(\d+(?:\.\d+)*))?$/);
      if (!m) fail(`malformed reference '${t}' in '${itemRaw}'`);
      if (m[2]) {
        addSec(m[1], itemRaw); addSec(m[2], itemRaw);
        for (const id of expandNumeric(m[1], m[2], itemRaw)) addSec(id, itemRaw);
      }
      else addSec(m[1], itemRaw);
    }
    // slash extras after a § ref are ABSOLUTE section ids:
    //   "§3.2/3.6" -> §3.6   "§5-8.1/8.4" -> §8.4   "§7.4/7.6/7.8" -> 7.6, 7.8
    for (const m of item.matchAll(/\/(\d+(?:\.\d+)*)/g)) addSec(m[1], itemRaw);
    // residual check: after consuming every recognized token, any leftover
    // digit means a malformed/unresolved numeric reference (e.g. "§3..9")
    const residual = bare
      .replace(/\/\d+(?:\.\d+)*/g, ' ')
      .replace(/\b[A-Z]{1,2}\d{2}\b/g, ' ')
      .replace(/\bS\d+[ab]?\b/g, ' ')
      .replace(/пункт\s*\d+/g, ' ')
      .replace(/\d+\s*[–-]\s*\d+/g, ' '); // consumed range tails
    if (/\d/.test(residual)) fail(`malformed/ambiguous reference in '${itemRaw}'`);
    if (idTokens.length && !hasExplicit14 && !/§17/.test(item)) {
      // test ids (B05, G01...) resolve to their owning 14 checks section
      addSec('14', itemRaw);
    }
    if (hasExplicit14) addSec('14', itemRaw);
    for (const st of stageTokens) {
      if (!stages.has(st)) fail(`unresolved stage reference '${st}' in '${itemRaw}'`);
      wantedStages.add(st);
    }
    // D0x ids live in 17.1
    if (/\bD\d{2}\b/.test(bare)) addSec('17.1', itemRaw);
  }
  return { wanted, wantedStages, body };
}

// ---------------------------------------------------------------------------

function main() {
  const a = parseArgs(process.argv);
  const specPath = resolve(a.spec);
  const outPath = resolve(a.output);
  if (specPath === outPath) fail('refusing to overwrite the source MD');
  const mdBuf = readFileSync(specPath);
  if (existsSync(outPath)) {
    const a = statSync(specPath), b = statSync(outPath);
    if (a.dev === b.dev && a.ino === b.ino) fail('refusing to overwrite the source MD through an alias');
  }
  const text = mdBuf.toString('utf8');
  const srcHash = sha256(mdBuf);
  const verM = text.slice(0, 4000).match(/(?:Версия ТЗ|version)[^\n]*?(\d+\.\d+)/i);
  const version = verM ? verM[1] : 'unknown';

  const { sections, stages, order } = parseDoc(text);
  const stage = stages.get(a.stage);
  if (!stage) fail(`unknown stage '${a.stage}' (known: ${[...stages.keys()].join(', ')})`);
  const stageText = text.slice(stage.start, stage.end);
  const rm = stageText.match(/\*\*Чтение:\*\*\s*(.+?)(?=\n\*\*|\n\n|\*\*Работы)/s);
  if (!rm) fail(`stage '${a.stage}' has no 'Чтение:' block`);

  const { wanted, wantedStages, body } = parseReading(rm[1], sections, stages, text);

  // mandatory: 1, 2, 16, 17 + the stage itself
  for (const id of ['1', '2', '16', '17']) {
    if (!sections.has(id)) fail(`mandatory section §${id} missing from MD`);
    wanted.add(id);
  }
  if (!sections.has('17.1')) fail('mandatory section §17.1 missing from MD');
  wanted.add('17.1'); // D01/D02 live here; dedup handles nesting

  // expansion: including a parent pulls in all descendants; dedup nested
  const expanded = new Set();
  for (const id of order) {
    for (const w of wanted) if (isInside(id, w)) expanded.add(id);
  }
  const included = order.filter((id) => expanded.has(id));
  if (!included.length) fail('reference expansion produced an empty excerpt');

  const out = [];
  out.push('<!--');
  out.push('  Ultra GS stage excerpt (TZ 13.5) - DERIVED VIEW, NOT NORMATIVE.');
  out.push(`  source: ultra-gs.md version ${version}`);
  out.push(`  source sha256: ${srcHash}`);
  out.push(`  stage: ${a.stage} - ${stage.title}`);
  out.push(`  reading list: ${body}`);
  out.push('  included sections:');
  for (const id of included) out.push(`    - §${id} ${sections.get(id).title}`);
  for (const st of wantedStages) out.push(`    - stage ${st} ${stages.get(st).title}`);
  out.push('  References to sections not listed here require the full source MD.');
  out.push('-->');
  out.push('');
  const blocks = [...included.map(id => sections.get(id)),
    ...[...wantedStages].map(st => stages.get(st)), stage];
  // Emit each selected span once, with complete parent sections (including
  // their unnumbered paragraphs/stages). Dedup by source spans, not text.
  const selected = blocks.filter((b, i) => !blocks.some((p, j) =>
    p.start <= b.start && p.end >= b.end && (p.start < b.start || p.end > b.end || j < i)))
    .sort((a, b) => a.start - b.start);
  for (const b of selected) out.push(text.slice(b.start, b.end).trimEnd(), '');

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out.join('\n'));
  console.log(`stage-excerpt: ${a.stage} -> ${outPath} (${included.length} sections, source ${srcHash.slice(0, 16)}…)`);
}

main();
