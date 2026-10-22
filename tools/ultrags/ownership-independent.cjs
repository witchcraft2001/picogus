// SPDX-License-Identifier: GPL-2.0-or-later
// Independent PIO instruction interpreter, rp2040js 1.4.1 (local dependency).
// No claim about physical pad timing, analogue muxes, or ISA electrical setup.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { RP2040 } = require('../../build/isa-independent/node_modules/rp2040js');
const headerPath = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
const header = fs.readFileSync(headerPath, 'utf8');
const labels = Object.fromEntries([...header.matchAll(/#define ug_handshake_ior_offset_(\w+) (\d+)u/g)].map(m => [m[1], +m[2]]));
const words = [...header.match(/program_instructions\[\] = \{([\s\S]*?)\};/)[1].matchAll(/0x([0-9a-f]{4}),/g)].map(m => parseInt(m[1], 16));
assert.equal(words.length, 32);
assert.notEqual(labels.owned, undefined);
let cases = 0;
const maps=[];
for(let base=0x200;base<=0x3e0;base+=32)for(const alias of [0xffff,...Array.from({length:16},(_,i)=>0x200+i*32).filter(a=>a!==base)])maps.push([base,alias]);
for(const [base,alias] of maps)for (const write of [false, true]) for (const gs of [false, true]) for (const feedback of [0, 1]) {
  const r = new RP2040(), p = r.pio[0], s = p.machines[write ? 0 : 1];
  let port = 0, ior = 1, iow = 1;
  Object.defineProperty(r, 'gpioValues', { get: () => (((p.pinValues & (1 << 27) ? 0xa5 : port) << 6) |
    (ior << 5) | (iow << 4) | (feedback << 26)) >>> 0 });
  for (const pin of [4, 5, 19]) r.gpio[pin].padValue |= 0x40;
  r.gpio[19].setInputValue(false);
  words.forEach((w, i) => p.instructions[i] = w);
  p.instructions[labels.base_compare]=0xe040|(base>>5);
  p.instructions[labels.alias_compare]=0xe040|((alias===0xffff?base:alias)>>5);
  if (!gs) p.instructions[labels.gs_compare] = labels.submit;
  s.execCtrl = ((1 << 30) | (19 << 24) | ((write ? labels.dack : labels.address_only) << 12) |
    ((write ? labels.decode : labels.parked) << 7)) >>> 0;
  s.pinCtrl = ((3 << 29) | (1 << 26) | (8 << 20) | (11 << 15) | (26 << 10) | (27 << 5) | 6) >>> 0;
  s.shiftCtrl = (1 << 16) | (1 << 17) | (1 << 19);
  for (port = 0; port < 1024; port++) {
    ior = iow = 1;
    r.gpio[4].setInputValue(true); r.gpio[5].setInputValue(true);
    s.restart(); s.pc = write ? labels.write_restart : labels.restart;
    p.pinValues = p.pinDirections = 0;
    for (let i = 0; i < 4; i++) s.step();
    if (write) { iow = 0; r.gpio[4].setInputValue(false); }
    else { ior = 0; r.gpio[5].setInputValue(false); }
    for (let i = 0; i < 100; i++) { s.step(); if (s.pc === labels.parked) break; }
    assert.equal(s.pc, labels.parked);
    const raw = s.readFIFO() >>> 0;
    const owned = !!(raw & (1 << (write ? 25 : 26)));
    const expected = ((port & ~31)===base || (alias!==0xffff && (port & ~31)===alias)) || (gs && [0xb3, 0xbb].includes(port));
    assert.equal(owned, expected, `tag port=${port} write=${write} feedback=${feedback}`);
    const normalized = owned ? (~raw >>> 0) : raw;
    assert.equal(((normalized >>> 27) & 31) | ((normalized & 31) << 5), port);
    if (write) {
      const data = s.readFIFO() >>> 0;
      assert.equal(((data >>> 27) | ((data & 7) << 5)) & 255, 0xa5);
    }
    assert.equal(s.rxFIFO.empty, true);
    assert.equal(!!(p.pinValues & (1<<26)),expected,'early WAIT must exactly match ownership');
    assert.equal((p.pinDirections>>>6)&255,0,'classifier never drives data');
    if (!write && expected) {
      // Same forced-OUT reply sequence as the production ARM handler.
      s.restart(); s.writeFIFO(0xff24);
      s.writeUint32(0x10, 0x7408); s.writeUint32(0x10, 0x7c88);
      s.writeUint32(0x10, labels.value);
      for (let i = 0; i < 8; i++) s.step();
      assert.equal((p.pinValues >>> 6) & 255, 0x24);
      assert.equal((p.pinDirections >>> 6) & 255, 255);
      assert.equal((p.pinValues >>> 26) & 3, 2);
      ior = 1; r.gpio[5].setInputValue(true);
      for (let i = 0; i < 8; i++) s.step();
      assert.equal((p.pinDirections >>> 6) & 255, 0);
      assert.equal((p.pinValues >>> 26) & 3, 0);
    }
    cases++;
  }
}
// The same finite host sampling rule and ARM latencies as the frozen R13
// negative control. GS must now remain held until a real response is driven.
const delayed=[];
for(const port of [0xb3,0xbb,0x2b3,0x2bb])for(const latency of [8,128,4096]){
 const r=new RP2040(),p=r.pio[0],s=p.machines[1];let ior=1;
 Object.defineProperty(r,'gpioValues',{get:()=>((port<<6)|(ior<<5)|16|(p.pinValues&(1<<26)))>>>0});
 r.gpio[5].padValue|=0x40;words.forEach((w,i)=>p.instructions[i]=w);
 s.execCtrl=((1<<30)|(19<<24)|(labels.address_only<<12)|(labels.parked<<7))>>>0;
 s.pinCtrl=((3<<29)|(1<<26)|(8<<20)|(11<<15)|(26<<10)|(27<<5)|6)>>>0;
 s.shiftCtrl=(1<<16)|(1<<17)|(1<<19);s.restart();s.pc=labels.restart;
 r.gpio[5].setInputValue(true);s.step();ior=0;r.gpio[5].setInputValue(false);
 let captured=null,sampled=null,replies=0;
 for(let tick=0;tick<latency+256;tick++){
  s.step();if(captured===null&&!s.rxFIFO.empty){captured=tick;assert(s.readFIFO()&(1<<26));}
  if(captured!==null&&tick===captured+latency){
   assert.equal(ior,0);assert(p.pinValues&(1<<26));
   s.restart();s.writeFIFO(0xff7e);s.writeUint32(0x10,0x7408);s.writeUint32(0x10,0x7c88);s.writeUint32(0x10,labels.value);replies++;
  }
  if(tick>=74&&sampled===null&&!(p.pinValues&(1<<26))){
   sampled=((p.pinDirections>>>6)&255)===255&&(p.pinValues&(1<<27))?(p.pinValues>>>6)&255:255;
   ior=1;r.gpio[5].setInputValue(true);
  }
 }
 assert.equal(sampled,0x7e);assert.equal(replies,1);assert.equal((p.pinDirections>>>6)&255,0);assert.equal((p.pinValues>>>26)&3,0);
 assert(s.rxFIFO.empty&&s.txFIFO.empty);delayed.push([port,latency,sampled]);
}
const dep = path.resolve('build/isa-independent/node_modules/rp2040js/package.json');
const paths = [headerPath, __filename, dep, path.resolve('build/isa-independent/node_modules/rp2040js/dist/cjs/peripherals/pio.js')];
const report = { status: 'INDEPENDENT_PIO_PASS / REAL_PENDING', interpreter: JSON.parse(fs.readFileSync(dep)).version,
  cases, delayed, maps:maps.length, limits: 'Instruction semantics, no electrical timing model',
  inputs: Object.fromEntries(paths.map(p => [p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')])) };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`Independent PIO: ${cases} tagged address captures, native/GS read drive/release PASS`);
