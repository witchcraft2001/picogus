// SPDX-License-Identifier: GPL-2.0-or-later
// Independent instruction semantics; no electrical Sprinter timing claim.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {RP2040}=require('../../build/isa-independent/node_modules/rp2040js');
const headerPath=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);
const h=fs.readFileSync(headerPath,'utf8');
const words=[...h.match(/program_instructions\[\] = \{([\s\S]*?)\};/)[1].matchAll(/0x([0-9a-f]{4}),/g)].map(m=>parseInt(m[1],16));
const labels=Object.fromEntries([...h.matchAll(/#define ug_compat_ior_offset_(\w+) (\d+)u/g)].map(m=>[m[1],+m[2]]));
const bottom=+h.match(/#define ug_compat_ior_wrap_target (\d+)/)[1],top=+h.match(/#define ug_compat_ior_wrap (\d+)/)[1];
assert.equal(words.length,22);
let cases=0,aborted=0;
for(const offset of [0,5,10])for(const gs of [false,true])for(const feedback of [0,1]){
 const r=new RP2040(),p=r.pio[0],s=p.machines[1];
 let port=0,ior=1;
 Object.defineProperty(r,'gpioValues',{get:()=>((port<<6)|(ior<<5)|(1<<4)|(feedback<<26))>>>0});
 r.gpio[5].padValue|=0x40;
 r.gpio[15].padValue|=0x40;
 words.forEach((w,i)=>p.instructions[offset+i]=(w>>>13)===0?(w&~31)|((w&31)+offset):w);
 // GS aliases: SET Y,5 owns 00A0h..00BFh; off: unconditional JMP to the software path.
 p.instructions[offset+labels.gs_compare]=gs?0xe045:(offset+labels.foreign);
 s.execCtrl=((1<<30)|(15<<24)|((top+offset)<<12)|((bottom+offset)<<7))>>>0;
 s.pinCtrl=((3<<29)|(8<<20)|(11<<15)|(26<<10)|6)>>>0;
 s.shiftCtrl=((24<<25)|(1<<17)|(1<<19))>>>0;
 for(port=0;port<1024;port++){
  ior=1;r.gpio[5].setInputValue(true);s.restart();s.pc=offset+labels.restart;
  p.pinValues=p.pinDirections=0;for(let i=0;i<4;i++)s.step();
  ior=0;r.gpio[5].setInputValue(false);r.gpio[15].setInputValue(!!(port&512));
  for(let i=0;i<32&&s.rxFIFO.empty;i++)s.step();
  assert(!s.rxFIFO.empty);
  const raw=s.readFIFO()>>>0,own=!!(raw&(1<<26)),expected=(port>>5)===(0x2a0>>5)||(gs&&(port>>5)===5);
  assert.equal(own,expected);const normalized=own?(~raw>>>0):raw;
  assert.equal(((normalized>>>27)&31)|((normalized&31)<<5),port);
  assert.equal(!!(p.pinValues&(1<<26)),own);
  const reply=own||(port>=0x1d0&&port<=0x1d2)||(gs&&[0xb3,0xbb].includes(port));
  const value=(port*73)&255;
  // Every verdict is a relocated PC: value entry (stretch) or restart (ignore).
  s.writeFIFO(reply?offset+labels.value:offset+labels.restart);
  if(reply){
   for(let i=0;i<8;i++)s.step();
   assert.equal((p.pinValues>>>26)&1,1);
   s.writeFIFO(0xff00|value);
   for(let i=0;i<20;i++)s.step();
   assert.equal((p.pinValues>>>6)&255,value);
   assert.equal((p.pinDirections>>>6)&255,255);
   assert.equal((p.pinValues>>>26)&3,2);
  }else{
   for(let i=0;i<16;i++)s.step();
   assert.equal((p.pinDirections>>>6)&255,0);
   assert.equal((p.pinValues>>>26)&3,0);
  }
  ior=1;r.gpio[5].setInputValue(true);
  for(let i=0;i<12;i++)s.step();
  assert.equal((p.pinDirections>>>6)&255,0);
  assert.equal((p.pinValues>>>26)&3,0);
  assert(s.rxFIFO.empty&&s.txFIFO.empty);
  if(own){
   // A captured native address can cease to be mapped while an earlier
   // write is applied. Discard without output, including relocated code.
   ior=0;r.gpio[5].setInputValue(false);
   for(let i=0;i<32&&s.rxFIFO.empty;i++)s.step();
   assert(!s.rxFIFO.empty);s.readFIFO();
   s.writeFIFO(offset+labels.restart);
   for(let i=0;i<16;i++)s.step();
   assert.equal((p.pinDirections>>>6)&255,0);
   assert.equal((p.pinValues>>>26)&3,0);
   assert(s.rxFIFO.empty&&s.txFIFO.empty);
   ior=1;r.gpio[5].setInputValue(true);
   for(let i=0;i<4;i++)s.step();
   aborted++;
  }
  cases++;
 }
}
const dep=path.resolve('build/isa-independent/node_modules/rp2040js/package.json');
const inputs=[headerPath,__filename,dep,path.resolve('build/isa-independent/node_modules/rp2040js/dist/cjs/peripherals/pio.js')];
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,JSON.stringify({status:'HOST_PASS / REAL_PENDING',cases,aborted,offsets:[0,5,10],interpreter:JSON.parse(fs.readFileSync(dep)).version,
 limits:['Instruction semantics; ARM response arrival supplied by test; no physical timing claim'],
 inputs:Object.fromEntries(inputs.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))},null,2)+'\n');
console.log(`Independent COMPAT PIO: ${cases} captures/replies/ignored ports, data drive and release PASS`);
