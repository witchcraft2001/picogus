// SPDX-License-Identifier: GPL-2.0-or-later
// Independent command/store model for execution of the actual Z80 binary.
import {ConfigCard,crc32} from './config-card.mjs';
export class MemoryCard extends ConfigCard {
 constructor(catalog,opts={}) {
  super(catalog,{mode:8,...opts});this.objects=new Map();this.next=1;this.session=123n;
  this.pool=opts.pool??8388608;this.frame=[];this.pending=null;this.error=opts.stickyError??0;this.resets=0;this.calls=[];
  this.memoryError=opts.memoryError??(opts.unavailable?17:0);this.bootState=opts.bootState??(this.memoryError?1:0);
  this.gs=opts.gs??this.gs;
  let offset=0;
  if(opts.objects)for(const [h,size] of opts.objects){const reserved=Math.ceil(size/16)*16;this.objects.set(h,{kind:0,size,reserved,offset,pins:opts.pins??0});offset+=reserved;}
 }
 complete(){this.pending.commit?.();this.response=this.pending.reply;this.pending=null;}
 tickUs(us){super.tickUs(us);if(this.pending && this.now>=this.pending.at && !this.o.noReply && this.o.noReplyOp!==this.pending.op)this.complete();}
 readPort(p){
  if(this.o.absent)return 255;
  if(p===0x1d0)return 0xdd;
  if(p-this.base===1 && this.mode===8)return (this.o.busy?2:this.response.length?4:this.pending?2:this.frame.length?0:1)|(this.error?32:0);
  if(p-this.base===6)return this.error;
  if(p-this.base===8)return this.o.api??1;
  return super.readPort(p);
 }
 writePort(p,v){
  if(p===this.base+2 && v===0xa0){this.frame=[];this.response=[];this.pending=null;this.error=0;this.resets++;return;}
  if(p!==this.base+3 || this.mode!==8){super.writePort(p,v);return;}
  if(this.response.length||this.pending||this.o.busy){this.error=5;return;}
  this.frame.push(v);
  const q=this.frame;if(q.length<2||q.length!==2+q[1]+(q[0]&128?4:0))return;
  const cmd=q[0]&127,checked=!!(q[0]&128),args=Buffer.from(q.slice(2,2+q[1]));this.frame=[];
  const badRequestCrc=checked && crc32(q.slice(0,-4))!==Buffer.from(q).readUInt32LE(q.length-4);
  let [status,data,commit]=badRequestCrc?[4,Buffer.alloc(0)]:this.command(cmd,args,true);
  if(this.o.badStatus && cmd===2)status=22;
  let reply=Buffer.concat([Buffer.from([status,data.length]),data]);
  if(this.o.badLength && cmd===2)reply[1]=19;
  if(checked){const c=Buffer.alloc(4);c.writeUInt32LE(crc32(reply));reply=Buffer.concat([reply,c]);if(this.o.badCrc)reply[reply.length-1]^=1;}
  if(status)this.error=status;
  this.calls.push(cmd);
  const delay=cmd===5 || (cmd===6 && args[4])?(this.o.delayUs??1000):(this.o.simpleDelayUs??0);
  this.pending={at:this.now+delay,reply:[...reply],op:cmd,commit};
  if(!delay && !this.o.noReply && this.o.noReplyOp!==cmd)this.complete();
 }
 command(op,q,defer=false){
  let r=Buffer.alloc(0);const ok=()=>[0,r],err=s=>[s,Buffer.alloc(0)];
  const sizes={0:0,1:0,2:0,5:1,6:5,16:5,17:2,18:2,21:2};
  if(!(op in sizes))return err(1);if(q.length!==sizes[op])return err(3);
  if(op===0){r=Buffer.alloc(36);r.write('UGS1');r[4]=this.o.api??1;r[6]=8;r[7]=this.bootState;r.writeUInt32LE(0x040101,8);r.writeBigUInt64LE(this.session,12);r.write('000000000000000+',20);return ok();}
  if(op===1){r=Buffer.alloc(32);r.writeUInt32LE(this.o.noCaps?0:1510|(this.alias!==65535?8:0)|(this.gs?512:0));if(!this.o.noCaps)r.writeUInt32LE(15,4);r.writeUInt32LE(48000,8);r.writeUInt16LE(1024,12);r.writeUInt16LE(128,14);r.writeUInt16LE(128,16);r[20]=8;r[21]=this.o.noCaps?0:4;r[22]=1;r.writeUInt16LE(this.base,24);r.writeUInt16LE(this.alias,26);return ok();}
  if(this.bootState===2)return err(5);
  if(op===2){r=Buffer.alloc(20);r.writeUInt32LE(this.pool);r.writeUInt32LE(this.pool,4);let end=0,free=0,largest=0;for(const o of [...this.objects.values()].sort((a,b)=>a.offset-b.offset).concat([{offset:this.pool,reserved:0}])){const gap=o.offset-end;free+=gap;largest=Math.max(largest,gap);end=o.offset+o.reserved;}r.writeUInt32LE(free,8);r.writeUInt32LE(largest,12);r.writeUInt16LE(this.objects.size,16);r.writeUInt16LE(128,18);return ok();}
  if(op===16){if(this.memoryError)return err(this.memoryError);const size=q.readUInt32LE(1);if(q[0]>3)return err(2);if(!size)return err(3);if(size>0xfffffff0)return err(8);if(this.objects.size===128||this.next>65535)return err(10);let end=0;const reserved=Math.ceil(size/16)*16;for(const o of [...this.objects.values()].sort((a,b)=>a.offset-b.offset).concat([{offset:this.pool,reserved:0}])){if(reserved<=o.offset-end){const h=this.next++;this.objects.set(h,{kind:q[0],size,reserved,offset:end,pins:0});r=Buffer.alloc(6);r.writeUInt16LE(h);r.writeUInt32LE(reserved,2);return ok();}end=o.offset+o.reserved;}return err(9);}
  if(op===17){const h=q.readUInt16LE();if(!this.objects.has(h))return err(7);if(this.objects.get(h).pins)return err(18);this.objects.delete(h);return ok();}
  if(op===18){const h=q.readUInt16LE(),o=this.objects.get(h);if(!o)return err(7);r=Buffer.alloc(38);r.writeUInt16LE(h);r[2]=o.kind;r.writeUInt16LE(o.pins,4);r.writeUInt32LE(o.size,6);return ok();}
  if(op===21){r=Buffer.alloc(2);r.writeUInt16LE([...this.objects.keys()].sort((a,b)=>a-b).find(h=>h>q.readUInt16LE())??0);return ok();}
  const finish=status=>{const commit=()=>{this.memoryError=status;this.bootState=status?1:0;};if(!defer)commit();return [status,r,defer?commit:undefined];};
  if(op===6){if(q.readUInt32LE()!==0x55475253||q[4]>1)return err(2);this.objects.clear();this.session++;this.next=1;if(!q[4]){r=Buffer.alloc(8);r.writeBigUInt64LE(this.session);return ok();}if(this.o.memoryFault||this.o.unavailable)return finish(17);r=Buffer.alloc(8);r.writeBigUInt64LE(this.session);return finish(0);}
  if(q[0]>1)return err(2);if(this.objects.size)return err(5);
  if(this.o.unavailable){r=Buffer.alloc(14);r.writeUInt32LE(0xffffffff,4);return finish(17);}
  const points=new Set([0,this.pool-1]);for(let a=1;a<this.pool;a*=2){points.add(a);points.add(a-1);}
  r=Buffer.alloc(14);r.writeUInt32LE(q[0]?15*this.pool:points.size*2);r.writeUInt32LE(0xffffffff,4);r.writeUInt32LE((this.o.delayUs??1000)/1000,10);
  // Inject a stuck-low bit 7, matching the shared actual-C fault fixture.
  // FULL's 00 pass succeeds; the first FF comparison then fails.
  if(this.o.memoryFault){r.writeUInt32LE(q[0]?this.pool+1:1);r.writeUInt32LE(0,4);r[8]=q[0]?255:128;r[9]=q[0]?127:0;return finish(17);}return finish(0);
 }
}
