// SPDX-License-Identifier: GPL-2.0-or-later
// Independent delayed-ARM negative control using rp2040js instruction semantics.
// Does not import or translate the Python interpreter. Ticks are not hardware ns.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {RP2040} = require('../../build/isa-independent/node_modules/rp2040js');
const {WaitType} = require('../../build/isa-independent/node_modules/rp2040js/dist/cjs/peripherals/pio.js');
const header = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const source = fs.readFileSync(header, 'utf8');
const words = [...source.match(/program_instructions\[\] = \{([\s\S]*?)\};/)[1]
  .matchAll(/0x([0-9a-f]{4}),/g)].map(m => parseInt(m[1], 16));
const labels = Object.fromEntries([...source.matchAll(/#define ug_compat_ior_offset_(\w+) (\d+)u/g)]
  .map(m => [m[1], +m[2]]));
const bottom = +source.match(/#define ug_compat_ior_wrap_target (\d+)/)[1];
const top = +source.match(/#define ug_compat_ior_wrap (\d+)/)[1];
assert.equal(words.length, 22, 'requires frozen pre-fix COMPAT');
// Isolate the dependency defect before applying the narrow adapter below.
// A ready OUT PC and a TX-stalled OUT PC must select the same destination.
function outPc(late) {
  const r = new RP2040(), p = r.pio[0], s = p.machines[1];
  p.instructions[0] = 0x60a0;
  s.shiftCtrl = (1 << 17) | (1 << 19);
  s.execCtrl = 31 << 12;
  s.restart();
  s.pc = 0;
  if (late) { s.step(); assert(s.waiting); s.writeFIFO(7); }
  else { s.writeFIFO(7); s.step(); }
  return s.pc;
}
const calibration = {readyOutPc: outPc(false), stalledOutPcUnadapted: outPc(true)};
assert.deepEqual(calibration, {readyOutPc: 7, stalledOutPcUnadapted: 8},
  'dependency behavior changed: review/remove the stalled OUT PC adapter');
const samples = [];
for (const port of [0xb3, 0xbb, 0x2b3, 0x2bb]) {
  for (const latencyTicks of [8, 128, 4096]) {
    const r = new RP2040(), p = r.pio[0], s = p.machines[1];
    // rp2040js checkWait unconditionally calls nextPC after a stalled OUT,
    // including OUT PC (pio.js:805-817). Its non-stalled OUT PC correctly
    // suppresses that increment. Normalize only this resumption discrepancy;
    // otherwise delayed native replies skip OUT PINS and are falsely rejected.
    const checkWait = s.checkWait.bind(s);
    s.checkWait = () => {
      const target = s.waiting && s.waitType === WaitType.Out &&
        s.waitIndex === 0xa0 && !s.txFIFO.empty ? s.txFIFO.peek() & 31 : null;
      checkWait();
      if (target !== null) s.pc = target;
    };
    let ior = 1;
    Object.defineProperty(r, 'gpioValues', {get: () => ((port << 6) | (ior << 5) | (1 << 4)) >>> 0});
    r.gpio[5].padValue |= 0x40;
    r.gpio[15].padValue |= 0x40;
    words.forEach((w, i) => p.instructions[i] = w);
    s.execCtrl = ((1 << 30) | (15 << 24) | (top << 12) | (bottom << 7)) >>> 0;
    s.pinCtrl = ((3 << 29) | (8 << 20) | (11 << 15) | (26 << 10) | 6) >>> 0;
    s.shiftCtrl = ((24 << 25) | (1 << 17) | (1 << 19)) >>> 0;
    s.restart();
    s.pc = labels.restart;
    r.gpio[5].setInputValue(true);
    r.gpio[15].setInputValue(!!(port & 512));
    s.step();
    ior = 0;
    r.gpio[5].setInputValue(false);
    let captured = null, sampled = null;
    for (let tick = 0; tick < latencyTicks + 256; tick++) {
      s.step();
      if (!s.rxFIFO.empty && captured === null) {
        captured = tick;
        s.readFIFO();
      }
      if (captured !== null && tick === captured + latencyTicks) {
        if (ior) s.writeFIFO(0); // stale software-owned read: no consumption
        else {
          s.writeFIFO(port >= 0x200 ? labels.value : 0xffffffff);
          s.writeFIFO(0xff7e);
        }
      }
      if (tick >= 74 && sampled === null && !(p.pinValues & (1 << 26))) {
        sampled = ((p.pinDirections >>> 6) & 255) === 255 && (p.pinValues & (1 << 27))
          ? (p.pinValues >>> 6) & 255 : 255;
        ior = 1;
        r.gpio[5].setInputValue(true);
      }
    }
    assert.equal(sampled, port < 0x200 && latencyTicks > 74 ? 255 : 0x7e,
      JSON.stringify({port, latencyTicks, captured, pc: s.pc, pins: p.pinValues, dirs: p.pinDirections}));
    assert.equal((p.pinDirections >>> 6) & 255, 0);
    assert.equal((p.pinValues >>> 26) & 3, 0);
    assert(s.rxFIFO.empty && s.txFIFO.empty);
    samples.push([port, latencyTicks, sampled]);
  }
}
const dependencies = [header, __filename,
  path.resolve('build/isa-independent/node_modules/rp2040js/package.json'),
  path.resolve('build/isa-independent/node_modules/rp2040js/dist/cjs/peripherals/pio.js')];
const inputs = Object.fromEntries(dependencies.map(p => [p,
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, JSON.stringify({status: 'NEGATIVE_CONTROL_REPRODUCED', samples, inputs,
  calibration, adapter: 'Suppress extra PC increment after stalled OUT PC only'}, null, 2) + '\n');
console.log('Independent delayed-ARM control: 12 reads reproduced');
