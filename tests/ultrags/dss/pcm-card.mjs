// SPDX-License-Identifier: GPL-2.0-or-later
// Independent S6 oracle: rational frame time, explicit ownership and projected queue.
// This model is DSS evidence; it does not execute or stand in for the C renderer.
import {SlowCard} from './slow-card.mjs';
import {crc32} from './config-card.mjs';
import {parseMod4,ModClock} from './mod-tracker.mjs';
const u16=(n)=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
export function rawDescriptor(size,rate=48000,channels=1,bits=8,format=0) {
 const b=Buffer.alloc(24);b.writeUInt32LE(rate);b[4]=channels;b[5]=bits;b[6]=format;b.writeUInt32LE(size,12);return b;
}
function rawInfo(d,size) {
 const rate=d.readUInt32LE(),channels=d[4],bits=d[5],format=d[6],offset=d.readUInt32LE(8),length=d.readUInt32LE(12),start=d.readUInt32LE(16),end=d.readUInt32LE(20);
 if(rate<8000||rate>48000||![1,2].includes(channels)||![8,16].includes(bits)||(bits===8?format>1:format!==2)||d[7]>1||offset||length!==size||!length||length%(channels*bits/8))throw Error('format');
 const frames=length/(channels*bits/8);if(d[7]?!(start<end&&end<=frames):start||end)throw Error('loop');
 return {rate,channels,bits,format,offset,length,frames,loop:!!d[7],start,end:d[7]?end:frames};
}
function wavInfo(b) {
 if(b.length<12||b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WAVE')throw Error('riff');
 const end=b.readUInt32LE(4)+8;if(end>b.length||end<12)throw Error('size');let fmt,data;
 for(let at=12;at<end;) {
  if(at+8>end)throw Error('chunk');const tag=b.toString('ascii',at,at+4),n=b.readUInt32LE(at+4),next=at+8+n+(n&1);if(next>end)throw Error('bounds');
  if(tag==='fmt '){if(fmt||n<16)throw Error('fmt');fmt=b.subarray(at+8,at+8+n);}
  if(tag==='data'){if(data)throw Error('duplicate');data={offset:at+8,length:n};}at=next;
 }
 if(!fmt||!data||fmt.readUInt16LE()!==1)throw Error('pcm');
 const channels=fmt.readUInt16LE(2),rate=fmt.readUInt32LE(4),bits=fmt.readUInt16LE(14),align=channels*bits/8;
 const m=rawInfo(rawDescriptor(data.length,rate,channels,bits,bits===8?0:2),data.length);
 if(fmt.readUInt16LE(12)!==align||fmt.readUInt32LE(8)!==rate*align)throw Error('align');return {...m,...data};
}
export class PcmCard extends SlowCard {
 constructor(catalog,o={}) {super(catalog,o);this.foreground=null;this.fx=[];this.events=[];this.nextPlay=1;this.nextFx=1;this.frames=0n;this.fraction=0;this.quantum=0;this.state=0;this.lastAudioError=0;this.lastPlay=0;this.lastHandle=0;this.lastPosition=0;this.lastKind=0;this.lastMod=null;this.audioTrace=[];this.capacity=o.voices??32;this.held=null;this.seq=3;}
 readPort(p){const v=super.readPort(p);return p===this.base+1&&this.mode===8&&(this.foreground||this.fx.length)?v|128:v;}
 tickUs(us) {
  super.tickUs(us);
  if(this.o.audioFaultAt&&this.now>=this.o.audioFaultAt){
   this.o.audioFaultAt=0;this.apply();
   if(this.foreground){this.lastPosition=this.foreground.position;this.release(this.foreground);this.foreground=null;this.state=4;}
   for(const x of this.fx)this.release(x);this.fx=[];this.lastAudioError=17;this.stats[10]++;
  }
  if(this.o.stoppedAudio)return;
  this.fraction+=us*48000;const n=Math.floor(this.fraction/1000000);this.fraction-=n*1000000;
  let left=n;while(left){const take=Math.min(left,128-this.quantum);if(!this.quantum){this.apply();this.seq++;}this.advance(take);this.frames+=BigInt(take);this.quantum=(this.quantum+take)%128;left-=take;}
 }
 project(){let fg=this.foreground?{...this.foreground}:null,fx=this.fx.map(x=>({...x}));for(const e of this.events)({fg,fx}=this.effect(e,fg,fx,false));return {fg,fx};}
 release(x){if(x)this.objects.get(x.handle).pins--;}
 effect(e,fg,fx,live) {
  const drop=x=>{if(live)this.release(x);};
  if(e.op===48||e.op===49){drop(fg);fg={...e.instance};if(live){this.state=1;this.lastPlay=fg.id;this.lastHandle=fg.handle;this.lastPosition=0;this.lastKind=e.op===49?2:1;this.lastGain=fg.gain;this.lastPan=fg.pan;this.lastMod=null;if(fg.mod){fg.tracker=new ModClock(fg.mod,fg.loop,fg.ignoreF00);fg.paused=fg.tracker.paused;this.lastMod=fg.tracker;}}}
  if(e.op===54){fx=fx.filter(x=>{if(x.voices.some(v=>e.instance.voices.includes(v))){drop(x);return false;}return true;});fx.push({...e.instance});fx.sort((a,b)=>a.slot-b.slot);}
  if(e.op===50&&fg){if(e.action===0){drop(fg);fg=null;if(live)this.state=0;}else {fg.paused=e.action===1;if(live&&fg.tracker)fg.tracker.paused=fg.paused;}}
  if(live&&e.op===51&&fg?.tracker){fg.tracker.seek(e.order,e.row);fg.paused=fg.tracker.paused;}
  if(live&&e.op===53&&fg?.tracker)fg.tracker.tempo=e.tempo;
  if(live&&e.op===56&&fg?.tracker)fg.tracker.channel[e.channel].pan=e.pan;
  if(e.op===55||e.op===57)fx=fx.filter(x=>{if(e.op===55?(e.id===0||x.id===e.id):x.id===e.id){if(!e.action){drop(x);return false;}x.paused=e.action===1;}return true;});
  return {fg,fx};
 }
 apply(){for(const e of this.events)({fg:this.foreground,fx:this.fx}=this.effect(e,this.foreground,this.fx,true));this.events=[];}
 advance(n){
  const step=x=>{if(x.paused)return true;if(x.mod){const playing=x.tracker.advance(n);x.paused=x.tracker.paused;x.position=0;return playing;}const m=this.objects.get(x.handle).pcm;x.time+=n*m.rate;const frame=Math.floor(x.time/48000);if(!x.loop&&x.repeats&&frame>=m.frames*x.repeats){x.position=m.frames;return false;}x.position=m.loop&&frame>=m.end?m.start+(frame-m.start)%(m.end-m.start):frame%m.frames;return true;};
  if(this.foreground){if(!step(this.foreground)){this.lastPosition=this.foreground.position;this.release(this.foreground);this.foreground=null;this.state=3;}else this.lastPosition=this.foreground.position;}
  this.fx=this.fx.filter(x=>{if(step(x))return true;this.release(x);return false;});
 }
 render(n){this.apply();this.advance(n);this.seq++;} // C vector boundary: rendering vs delivered frames are separate
 id(fx){const used=new Set([...(fx?this.fx:this.foreground?[this.foreground]:[]),...this.events.filter(e=>fx?e.op===54:(e.op===48||e.op===49)).map(e=>e.instance)].map(x=>x.id));let id=this[fx?'nextFx':'nextPlay'];while(!id||used.has(id))id=id%65535+1;this[fx?'nextFx':'nextPlay']=id%65535+1;return id;}
 snap(){
  const sequence=this.seq,r=super.snap();this.seq=sequence;r.writeUInt32LE(sequence);
  const present=!!this.foreground||this.state!==0,t=this.lastKind===2?this.lastMod:null,pcm=this.objects.get(this.lastHandle)?.pcm;
  r.writeBigUInt64LE(this.frames,12);r.writeUInt16LE(present?this.lastPlay:0,20);
  r[24]=this.foreground?(this.foreground.paused?2:1):this.state;r[25]=present?this.lastKind:0;r[26]=present?(t?t.info.channels:(pcm?.channels??0)):0;
  r.writeUInt16LE(present?this.lastHandle:0,28);r.writeUInt32LE(present&&!t?(this.foreground?.position??this.lastPosition):0,32);
  if(t){r.writeUInt16LE(t.order,36);r[38]=t.row;r[39]=t.tick;r[40]=t.speed;r[41]=t.bpm;}
  const instances=[this.foreground,...this.fx].filter(Boolean);
  r.writeUInt16LE(instances.reduce((n,x)=>n+x.voices.length,0),52);r.writeUInt16LE(this.fx.length,54);r[50]=this.lastAudioError;
  const voices=Array.from({length:this.capacity},(_,id)=>{const b=Buffer.alloc(20);b.writeUInt16LE(id);b.writeUInt16LE(65535,6);b[16]=127;return b;});
  for(const x of instances)for(let c=0;c<x.voices.length;c++){
   const b=voices[x.voices[c]],music=x===this.foreground,mc=x.tracker?.channel[c];
   b.writeUInt16LE(x.id,2);b.writeUInt16LE(x.handle,4);b.writeUInt16LE(music?c:65535,6);b.writeUInt32LE(x.position,8);
   if(mc){b.writeUInt16LE(mc.period,14);b[16]=mc.note;b[17]=mc.volume;b[18]=mc.pan;}else{b[17]=x.gain;b[18]=x.pan;}
   b[19]=8|(!x.paused&&(!mc||mc.active)?1:0)|(music?0:2)|(x.paused?4:0);
  }
  const effects=this.fx.map(x=>{const b=Buffer.alloc(16),m=this.objects.get(x.handle).pcm;b.writeUInt16LE(x.id);b.writeUInt16LE(x.voices.length,2);b.writeUInt16LE(x.handle,4);b[6]=x.paused?2:1;b[7]=m.channels;b.writeUInt32LE(x.position,8);b[12]=x.gain;b[13]=x.pan;b[14]=x.priority;b[15]=x.repeats===0?2:0;return b;});
  this.held={key:Buffer.concat([r.subarray(4,12),r.subarray(0,4)]),voices,effects};return r;
 }
 allocate(channels,fg,fx,{replacement=false,preferred=65535,steal=false,priority=0}={}){
  const owner=v=>fx.find(x=>x.voices.includes(v)),blocked=v=>!replacement&&fg?.voices.includes(v),chosen=[];
  if(preferred!==65535){if(preferred>=this.capacity||blocked(preferred))return null;const x=owner(preferred);if(x&&(!steal||x.priority>=priority))return null;chosen.push(preferred);}
  for(let pass=0;pass<(steal?2:1);pass++)for(let v=0;v<this.capacity&&chosen.length<channels;v++){
   if(chosen.includes(v)||blocked(v))continue;const x=owner(v);if(x&&(!pass||x.priority>=priority))continue;chosen.push(v);
  }
  return chosen.length===channels?chosen:null;
 }

 command(op,q,defer=false) {
  const err=e=>[e,Buffer.alloc(0)],ok=(r=Buffer.alloc(0))=>[0,r];
  if(op===19&&q.length!==7||op===18&&q.length!==2)return err(3);
  if(this.transfer&&[19,20].includes(op))return err(5);
  if(op===1){const result=super.command(op,q,defer);if(!result[0]){if(!this.o.noCaps)result[1].writeUInt32LE(127,4);result[1].writeUInt32LE(8000,32);result[1].writeUInt32LE(48000,36);}return result;}
  if(op===6){for(const x of [this.foreground,...this.fx,...this.events.filter(e=>e.instance).map(e=>e.instance)])if(x)this.release(x);this.foreground=null;this.fx=[];this.events=[];this.lastPlay=this.lastHandle=this.state=0;}
  if(op===20){this.trace.push({op,q:q.toString('hex')});if(q.length!==26)return err(3);const o=this.objects.get(q.readUInt16LE());if(!o)return err(7);if(o.kind!==1||o.state||o.pins)return err(6);try{o.pcm=rawInfo(q.subarray(2),o.size);}catch{return err(11);}return ok();}
  if(op===19&&this.objects.get(q.readUInt16LE())?.kind){
   this.trace.push({op,q:q.toString('hex')});if(q.length!==7)return err(3);const o=this.objects.get(q.readUInt16LE());if(o.state||o.uploaded!==o.size||o.kind===1&&!o.pcm)return err(6);if(o.pins)return err(18);if(q[2]>1||(!q[2]&&q.readUInt32LE(3)))return err(2);
   const crc=crc32(o.data);if(q[2]&&crc!==q.readUInt32LE(3)){o.state=2;return err(4);}
   try{if(o.kind===2)o.pcm=wavInfo(o.data);else if(o.kind===3)o.mod=parseMod4(o.data);else if(!o.pcm)throw Error('config');}catch{o.state=2;return err(11);}
   o.state=1;o.crc=crc;const r=Buffer.alloc(4);r.writeUInt32LE(crc);return ok(r);
  }
  if(op===18){const result=super.command(op,q,defer),o=this.objects.get(q.readUInt16LE());if(!result[0]&&o?.pcm&&o.state===1){const r=result[1],m=o.pcm;r.writeUInt32LE(m.offset,18);r.writeUInt32LE(m.length,22);r.writeUInt32LE(m.rate,26);r.writeUInt32LE(m.frames,30);r[34]=m.channels;r[35]=m.bits;r[36]=m.format;}if(!result[0]&&o?.mod&&o.state===1)result[1][37]=o.mod.channels;return result;}
  if(![48,49,50,51,53,54,55,56,57,81,82].includes(op))return super.command(op,q,defer);
  this.trace.push({op,q:q.toString('hex')});if(q.length!==({48:6,49:3,50:3,51:5,53:2,54:8,55:2,56:3,57:3,81:16,82:16})[op])return err(3);
  if(op===81||op===82){
   if(!this.held||!q.subarray(0,12).equals(this.held.key))return err(6);
   const first=q.readUInt16LE(12),max=q.readUInt16LE(14),size=op===82?20:16,items=op===82?this.held.voices:this.held.effects;
   if(!max)return err(2);if(first>items.length)return err(8);const count=Math.min(max,Math.floor(108/size),items.length-first),r=Buffer.alloc(20+count*size);
   q.copy(r,0,0,14);r.writeUInt16LE(count,14);r.writeUInt16LE(items.length,16);r.writeUInt16LE(size,18);for(let i=0;i<count;i++)items[first+i].copy(r,20+i*size);return ok(r);
  }
  if(this.transfer)return err(5);if(this.events.length===16)return err(5);
  const {fg,fx}=this.project();let e={op};
  if(op===48||op===49||op===54){
   const h=q.readUInt16LE(),o=this.objects.get(h);if(!o)return err(7);if(o.state!==1)return err(6);if(op===49){if((q[2]&~7)||(q[2]&6)===6)return err(2);if(!o.mod)return err(11);if(this.events.some(e=>e.op===49))return err(5);const id=this.id(false);if(!this.allocate(o.mod.channels,fg,fx,{replacement:true}))return err(12);o.pins++;e.instance={id,handle:h,voices:this.allocate(o.mod.channels,fg,fx,{replacement:true}),priority:0,gain:64,pan:128,loop:!!(q[2]&1),ignoreF00:!!(q[2]&2),repeats:1,paused:false,time:0,position:0,mod:{...o.mod},order:0,row:0,tick:0,tickTime:0};this.events.push(e);this.audioTrace.push({op,id,handle:h,voices:e.instance.voices});return ok(u16(id));}
   if(!o.pcm)return err(11);const m=o.pcm,fxplay=op===54,gain=q[fxplay?5:4],pan=q[fxplay?6:5];if(gain>64)return err(2);
   const flags=fxplay?q[7]:0,repeats=fxplay?1:q.readUInt16LE(2);if(flags>3||(m.loop&&(fxplay?flags&2:repeats!==1)))return err(2);
   const preferred=fxplay?q.readUInt16LE(2):65535,priority=fxplay?q[4]:0;
   if(fxplay&&(!priority||priority===255))return err(2);if(preferred!==65535&&preferred>=this.capacity)return err(8);
   const voices=this.allocate(m.channels,fg,fx,{replacement:!fxplay,preferred,steal:!!(flags&1),priority});if(!voices)return err(12);
   const id=this.id(fxplay),occupied=fx.filter(x=>!x.voices.some(v=>voices.includes(v))).map(x=>x.slot),slot=Array.from({length:this.capacity},(_,v)=>v).find(v=>!occupied.includes(v));e.instance={id,slot,handle:h,voices,priority,gain,pan,loop:m.loop||!!(flags&2),repeats:fxplay&&(flags&2)?0:repeats,paused:false,time:0,position:0};o.pins++;this.events.push(e);this.audioTrace.push({op,id,handle:h,voices});return ok(fxplay?Buffer.concat([u16(id),u16(m.channels)]):u16(id));
  }
  if([51,53,56].includes(op)){
   if(!fg?.mod)return err(6);
   if(op===51){if(q.readUInt16LE()&&q.readUInt16LE()!==fg.id)return err(6);e.order=q.readUInt16LE(2);e.row=q[4];if(e.order>=fg.mod.song||e.row>=64)return err(8);}
   if(op===53){if(!q[0]||q[0]>31||q[1]<32)return err(2);e.tempo=[q[0],q[1]];}
   if(op===56){if(q.readUInt16LE()>=fg.mod.channels)return err(8);e.channel=q.readUInt16LE();e.pan=q[2];}
   this.events.push(e);return ok();
  }
  if(op===55){e.id=q.readUInt16LE();if(e.id&&!fx.some(x=>x.id===e.id))return err(7);e.action=0;}
  else {e.id=q.readUInt16LE();e.action=q[2];if(e.action>2)return err(2);if(op===50){if(!fg||e.id&&e.id!==fg.id||e.action===2&&!fg.paused)return err(6);}else {const x=fx.find(x=>x.id===e.id);if(!e.id||!x)return err(7);if(e.action===2&&!x.paused)return err(6);}}
  this.events.push(e);return ok();
 }
}
