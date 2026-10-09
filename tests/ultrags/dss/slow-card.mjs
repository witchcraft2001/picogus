// SPDX-License-Identifier: GPL-2.0-or-later
// Independent S4 oracle for actual assembled Z80 programs, never firmware evidence.
import {MemoryCard} from './memory-card.mjs';
import {crc32} from './config-card.mjs';
export class SlowCard extends MemoryCard {
 constructor(catalog,opts={}) {super(catalog,opts);this.transfer=null;this.nextToken=opts.nextToken??1;this.fault=false;this.ackToken=0;this.trace=[];this.stats=new Uint32Array(16);this.snapshot=Buffer.alloc(128);this.snapshot[27]=255;for(let i=0;i<8;i++)this.snapshot[56+8*i]=127;this.index=0;}
 tickUs(us) {super.tickUs(us);if(this.transfer?.granted && this.now-this.transfer.last>=5000000){this.cancel();this.error=13;this.stats[8]++;}}
 cancel(){if(this.transfer)this.objects.get(this.transfer.h).pins--;this.transfer=null;this.ackToken=0;}
 readPort(p) {
  const off=this.alias!==65535&&p>=this.alias&&p<this.alias+32?0:p-this.base;
  if(off===3){const v=super.readPort(p);if(!this.response.length && this.ackToken && this.transfer?.id===this.ackToken){this.transfer.granted=true;this.transfer.last=this.now;this.ackToken=0;}return v;}
  if(off===1)return (this.fault?0:super.readPort(p))|(this.transfer?.granted?(this.transfer.rd?16:8):0);
  if(off===0x1b)return 0x7e|(this.transfer?.granted&&this.transfer.rd&&this.transfer.done<this.transfer.n?128:0);
  if(off===0||off===0x13){const t=this.transfer;if(!t?.granted||!t.rd||t.bulk!==(off===0)){this.error=6;return 255;}if(t.done===t.n){t.fault=14;this.error=15;return 255;}t.last=this.now;return t.data[t.done++];}
  if(off===4)return this.index;
  if(off===5){if(this.index===128){this.error=15;return 255;}return this.snapshot[this.index++];}
  return super.readPort(p);
 }
 writePort(p,v) {
  const off=this.alias!==65535&&p>=this.alias&&p<this.alias+32?0:p-this.base;
  if(off===2){if(v===0xa0){this.cancel();this.fault=false;}if(v===0xa1){this.cancel();return;}if(v===0xa3){this.snapshot=this.snap();this.index=0;return;}if(v===0xa2){this.error=0;return;}}
  if(off===4){if(v>127)this.error=8;else this.index=v;return;}
  if(off===0||off===0x13){const t=this.transfer;if(!t?.granted||t.rd||t.bulk!==(off===0)){this.error=6;return;}if(t.done===t.n){this.error=t.fault=14;return;}t.data[t.done++]=v;t.last=this.now;return;}
  if(off===0x1b){if([0,0xf3,0xf4].includes(v)){this.cancel();if(v){this.objects.clear();this.session++;this.next=1;this.nextToken=1;}}else this.gsError=this.transfer?5:1;return;}
  if(off===3 && this.fault)return;
  if(off===3 && this.frame.length===1 && v>128){this.frame=[];this.fault=true;this.error=3;return;}
  super.writePort(p,v);
 }
 snap(){const r=Buffer.alloc(128);r.writeUInt32LE((this.seq=(this.seq??0)+1));r.writeBigUInt64LE(this.session,4);r[27]=255;for(let i=0;i<8;i++)r[56+i*8]=127;if(this.transfer){r.writeUInt32LE(this.transfer.id,120);r.writeUInt16LE(this.transfer.done,124);r.writeUInt16LE(this.transfer.n,126);}return r;}
 command(op,q,defer=false) {
  this.trace.push({op,q:q.toString('hex')});
  const err=e=>[e,Buffer.alloc(0)],ok=(r=Buffer.alloc(0))=>[0,r];
  const t=this.transfer;
  if(t && ![0,2,3,18,33,35,36,80].includes(op))return err(5);
  if(t && op===18 && q.length===2 && q.readUInt16LE()!==t.h)return err(5);
  if(op===3){if(q.length)return err(3);const r=Buffer.alloc(64);for(let i=0;i<16;i++)r.writeUInt32LE(this.stats[i],4*i);return ok(r);}
  if(op===4){if(q.length)return err(3);this.stats.fill(0);return ok();}
  if(op===80){return q.length?err(3):ok(this.snap());}
  if(op===32||op===34) {
   if(q.length<9 || q.length!==(op===32&&(q[8]&128)?13:9))return err(3);
   const h=q.readUInt16LE(),off=q.readUInt32LE(2),n=q.readUInt16LE(6),tr=q[8],o=this.objects.get(h),rd=op===34;
   if(tr&126)return err(2);if(!o)return err(7);
   if(!n||n>1024)return err(3);if(o.state===2||(!rd&&o.state))return err(6);
   if(off>o.size||n>o.size-off)return err(8);
   const uploaded=o.uploaded??0;
   if(rd ? off>uploaded||n>uploaded-off : off!==uploaded&&!(o.kind===0&&off<=uploaded&&n<=uploaded-off))return err(8);
   if(!this.nextToken)return err(14);
   const id=this.nextToken;this.nextToken=(id+1)>>>0;o.pins++;
   this.transfer={h,off,n,id,rd,bulk:!(tr&1),verify:!!(tr&128),crc:op===32&&tr&128?q.readUInt32LE(9):0,data:rd?Buffer.from(o.data.subarray(off,off+n)):Buffer.alloc(n),done:0,granted:false,last:this.now};this.ackToken=id;
   const r=Buffer.alloc(rd&&tr&128?8:4);r.writeUInt32LE(id);if(r.length===8)r.writeUInt32LE((crc32(this.transfer.data)^(this.o.badReadCrc?1:0))>>>0,4);return ok(r);
  }
  if([33,35,36].includes(op)) {
   if(q.length!==(op===35&&t?.verify?8:4))return err(3);
   if(!t||q.readUInt32LE()!==t.id)return err(7);
   if(op===36){this.cancel();return ok();}
   if(!t.granted||t.rd!==(op===35))return err(6);
   let e=t.fault??0;if(!e&&t.done!==t.n)e=16;
   if(!e&&t.verify&&(t.rd?q.readUInt32LE(4):crc32(t.data))!==(t.rd?crc32(t.data):t.crc))e=4;
   if(!e&&!t.rd){const o=this.objects.get(t.h);t.data.copy(o.data,t.off);o.uploaded=Math.max(o.uploaded??0,t.off+t.n);this.stats[2]+=t.n;this.stats[4]++;}
   if(!e&&t.rd){this.stats[3]+=t.n;this.stats[5]++;}
   this.cancel();return e?err(e):ok();
  }
  if(op===19){if(q.length!==7)return err(3);const o=this.objects.get(q.readUInt16LE());if(q[2]>1||(!q[2]&&q.readUInt32LE(3)))return err(2);if(!o)return err(7);if(o.kind)return err(1);if(o.state||o.uploaded!==o.size)return err(6);if(o.pins)return err(18);const crc=crc32(o.data);if(q[2]&&crc!==q.readUInt32LE(3)){o.state=2;return err(4);}o.state=1;o.crc=crc;const r=Buffer.alloc(4);r.writeUInt32LE(crc);return ok(r);}
  const result=super.command(op,q,defer);
  if(!result[0]&&op===16){const o=this.objects.get(result[1].readUInt16LE());o.data=Buffer.alloc(o.size);o.uploaded=0;o.state=0;}
  if(!result[0]&&op===18){const o=this.objects.get(q.readUInt16LE());result[1][3]=o.state??0;result[1].writeUInt32LE(o.uploaded??0,10);result[1].writeUInt32LE(o.crc??0,14);}
  return result;
 }
}
