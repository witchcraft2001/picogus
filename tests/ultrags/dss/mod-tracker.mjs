// SPDX-License-Identifier: GPL-2.0-or-later
// Independent structural/timing oracle for the native MOD4/MOD8 DSS tests.
// No sample mixer or full tracker-effect/audio conformance is claimed here.
export function parseMod4(data) {
 if(data.length<1084||!['M.K.','M!K!','8CHN'].includes(data.toString('ascii',1080,1084)))throw Error('signature');
 const channels=data.toString('ascii',1080,1084)==='8CHN'?8:4;
 const song=data[950],restart=data[951],orders=[...data.subarray(952,1080)];
 if(!song||song>128||orders.slice(0,song).some(n=>n>=128))throw Error('orders');
 const patterns=1+Math.max(...orders.filter(n=>n<128)),sampleOffset=1084+patterns*256*channels;
 if(sampleOffset>data.length)throw Error('patterns');
 const samples=[];let sampleBytes=0;
 for(let i=0;i<31;i++) {
  const p=20+i*30,length=data.readUInt16BE(p+22)*2,volume=data[p+25],start=data.readUInt16BE(p+26)*2,loop=data.readUInt16BE(p+28)*2;
  if(volume>64||loop>2&&(start>=length||start+loop>length))throw Error('sample');
  samples.push({length,volume,start,loop:loop>2?loop:0});sampleBytes+=length;
 }
 if(sampleOffset+sampleBytes>data.length)throw Error('sample bytes');
 return {channels,song,restart,orders,patterns,sampleOffset,sampleBytes,samples,data};
}
export class ModClock {
 constructor(info,loop=false,ignoreF00=false){this.ignoreF00=ignoreF00;this.info=info;this.loop=loop;this.paused=false;this.ended=false;this.seek(0,0);}
 seek(order,row){
  const paused=this.paused;this.order=order;this.row=row;this.tick=0;this.speed=6;this.bpm=125;this.phase=0;this.delay=0;this.tempo=null;this.ended=false;
  this.channel=Array.from({length:this.info.channels},(_,i)=>[0,255,255,0][i%4]).map(pan=>({note:127,volume:64,pan,period:0,sample:-1,active:false}));
  this.loadRow();this.paused=paused||this.paused;
 }
 loadRow(){
  this.jump=null;this.break=null;
  const base=1084+(this.info.orders[this.order]*64+this.row)*this.info.channels*4;
  this.channel.forEach((c,i)=>{
   const at=base+i*4,b=this.info.data,sample=(b[at]&240)|(b[at+2]>>4),period=((b[at]&15)<<8)|b[at+1],fx=b[at+2]&15,param=b[at+3];
   if(sample>31)throw Error('pattern sample');
   if(sample){c.sample=sample-1;c.volume=this.info.samples[c.sample].volume;}
   if(period){c.period=period;c.note=Math.max(0,Math.min(95,Math.round(36+12*Math.log2(856/period))));c.active=c.sample>=0&&this.info.samples[c.sample].length>0;}
   if(fx===8)c.pan=param;
   if(fx===11)this.jump=param;
   if(fx===12)c.volume=Math.min(64,param);
   if(fx===13){const r=(param>>4)*10+(param&15);this.break=(param>>4)>9||(param&15)>9||r>63?0:r;}
   if(fx===14&&(param>>4)===8)c.pan=(param&15)*17;
   if(fx===14&&(param>>4)===14)this.delay=param&15;
   if(fx===15){if(!param){if(!this.ignoreF00)this.paused=true;}else if(param<32)this.speed=param;else this.bpm=param;}
  });
 }
 boundary(){
  if(this.tempo){[this.speed,this.bpm]=this.tempo;this.tempo=null;}
  if(this.tick+1<this.speed){this.tick++;return;}
  if(this.delay){this.tick=0;this.delay--;return;}
  let order=this.order,row=this.row+1;
  if(this.jump!==null||this.break!==null){order=this.jump??order+1;row=this.break??0;}else if(row===64){row=0;order++;}
  if(order>=this.info.song){if(!this.loop){this.ended=true;return;}order=this.info.restart<this.info.song?this.info.restart:0;}
  this.order=order;this.row=row;this.tick=0;this.loadRow();
 }
 advance(frames){
  while(frames>0&&!this.paused&&!this.ended){
   const available=Math.ceil((120000-this.phase)/this.bpm),take=Math.min(frames,available);
   this.phase+=take*this.bpm;frames-=take;
   if(this.phase>=120000){this.phase-=120000;this.boundary();}
  }
  return !this.ended;
 }
}
