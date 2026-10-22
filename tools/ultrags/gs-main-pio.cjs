// SPDX-License-Identifier: GPL-2.0-or-later
// Linked main(), SDK PIO initialization, both SMs and the shared ADS mux.
// Clock/ROM/ADC/flash-settings/core1 boundaries are functional fixtures.
// Scheduling units are synthetic ARM instruction steps, NOT Sprinter ns.
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {RP2040}=require('../../build/isa-independent/node_modules/rp2040js');
const {WaitType}=require('../../build/isa-independent/node_modules/rp2040js/dist/cjs/peripherals/pio.js');
const root=path.resolve(__dirname,'../..'),build=path.resolve(process.argv[2]||'build');
const nm=fs.readFileSync(path.join(build,'multifw-release/CMakeCache.txt'),'utf8').match(/^CMAKE_NM:[^=]+=(.*)$/m)[1];
const loaded=new Map(),inputs={};
function input(file){file=path.resolve(file);const b=fs.readFileSync(file);inputs[file]=crypto.createHash('sha256').update(b).digest('hex');return b;}
function image(dir){
 if(loaded.has(dir))return loaded.get(dir);
 const elf=path.join(dir,'pg-ultrags-multifw.elf'),bytes=input(elf);
 const symbols=Object.fromEntries(cp.execFileSync(nm,['--defined-only',elf],{encoding:'utf8'}).split('\n').flatMap(l=>{const m=l.match(/^([0-9a-f]+)\s+\w\s+(\S+)$/);return m?[[m[2],parseInt(m[1],16)]]:[];}));
 const uf2file=fs.existsSync(path.join(dir,'picogus.uf2'))?path.join(dir,'picogus.uf2'):path.join(dir,'../CURRENT.UF2');
 const uf2=input(uf2file),item={bytes,symbols,uf2};loaded.set(dir,item);return item;
}
function fixture(dir){
 const {bytes:b,symbols:sym,uf2}=image(dir),r=new RP2040(),c=r.core,p=r.pio[0];
 const failure=sym.ug_handshake_faulted||sym.failed;
 r.logger={debug(){},info(){},warn(){},error(...x){throw Error(x.join(' '));}};
 for(let i=0;i<uf2.length;i+=512){assert.equal(uf2.readUInt32LE(i),0x0a324655);const addr=uf2.readUInt32LE(i+12),n=uf2.readUInt32LE(i+16);r.flash.set(uf2.subarray(i+32,i+32+n),addr-0x10000000);}
 // Apply the ELF's load segments as boot ROM/CRT copy-to-RAM would do.
 for(let i=0;i<b.readUInt16LE(44);i++) {const o=b.readUInt32LE(28)+i*b.readUInt16LE(42);if(b.readUInt32LE(o)!==1)continue;const off=b.readUInt32LE(o+4),addr=b.readUInt32LE(o+8),n=b.readUInt32LE(o+16);const dst=addr>=0x20000000?r.sram:r.flash,base=addr>=0x20000000?0x20000000:0x10000000;dst.set(b.subarray(off,off+n),addr-base);}
 for(const q of r.pio)q.run=()=>{}; // no dependency wall-clock scheduling
 // RP2040 reset pad IE=1. Dependency defaults incorrectly to IE=0.
 for(const g of r.gpio)g.padValue=0x56;
 // Existing independently calibrated rp2040js stalled OUT PC discrepancy:
 // ready OUT PC jumps to target; stalled OUT PC wrongly advances it once.
 for(const s of p.machines){const check=s.checkWait.bind(s);s.checkWait=()=>{const target=s.waiting&&s.waitType===WaitType.Out&&s.waitIndex===0xa0&&!s.txFIFO.empty?s.txFIFO.peek()&31:null;check();if(target!==null)s.pc=target;};}
 let port=0,data=0,ior=1,iow=1,ticks=0,mainLoops=0,watch=null;
 function pins(){const ads=r.gpio[27].outputValue;let v=((ads?data:port)<<6)|(ior<<5)|(iow<<4);for(let i=0;i<30;i++){const g=r.gpio[i];if(g.outputEnable)v=(v&~(1<<i))|(Number(g.outputValue)<<i);}return v>>>0;}
 Object.defineProperty(r,'gpioValues',{get:pins});
 const hooks=new Map(),calls={};
 function hook(n,fn){if(sym[n]!==undefined)hooks.set(sym[n],()=>{calls[n]=(calls[n]||0)+1;fn();});}
 function ret(v){if(v!==undefined)c.registers[0]=v;c.PC=c.LR&~1;}
 for(const n of ['busy_wait_ms','busy_wait_us_32','stdio_init_all','clock_configure_undivided','pll_init'])hook(n,()=>ret(1));
 hook('vreg_get_voltage',()=>ret(14));
 hook('__wrap___ctzsi2',()=>{const x=c.registers[0];ret(x?31-Math.clz32((x&-x)>>>0):32);});
 hook('__wrap___clzsi2',()=>ret(Math.clz32(c.registers[0])));
 hook('loadSettings',()=>{c.PC=sym.getDefaultSettings;});
 hook('multicore_launch_core1',()=>{r.writeUint8(sym.ready,1);ret();});
 for(const n of ['__wrap_memset','memset'])hook(n,()=>{const [dst,v,len]=c.registers;assert(len<0x40000);for(let i=0;i<len;i++)r.writeUint8(dst+i,v&255);ret();});
 for(const n of ['__wrap_memcpy','__wrap___aeabi_memcpy','memcpy','__aeabi_memcpy'])hook(n,()=>{const [dst,src,len]=c.registers;assert(len<0x40000);const a=Array.from({length:len},(_,i)=>r.readUint8(src+i));a.forEach((v,i)=>r.writeUint8(dst+i,v));ret();});
 // ADC determines board type only. No analogue ADC conversion is simulated.
 const read=r.readUint32.bind(r);r.readUint32=a=>a===0x4004c000?0x101:a===0x4004c004?0x800:read(a);
 hook('ug_minimal_poll_now',()=>{mainLoops++;c.executeInstruction();}); // observe, never replace polling
 function step(){
  // Model the shared mux and output drivers for SIO and both PIO inputs.
  const v=pins();for(const i of [4,5,15,19])r.gpio[i].setInputValue(!!(v&(1<<i)));
  const f=hooks.get(c.PC);if(f)f();else c.executeInstruction();
  for(const s of p.machines)if(s.enabled)s.step();
  ticks++;r.clock.tick(3);
  assert(c.PC>=0x20000000&&c.PC<0x20042000,'invalid linked PC '+c.PC.toString(16));
  if(watch){if((pins()&(1<<26))&&watch.wait===null)watch.wait=ticks-watch.start;if((p.pinDirections>>>6)&255)watch.drive=true;}
 }
 function run(n){for(let i=0;i<n;i++)step();}
 c.SP=0x20041000;c.PC=sym.main;c.LR=0x20040001;
 for(let i=0;i<2000000&&!mainLoops;i++)step();
 assert(mainLoops,'linked main never reached polling');
 const startup={steps:ticks,machines:p.machines.slice(0,2).map(s=>({pc:s.pc,enabled:s.enabled,pinCtrl:s.pinCtrl,execCtrl:s.execCtrl})),substitutions:Object.keys(calls).filter(n=>n!=='ug_minimal_poll_now')};
 function cycle(write,addr,value,{window=2000,gap=1000,post=1000}={}){
  port=addr;data=value||0;run(gap);if(write)iow=0;else ior=0;
  watch={start:ticks,wait:null,drive:false};run(window);
  let held=0;while((pins()&(1<<26))&&held++<20000)step();assert(held<20000,'unreleased WAIT');
  const result=((p.pinDirections>>>6)&255)===255&&(pins()&(1<<27))?(p.pinValues>>>6)&255:255;
  const observed={port:addr,write,value:write?value:result,wait:watch.wait,drive:watch.drive};watch=null;
  ior=iow=1;run(post);assert(!r.readUint8(failure),'frontend permanently disconnected');
  if(post>=100){assert.equal((p.pinDirections>>>6)&255,0,'read driver leaked');assert.equal((pins()>>>26)&3,0,'WAIT/ADS leaked');}
  return observed;
 }
 return {r,sym,startup,cycle};
}
const fw=path.join(build,'multifw-release');
const dirs={R13:path.join(root,'build/gs-turbo-baseline/build/multifw-release'),R15:path.join(root,'build/gs-turbo-r15-failure/build/multifw-release'),candidate:fw};
const rows=[];
for(const window of [48,64,80,96,128,160,256])for(const [revision,dir]of Object.entries(dirs)){
 let failures=0;const samples=[];
 for(let phase=0;phase<32;phase++){
  const f=fixture(dir),opts={window,gap:1000+phase};
  f.cycle(true,0x1d0,0xcc,opts);f.cycle(true,0x1d0,1,opts);
  const a=f.cycle(false,0x1d0,0,opts),b=f.cycle(false,0x1d2,0,opts);
  f.cycle(true,0x1d0,0,opts);const d=f.cycle(false,0x1d2,0,opts);
  const ok=a.value===1&&b.value===4&&d.value===0xdd;if(!ok)failures++;
  samples.push({phase,ok,values:[a.value,b.value,d.value],firstWait:[a.wait,b.wait,d.wait]});
 }
 rows.push({revision,window,failures,samples});
 console.log(revision,'window',window,'failed sequences',failures,'/32');
}
for(const w of [96,128,160,256])assert.equal(rows.find(x=>x.revision==='candidate'&&x.window===w).failures,0);
assert(rows.find(x=>x.revision==='R15'&&x.window===96).failures>0,'frozen R15 negative no longer discriminates');
assert.equal(rows.find(x=>x.revision==='R13'&&x.window===96).failures,0);
const f=fixture(fw);f.cycle(true,0x1d0,0xcc);f.cycle(true,0x1d0,0xe3);
const expected=Buffer.from(Array.from({length:148},(_,i)=>f.r.readUint8(f.sym.ug_cfg+4+i)));
assert.equal(expected.subarray(0,4).toString(),'UGCF','bundled catalogue not loaded');
const cat=[];for(let i=0;i<148;i++)cat.push(f.cycle(false,0x1d2).value);
assert.deepEqual(Buffer.from(cat),expected);assert.equal(f.cycle(false,0x1d2).value,255);
let passive=0;for(let addr=0;addr<1024;addr++){
 if((addr>=0x1d0&&addr<=0x1d2)||(addr>=0x2a0&&addr<=0x2bf))continue;
 const a=f.cycle(false,addr,0,{window:96,gap:64,post:128});assert.equal(a.value,255);assert.equal(a.wait,null);assert(!a.drive);passive++;
}
for(const file of [__filename,'sw/picogus.cpp','sw/ultrags/ug_handshake.c','sw/ultrags/ug_handshake.h','sw/ultrags/ug_handshake_ior.pio','build/isa-independent/node_modules/rp2040js/package.json','build/isa-independent/node_modules/rp2040js/dist/cjs/peripherals/pio.js','build/isa-independent/node_modules/rp2040js/dist/cjs/cortex-m0-core.js'])input(path.resolve(root,file));
const report={status:'LINKED_MAIN_PIO_PASS / REAL_PENDING',rows,catalogueBytes:cat.length,foreignReads:passive,startup:f.startup,inputs,
 limits:['Synthetic ARM instruction scheduling units, not physical CPU cycles or Sprinter timing. No input synchronizer, SRAM arbitration or analogue mux delay model.',
 'Both PIO SMs run decoded instructions and share GPIO/mux; dependency scheduler replaced by deterministic enabled-SM stepping. Dependency PIO instruction delays/dividers are not timed.',
 'ROM memory/bit helpers, clock/ADC and loadSettings boundaries are functional fixtures; defaults run from ELF. Bootloader/CRT are not executed.',
 'Core1 launch publishes only guard readiness. Actual audio/PSRAM/guard IRQ concurrency and ULTRAGS readiness are excluded; guard production C is tested separately.',
 'Candidate still loses some very short windows. Frozen R13 and R15 comparisons are recorded without treating host PASS as a hardware fix.']};
const out=path.join(build,'host/gs-turbo/main-pio.json');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
console.log('Linked main / shared PIO: 672 phase sequences, catalogue148, foreign reads',passive,'PASS');
