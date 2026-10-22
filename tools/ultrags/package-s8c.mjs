// SPDX-License-Identifier: GPL-2.0-or-later
// S8c must pass the current R17/S8b packager as well as streaming gates.
// Historical standalone S8c packaging did not cover later compatibility fixes.
import assert from 'node:assert/strict';
assert(process.argv.slice(2).every(a=>a==='--verify-only'),
 'Use the fixed build/ and build/reproducibility/ roots; only --verify-only is supported');
process.argv.push('--s8c');
await import('./package-gs105.mjs');
