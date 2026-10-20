// SPDX-License-Identifier: GPL-2.0-or-later
// Build and execute the read-only R11 diagnostic, and exercise its C recorder.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {sha256,buildInputs,executionInputs} from '../ultrags/build-evidence.mjs';
const root=resolve('.'),build=resolve(process.argv[2]),out=join(build,'host/probe');
mkdirSync(out,{recursive:true});
const source='host/sprinter/diagnostics/ugcfglate.asm',header='sw/ultrags/ug_config_probe.h';
const unit=join(out,'probe.c');
writeFileSync(unit,`#include <assert.h>
#include <stdio.h>
#include "${join(root,header)}"
int main(void){
 ug_config_probe p;ug_config_probe_begin(&p);
 assert(p.flags==0xa0&&p.index==255&&p.value==255&&!p.seen&&!p.late);
 ug_config_probe_record(&p,0,0xc8,32);assert(!p.seen&&!p.late);
 ug_config_probe_record(&p,1,0xc8,0);assert(p.seen==1&&!p.late&&p.flags==0xa4);
 ug_config_probe_record(&p,2,0xc8,32);assert(p.late==1&&p.index==1&&p.value==0xc8&&p.flags==0xa5);
 ug_config_probe_record(&p,3,0x55,32|(1u<<26));assert(p.late==2&&p.index==2&&p.value==0x55&&p.flags==0xa7);
 ug_config_probe_record(&p,3,255,32);assert(p.late==2);
 ug_config_probe_record(&p,149,255,32);assert(p.late==2);
 ug_config_probe_begin(&p);
 for(unsigned i=1;i<=148;i++)ug_config_probe_record(&p,i,i,32);
 assert(ug_config_probe_read(&p,0x1c)==148&&ug_config_probe_read(&p,0x1d)==147);
 assert(ug_config_probe_read(&p,0x1e)==148&&ug_config_probe_read(&p,0x1f)==0xa5);
 for(unsigned i=0;i<256;i++)ug_config_probe_record(&p,148,255,32);
 assert(p.late==148&&p.value==148);
 puts("C recorder: low/high IOR, WAIT feedback, boundaries, exhausted stream, reset PASS");
}`);
execFileSync('cc',['-std=c11','-Wall','-Wextra','-Werror','-fsanitize=undefined','-fno-sanitize-recover=all',unit,'-o',join(out,'probe')]);
const unitLog=execFileSync(join(out,'probe'),[],{encoding:'utf8'});
writeFileSync(join(out,'unit.log'),unitLog);
const Z80=loadZ80(root),files={},results=[];
const hx=v=>v.toString(16).toUpperCase().padStart(2,'0');
for(const kit of ['a','b'])for(const slot of [0,1]){
 const name=`UGCL${slot}.EXE`,dir=join(out,kit);mkdirSync(dir,{recursive:true});
 execFileSync('sjasmplus',['--inc=host/sprinter/ultrags/lib','--inc=host/sprinter/ultrags/include',
  '--inc='+join(build,'ultrags/gen'),`-DPROBE_SLOT=${slot}`,
  '--raw='+join(dir,name),'--lst='+join(dir,name+'.lst'),source],{stdio:'pipe'});
 const bytes=readFileSync(join(dir,name)),h=parseExe(bytes);
 if(kit==='b')assert.deepEqual(bytes,readFileSync(join(out,'a',name)));
 else files[name]=sha256(bytes);
 for(const data of [[0,255,255,0xa0],[0,255,255,0xa4],[1,101,0xc8,0xa5],[2,44,0xd3,0xa7],[148,147,0x55,0xa7],[0,0,0,0],[255,255,255,255]])
 for(const iff of [0,1])for(const turbo of [false,true]){
  const ports=[0x2a1,0x2a6,0x2bc,0x2bd,0x2be,0x2bf],values=[1,0,...data],reads=[];
  const card={base:0x2a0,alias:65535,tickUs(){},
   readPort(p){reads.push(p);assert(ports.includes(p));return values[ports.indexOf(p)];},
   writePort(){throw Error('diagnostic must not write card ports');}};
  const m=new SprinterMachine({card,cardSlot:slot,seed:123+results.length,page3Init:0x19,turboInit:turbo,logLimit:100});
  m.mem.set(bytes,h.loadAddr);const r=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff});
  const valid=(data[3]&0xf8)===0xa0;
  assert.equal(r.exitCode,valid?0:2,m.text);assert.deepEqual(m.violations,[]);
  assert.deepEqual(reads,ports);assert(m.isaLog.every(x=>x.dir==='r'&&x.slot===slot));
  assert.equal(m.page3,0x19);assert.equal(m.system,1);assert.equal(m.turbo,true);
  assert.equal(!!r.end.iff1,!!iff);assert.equal(r.end.sp,h.stack-2);
  assert(m.maxWindowUs<10000&&m.maxDiUs<10000);assert(!m.text.includes('RESULT PASS'));
  if(valid)assert(m.text.includes(`STATUS=01 ERROR=00 LATE=${hx(data[0])} INDEX=${hx(data[1])} SENT=${hx(data[2])} FLAGS=${hx(data[3])}`),m.text);
  else assert(m.text.includes('WRONG FIRMWARE'));
  results.push({kit,slot,data,iff,turbo,exit:r.exitCode,steps:r.steps,text:m.text});
 }
}
const inputs={...buildInputs(root,join(build,'ultrags/dss')).sources,...executionInputs(root)};
for(const n of ['ug_wire.inc','ug_diag_wire.inc']){
 const p=join(build,'ultrags/gen',n);inputs[p]=sha256(readFileSync(p));
}
for(const p of [source,header,'tools/diagnostics/check-config-probe.mjs'])inputs[p]=sha256(readFileSync(p));
writeFileSync(join(out,'probe.json'),JSON.stringify({status:'HOST_PROBE_PASS / REAL_PENDING',files,results,unit:unitLog,inputs},null,2)+'\n');
console.log(unitLog.trim());console.log(`${results.length} actual-EXE cases; two identical builds; no ISA writes/consuming reads PASS`);
