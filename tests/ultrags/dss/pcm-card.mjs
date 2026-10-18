// SPDX-License-Identifier: GPL-2.0-or-later
// Independent S6 oracle: rational frame time, explicit ownership and projected queue.
// This model is DSS evidence; it does not execute or stand in for the C renderer.
import {SlowCard} from './slow-card.mjs';
import {crc32} from './config-card.mjs';
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
 constructor(catalog,o={}) {super(catalog,o);this.foreground=null;this.fx=[];this.events=[];this.nextPlay=1;this.nextFx=1;this.frames=0n;this.fraction=0;this.quantum=0;this.state=0;this.lastAudioError=0;this.lastPlay=0;this.lastHandle=0;this.lastPosition=0;this.audioTrace=[];}
 tickUs(us) {
  super.tickUs(us);
  if(this.o.audioFaultAt&&this.now>=this.o.audioFaultAt){
   this.o.audioFaultAt=0;this.apply();
   if(this.foreground){this.lastPosition=this.foreground.position;this.release(this.foreground);this.foreground=null;this.state=4;}
   for(const x of this.fx)this.release(x);this.fx=[];this.lastAudioError=17;this.stats[10]++;
  }
  if(this.o.stoppedAudio)return;
  this.fraction+=us*48000;const n=Math.floor(this.fraction/1000000);this.fraction-=n*1000000;
  let left=n;while(left){const take=Math.min(left,128-this.quantum);if(!this.quantum)this.apply();this.advance(take);this.frames+=BigInt(take);this.quantum=(this.quantum+take)%128;left-=take;}
 }
 project(){let fg=this.foreground?{...this.foreground}:null,fx=this.fx.map(x=>({...x}));for(const e of this.events)({fg,fx}=this.effect(e,fg,fx,false));return {fg,fx};}
 release(x){if(x)this.objects.get(x.handle).pins--;}
 effect(e,fg,fx,live) {
  const drop=x=>{if(live)this.release(x);};
  if(e.op===48){drop(fg);fg={...e.instance};if(live){this.state=1;this.lastPlay=fg.id;this.lastHandle=fg.handle;this.lastPosition=0;}}
  if(e.op===54){fx=fx.filter(x=>{if(x.mask&e.instance.mask){drop(x);return false;}return true;});fx.push({...e.instance});}
  if(e.op===50&&fg){if(e.action===0){drop(fg);fg=null;if(live)this.state=0;}else fg.paused=e.action===1;}
  if(e.op===55||e.op===57)fx=fx.filter(x=>{if(e.op===55?(e.mask===0||x.mask&e.mask):x.id===e.id){if(!e.action){drop(x);return false;}x.paused=e.action===1;}return true;});
  return {fg,fx};
 }
 apply(){for(const e of this.events)({fg:this.foreground,fx:this.fx}=this.effect(e,this.foreground,this.fx,true));this.events=[];}
 advance(n){
  const step=x=>{if(x.paused)return true;const m=this.objects.get(x.handle).pcm;x.time+=n*m.rate;const frame=Math.floor(x.time/48000);if(!x.loop&&x.repeats&&frame>=m.frames*x.repeats){x.position=m.frames;return false;}x.position=m.loop&&frame>=m.end?m.start+(frame-m.start)%(m.end-m.start):frame%m.frames;return true;};
  if(this.foreground){if(!step(this.foreground)){this.lastPosition=this.foreground.position;this.release(this.foreground);this.foreground=null;this.state=3;}else this.lastPosition=this.foreground.position;}
  this.fx=this.fx.filter(x=>{if(step(x))return true;this.release(x);return false;});
 }
 render(n){this.apply();this.advance(n);} // C vector boundary: rendering vs delivered frames are separate
 id(fx){const used=new Set([...(fx?this.fx:this.foreground?[this.foreground]:[]),...this.events.filter(e=>e.op===(fx?54:48)).map(e=>e.instance)].map(x=>x.id));let id=this[fx?'nextFx':'nextPlay'];while(!id||used.has(id))id=id%65535+1;this[fx?'nextFx':'nextPlay']=id%65535+1;return id;}
 snap(){const r=super.snap(),present=!!this.foreground||this.state!==0;r.writeBigUInt64LE(this.frames,12);r.writeUInt16LE(present?this.lastPlay:0,20);r[24]=this.foreground?(this.foreground.paused?2:1):this.state;r[25]=present?1:0;r[26]=present?(this.objects.get(this.lastHandle)?.pcm.channels??0):0;r.writeUInt16LE(present?this.lastHandle:0,28);r.writeUInt32LE(present?(this.foreground?.position??this.lastPosition):0,32);let mask=0;if(this.foreground&&!this.foreground.paused)mask=this.objects.get(this.foreground.handle).pcm.channels===2?3:1;for(const x of this.fx)if(!x.paused)mask|=x.mask;r.writeUInt16LE(mask,52);r[50]=this.lastAudioError;return r;}
 command(op,q,defer=false) {
  const err=e=>[e,Buffer.alloc(0)],ok=(r=Buffer.alloc(0))=>[0,r];
  if(op===19&&q.length!==7||op===18&&q.length!==2)return err(3);
  if(this.transfer&&[19,20].includes(op))return err(5);
  if(op===1){const result=super.command(op,q,defer);if(!result[0]){result[1].writeUInt16LE(8000,28);result[1].writeUInt16LE(48000,30);}return result;}
  if(op===6){for(const x of [this.foreground,...this.fx,...this.events.filter(e=>e.instance).map(e=>e.instance)])if(x)this.release(x);this.foreground=null;this.fx=[];this.events=[];this.lastPlay=this.lastHandle=this.state=0;}
  if(op===20){this.trace.push({op,q:q.toString('hex')});if(q.length!==26)return err(3);const o=this.objects.get(q.readUInt16LE());if(!o)return err(7);if(o.kind!==1||o.state||o.pins)return err(6);try{o.pcm=rawInfo(q.subarray(2),o.size);}catch{return err(11);}return ok();}
  if(op===19&&this.objects.get(q.readUInt16LE())?.kind){
   this.trace.push({op,q:q.toString('hex')});if(q.length!==7)return err(3);const o=this.objects.get(q.readUInt16LE());if(o.state||o.uploaded!==o.size||o.kind===1&&!o.pcm)return err(6);if(o.pins)return err(18);if(q[2]>1||(!q[2]&&q.readUInt32LE(3)))return err(2);
   const crc=crc32(o.data);if(q[2]&&crc!==q.readUInt32LE(3)){o.state=2;return err(4);}
   try{if(o.kind===2)o.pcm=wavInfo(o.data);else if(!o.pcm)throw Error('config');}catch{o.state=2;return err(11);}
   o.state=1;o.crc=crc;const r=Buffer.alloc(4);r.writeUInt32LE(crc);return ok(r);
  }
  if(op===18){const result=super.command(op,q,defer),o=this.objects.get(q.readUInt16LE());if(!result[0]&&o?.pcm&&o.state===1){const r=result[1],m=o.pcm;r.writeUInt32LE(m.offset,18);r.writeUInt32LE(m.length,22);r.writeUInt32LE(m.rate,26);r.writeUInt32LE(m.frames,30);r[34]=m.channels;r[35]=m.bits;r[36]=m.format;}return result;}
  if(![48,50,54,55,57,81].includes(op))return super.command(op,q,defer);
  this.trace.push({op,q:q.toString('hex')});if(q.length!==({48:6,50:3,54:8,55:2,57:3,81:2})[op])return err(3);
  if(op===81){const first=q[0],count=q[1];if(!count||count>7||first+count>16)return err(2);const r=Buffer.alloc(2+16*count);r[0]=first;r[1]=count;for(let i=0;i<count;i++){const lane=first+i,x=this.fx.find(x=>x.mask&(1<<lane));if(!x)continue;const at=2+16*i,m=this.objects.get(x.handle).pcm;r.writeUInt16LE(x.id,at);r.writeUInt16LE(x.mask,at+2);r.writeUInt16LE(x.handle,at+4);r[at+6]=x.paused?2:1;r[at+7]=m.channels;r.writeUInt32LE(x.position,at+8);r[at+12]=x.gain;r[at+13]=x.pan;r[at+14]=x.priority;r[at+15]=m.channels===2&&(lane&1)?2:0;}return ok(r);}
  if(this.transfer)return err(5);if(this.events.length===16)return err(5);
  const {fg,fx}=this.project();let e={op};
  if(op===48||op===54){
   const h=q.readUInt16LE(),o=this.objects.get(h);if(!o)return err(7);if(o.state!==1)return err(6);if(!o.pcm)return err(11);const m=o.pcm,fxplay=op===54,gain=q[fxplay?5:4],pan=q[fxplay?6:5];if(gain>64)return err(2);
   const flags=fxplay?q[7]:0,repeats=fxplay?1:q.readUInt16LE(2);if(flags>3||(m.loop&&(fxplay?flags&2:repeats!==1)))return err(2);
   let mask=m.channels===2?3:1;
   if(fxplay){const allowed=q.readUInt16LE(2)||0x0f00,pri=q[4];if(!pri||pri===255)return err(2);if(allowed&~0xf00)return err(2);const candidates=[];for(let lane=8;lane<12;lane+=m.channels){const mask=(m.channels===2?3:1)<<lane;if((mask&allowed)!==mask)continue;const victims=fx.filter(x=>x.mask&mask);if(victims.length&&(!(flags&1)||victims.some(x=>x.priority>=pri||x.priority===0||x.priority===255)))continue;candidates.push({mask,score:victims.length?Math.max(...victims.map(x=>x.priority))+1:0});}candidates.sort((a,b)=>a.score-b.score||a.mask-b.mask);if(!candidates.length)return err(12);mask=candidates[0].mask;}
   const id=this.id(fxplay);e.instance={id,handle:h,mask,priority:fxplay?q[4]:0,gain,pan,loop:m.loop||!!(flags&2),repeats,paused:false,time:0,position:0};o.pins++;this.events.push(e);this.audioTrace.push({op,id,handle:h,mask});return ok(fxplay?Buffer.concat([u16(id),u16(mask)]):u16(id));
  }
  if(op===55){e.mask=q.readUInt16LE();if(e.mask&~0xf00)return err(2);e.action=0;}
  else {e.id=q.readUInt16LE();e.action=q[2];if(e.action>2)return err(2);if(op===50){if(!fg||e.id&&e.id!==fg.id||e.action===2&&!fg.paused)return err(6);}else {const x=fx.find(x=>x.id===e.id);if(!e.id||!x)return err(7);if(e.action===2&&!x.paused)return err(6);}}
  this.events.push(e);return ok();
 }
}
