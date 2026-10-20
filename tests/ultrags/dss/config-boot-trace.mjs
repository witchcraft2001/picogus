// SPDX-License-Identifier: GPL-2.0-or-later
// Execute the delivered UGCFG. A lost CONFIG read is injected, not explained
// electrically: this separates the host's subsequent traffic from its cause.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {ConfigCard} from './config-card.mjs';
import {loadZ80, parseExe, SprinterMachine, runImage} from './ug-harness.mjs';
import {sha256} from '../../../tools/ultrags/build-evidence.mjs';

const exePath=resolve(process.argv[2]), catalogPath=resolve(process.argv[3]);
const out=resolve(process.argv[4]);
const exe=readFileSync(exePath), catalog=readFileSync(catalogPath);
const header=parseExe(exe), Z80=loadZ80(resolve('.')), results=[];
class ObservedCard extends ConfigCard {
 constructor(lost) {super(catalog);this.lost=lost;this.afterWrites=[];this.afterReads=0;this.raw=255;}
 readPort(p) {
  if(this.session>1n&&p>=0x1d0&&p<=0x1d2) {
   this.afterReads++;
   if(this.lost)return 255;
  }
  return super.readPort(p);
 }
 writePort(p,v) {
  if(this.session>1n) {this.afterWrites.push([p,v]);if(p===0x1d0)this.raw=v;}
  return super.writePort(p,v);
 }
}
for(const lost of [false,true]) {
 const card=new ObservedCard(lost);
 const m=new SprinterMachine({card,commandLine:'ULTRAGS',movingClock:true,logLimit:1000});
 m.mem.set(exe,header.loadAddr);
 const run=runImage(Z80,m,{entry:header.entry,stack:header.stack,iff:1,budget:30000000});
 assert.equal(run.exitCode,lost?8:0,m.text);assert.deepEqual(m.violations,[]);
 assert.equal(card.reboots,1);assert.equal(card.saveRequests,0);
 assert.equal(card.mode,8);
 if(lost) {
  assert.equal(card.sel,0);assert.equal(card.raw,255);assert.equal(card.unlocked,false);
  assert(card.afterReads>=255);assert.deepEqual(card.afterWrites,[]);
  // Prove that writes remain functional in this exact failed scenario.
  card.writePort(0x1d0,0xcc);card.writePort(0x1d0,1);
  assert.equal(card.sel,1);assert.equal(card.raw,1);assert(card.unlocked);
  assert.equal(card.readPort(0x1d0),255);
 }
 results.push({lostConfigReads:lost,exit:run.exitCode,steps:run.steps,text:m.text,
  readsAfterBoot:card.afterReads,
  writesAfterBoot:card.afterWrites,
  manualWritesAfterTimeout:lost,
  maxWindowUs:m.maxWindowUs,maxDiUs:m.maxDiUs});
}
// A pending selector and an unlocked interface cannot survive a real reset.
for(const reset of ['power','mode']) {
 const card=new ConfigCard(catalog,{selectorDelayUs:1000000});
 card.writePort(0x1d0,0xcc);card.writePort(0x1d0,1);
 assert(card.unlocked&&card.selectPending);
 if(reset==='power')card.powerCycle();
 else {card.desired=8;card.rebootAt=1;card.tickUs(2);}
 assert(!card.unlocked&&!card.selectPending&&!card.confirmed);
 assert.equal(card.sel,0);card.tickUs(2000000);assert.equal(card.sel,0);
}
mkdirSync(out,{recursive:true});
const sources=[exePath,catalogPath,resolve('tests/ultrags/dss/config-card.mjs'),
 resolve('tests/ultrags/dss/config-boot-trace.mjs'),resolve('tests/ultrags/dss/ug-harness.mjs'),
 resolve('tests/ultrags/dss/Z80core.js')];
writeFileSync(join(out,'boot-trace.json'),JSON.stringify({
 status:'HOST_PASS / physical CONFIG read failure not diagnosed',
 results,resetCases:2,inputs:Object.fromEntries(sources.map(p=>[p,sha256(readFileSync(p))])),
 limits:['CONFIG FF is injected; this does not establish its electrical cause',
 'RAW=FF/SEL=00 after TIMEOUT is compatible with a working write path']
},null,2)+'\n');
console.log('Delivered UGCFG: normal boot PASS; CONFIG-read loss reproduces TIMEOUT with zero post-boot writes; reset-state cases PASS.');
