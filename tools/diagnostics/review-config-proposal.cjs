// SPDX-License-Identifier: GPL-2.0-or-later
// Counterexamples for the reviewed broad CONFIG decode, not shipping firmware.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {RP2040}=require('../../build/isa-independent/node_modules/rp2040js');
const out=path.resolve(process.argv[2]||'build/config-review-r11');
const pioasm=path.resolve('build/config-probe11-a/multifw-release/pioasm-install/pioasm/pioasm');
fs.mkdirSync(out,{recursive:true});
const results=[];
for(const repairAlias of [false,true]){
 const name=repairAlias?'alias-repaired':'as-proposed';
 const source=`.program proposal
.side_set 2 opt
public restart:
 wait 1 gpio 5 side 0b00
.wrap_target
public idle:
 wait 0 gpio 5
 in pins, 5
 mov x, isr
 set y, 21
 jmp x!=y alias
 jmp owned
alias:
 set y, 22
 jmp x!=y cfg
${repairAlias?' jmp owned':''}
cfg:
 set y, 14
 jmp x!=y foreign
owned:
 mov isr, ~pins side 0b01
 push block side 0b01
 out pc, 32 side 0b01
foreign:
 mov isr, pins
 push block
 out x, 32
 jmp !x restart
public value:
 out pins, 8 side 0b01
 out pindirs, 8 side 0b11 [3]
 wait 1 gpio 5 side 0b10
 out pindirs, 8 side 0b00
.wrap
`;
 const src=path.join(out,name+'.pio'),header=src+'.h';
 fs.writeFileSync(src,source);
 execFileSync(pioasm,['-o','c-sdk','-v','0',src,header]);
 const h=fs.readFileSync(header,'utf8');
 const words=[...h.match(/program_instructions\[\] = \{([\s\S]*?)\};/)[1].matchAll(/0x([0-9a-f]{4}),/g)].map(x=>parseInt(x[1],16));
 assert.equal(words.length,repairAlias?23:22);
 const top=+h.match(/#define proposal_wrap (\d+)/)[1];
 const bottom=+h.match(/#define proposal_wrap_target (\d+)/)[1];
 const r=new RP2040(),p=r.pio[0],s=p.machines[1];
 let port=0,ior=1;
 Object.defineProperty(r,'gpioValues',{get:()=>((port<<6)|(ior<<5)|(1<<4))>>>0});
 r.gpio[5].padValue|=0x40;
 words.forEach((w,i)=>p.instructions[i]=w);
 s.execCtrl=((1<<30)|(top<<12)|(bottom<<7))>>>0;
 s.pinCtrl=((3<<29)|(8<<20)|(11<<15)|(26<<10)|6)>>>0;
 s.shiftCtrl=((24<<25)|(1<<17)|(1<<19))>>>0;
 const early=[];
 for(port=0;port<1024;port++){
  ior=1;r.gpio[5].setInputValue(true);s.restart();s.pc=0;
  p.pinValues=p.pinDirections=0;for(let i=0;i<4;i++)s.step();
  ior=0;r.gpio[5].setInputValue(false);
  for(let i=0;i<40&&s.rxFIFO.empty;i++)s.step();
  assert(!s.rxFIFO.empty);
  const raw=s.readFIFO()>>>0,own=!!(raw&(1<<26));
  assert.equal(!!(p.pinValues&(1<<26)),own);
  assert.equal((p.pinDirections>>>6)&255,0);
  const normalized=own?(~raw>>>0):raw;
  assert.equal(((normalized>>>27)&31)|((normalized&31)<<5),port);
  if(own)early.push(port);
 }
 const neighbors=early.filter(p=>p>=0x1c0&&p<=0x1df&&!(p>=0x1d0&&p<=0x1d2));
 const alias=early.filter(p=>p>=0x2c0&&p<=0x2df);
 assert.equal(neighbors.length,29);
 assert.equal(alias.length,repairAlias?32:0);
 results.push({variant:name,words:words.length,totalWithIOW10:words.length+10,
  cases:1024,aliasEarlyPorts:alias.length,foreignPortsHeld:neighbors.map(p=>p.toString(16))});
}
const digest=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const baseline=path.join(out,'head-handshake.pio');
fs.writeFileSync(baseline,execFileSync('git',['show','HEAD:sw/ultrags/ug_handshake_ior.pio']));
execFileSync(pioasm,['-o','c-sdk','-v','0',baseline,baseline+'.h']);
const r10=path.resolve('build/config-r10-delivery/evidence/build-a/ug_compat_ior.pio.h');
const getWords=p=>[...fs.readFileSync(p,'utf8').match(/program_instructions\[\] = \{([\s\S]*?)\};/)[1].matchAll(/0x([0-9a-f]{4}),/g)].map(x=>parseInt(x[1],16));
assert.notDeepEqual(getWords(baseline+'.h'),getWords(r10));
const paths=[__filename,pioasm,
 baseline,baseline+'.h',r10,
 path.resolve('build/isa-independent/node_modules/rp2040js/dist/cjs/peripherals/pio.js'),
 ...['as-proposed','alias-repaired'].flatMap(n=>[path.join(out,n+'.pio'),path.join(out,n+'.pio.h')])];
fs.writeFileSync(path.join(out,'review.json'),JSON.stringify({
 status:'REVIEW_COUNTEREXAMPLES_REPRODUCED',results,
 baselineCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 r10PioEqualsHead:false,
 inputs:Object.fromEntries(paths.map(p=>[p,digest(p)])),
 limits:['Instruction model only; no electrical/timing measurement.',
 'Source reconstructs the proposed ordering plus the unchanged reply tail.',
 'This demonstrates defects of the supplied layout, not impossibility of every exact CONFIG decoder.']
},null,2)+'\n');
console.log('2048 PIO cases: proposed alias misses 32 ports; both hold 29 foreign ports; alias repair needs 23+10=33 words');
