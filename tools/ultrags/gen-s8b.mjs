// SPDX-License-Identifier: GPL-2.0-or-later
// Independent file writer: no firmware parser or offset helper is imported.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const out=resolve(process.argv[2]??'build/host/s8b/fixtures');mkdirSync(out,{recursive:true});
const flt=Buffer.alloc(7484),chn=Buffer.alloc(7484),offsets=[];
for(const b of [flt,chn]){
 b[950]=6;for(let i=0;i<6;i++)b[952+i]=b===flt?i:Math.floor(i/2);
 b.write(b===flt?'FLT8':'8CHN',1080);
 for(let c=0;c<8;c++){
  b.writeUInt16BE(16,42+30*c);b[45+30*c]=12;b.writeUInt16BE(16,48+30*c);
  for(let i=0;i<32;i++)b[7228+c*32+i]=(i<16?24+c*4:232-c*4);
 }
}
// Write the physical FLT8 file in four-channel block order.
for(let block=0;block<6;block++)for(const row of [0,63])for(let lane=0;lane<4;lane++){
 const pair=Math.floor(block/2),c=(block%2)*4+lane,period=856-30*c-8*pair-(row===63?1:0);
 const off=1084+block*1024+row*16+lane*4;
 flt.set([period>>8,period&255,(c+1)<<4,0],off);offsets.push({pair,row,channel:c,offset:off,period});
}
// Construct an interleaved equivalent from musical events, never from FLT8 bytes.
for(let p=0;p<3;p++)for(const r of [0,63])for(let c=0;c<8;c++){
 const n=856-30*c-8*p-(r===63?1:0),off=1084+(p*64*8+r*8+c)*4;
 chn.set([n>>8,n&255,(c+1)<<4,0],off);
}
// Literal boundary checks independent of the writer's offset expression.
for(const [off,p]of [[1084,856],[2108,736],[2092,855],[3116,735],[3132,848],[5180,840],[7212,719]])assert.equal(flt.readUInt16BE(off),p);
assert.equal(flt[7228],24);assert.equal(flt[7483],204);
// FLT4 and its M.K. oracle are written independently from musical events.
const flt4=Buffer.alloc(4284),ref4=Buffer.alloc(4284),orders4=[0,1,2,1,0,2];
for(const b of [flt4,ref4]){
 b[950]=6;b.set(orders4,952);b.write(b===flt4?'FLT4':'M.K.',1080);
 for(let c=0;c<4;c++){
  b.writeUInt16BE(16,42+30*c);b[45+30*c]=12;b.writeUInt16BE(16,48+30*c);
  for(let i=0;i<32;i++)b[4156+c*32+i]=i<16?24+c*4:232-c*4;
 }
}
for(let block=0;block<3;block++)for(const row of [0,63])for(let lane=0;lane<4;lane++){
 const n=856-30*lane-8*block-(row===63?1:0),off=1084+block*1024+row*16+lane*4;
 flt4.set([n>>8,n&255,(lane+1)<<4,0],off);
}
for(let p=0;p<3;p++)for(let c=0;c<4;c++)for(const r of [0,63]){
 const n=856-30*c-8*p-(r===63?1:0);
 ref4.set([n>>8,n&255,(c+1)<<4,0],1084+4*(p*256+r*4+c));
}
for(const [off,n]of [[1084,856],[2092,855],[2108,848],[3132,840],[4152,749]])assert.equal(flt4.readUInt16BE(off),n);
assert.equal(flt4[4156],24);assert.equal(flt4[4283],220);
const sha=b=>createHash('sha256').update(b).digest('hex'),files=[];
// Eleven physical pairs, only the first three played. Extra pairs deliberately
// contain invalid events; they must still separate the song from its PCM.
const tail=Buffer.alloc(23868);flt.copy(tail,0,0,7228);tail[1079]=21;
tail.fill(255,7228,23612);flt.copy(tail,23612,7228);
assert.equal(tail[23612],24);assert.equal(tail[23867],204);
for(const [name,data]of [['FLT8.MOD',flt],['FLT8TAIL.MOD',tail],['FLT8REF.MOD',chn],['FLT4.MOD',flt4],['FLT4REF.MOD',ref4]]){writeFileSync(join(out,name),data);files.push({name,bytes:data.length,sha256:sha(data)});}
for(const channels of [1,2,3,28,31,32]){
 const b=Buffer.alloc(1084+2*256*channels+31*4);b[950]=2;b[953]=1;b.write(channels+(channels<10?'CHN':'CH'),1080);
 for(let c=0;c<31;c++){b.writeUInt16BE(2,42+c*30);b[45+c*30]=16;b.writeUInt16BE(2,48+c*30);b.fill(c%7+1,1084+512*channels+c*4,1084+512*channels+c*4+4);}
 for(let p=0;p<2;p++)for(const row of [0,63])for(let c=0;c<channels;c++){
  const period=856-12*c-4*p-(row===63?1:0),sample=c%31+1;
  b.set([(sample&240)|(period>>8),period&255,(sample&15)<<4,0],1084+(p*64+row)*channels*4+c*4);
 }
 const name='MOD'+channels+'.MOD';writeFileSync(join(out,name),b);files.push({name,bytes:b.length,sha256:sha(b)});
}
writeFileSync(join(out,'fixtures.json'),JSON.stringify({license:'GPL-2.0-or-later; synthetic PCM',generatorSha256:sha(readFileSync(new URL(import.meta.url))),files,orders:[0,1,2,3,4,5],normalized:[0,0,1,1,2,2],sampleOffset:7228,offsets,flt4:{orders:orders4,sampleOffset:4156}},null,2)+'\n');
console.log('S8b independent FLT8/8CHN, FLT4/M.K. and literal boundary offsets PASS');
