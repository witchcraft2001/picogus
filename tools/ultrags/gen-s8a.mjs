// SPDX-License-Identifier: GPL-2.0-or-later
// Independently specified 8CHN interleaved offsets; no production parser import.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const out=resolve(process.argv[2]??'build/s8a-test-audio');mkdirSync(out,{recursive:true});
const periods=[856,808,762,720,678,640,604,570],mod=Buffer.alloc(1084+4096+8*64);
mod.write('S8a eight voices',0);mod[950]=2;mod[953]=1;mod.write('8CHN',1080);
for(let c=0;c<8;c++){
 const h=20+30*c;mod.write('voice '+c,h);mod.writeUInt16BE(32,h+22);mod[h+25]=12;mod.writeUInt16BE(32,h+28);
 for(let p=0;p<2;p++){
  const off=1084+p*2048+c*4,period=periods[(c+p)%8];
  mod[off]=period>>8;mod[off+1]=period&255;mod[off+2]=(c+1)<<4;
  assert.equal(off,1084+(p*64*8+c)*4);
 }
 for(let i=0;i<64;i++)mod[1084+4096+c*64+i]=i<32?64:192;
}
function wave(channels){
 const n=12000,b=Buffer.alloc(44+n*channels*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(48000*channels*2,28);b.writeUInt16LE(channels*2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*channels*2,40);
 for(let i=0;i<n;i++)for(let c=0;c<channels;c++)b.writeInt16LE(i%(c?48:64)<(c?24:32)?2048:-2048,44+(i*channels+c)*2);
 return b;
}
const sha=b=>createHash('sha256').update(b).digest('hex'),files=[];
for(const [name,data]of [['EIGHT.MOD',mod],['FX8.WAV',wave(1)],['FXST.WAV',wave(2)]]){writeFileSync(join(out,name),data);files.push({name,bytes:data.length,sha256:sha(data)});}
writeFileSync(join(out,'fixtures.json'),JSON.stringify({license:'GPL-2.0-or-later; generated synthetic audio',generatorSha256:sha(readFileSync(new URL(import.meta.url))),files,mod:{channels:8,patterns:2,patternBytes:2048,rowBytes:32,sampleOffset:5180,periods,pan:[0,255,255,0,0,255,255,0],volume:12,finiteFrames:737280}},null,2)+'\n');
console.log('S8a deterministic MOD8/mono/stereo assets:',out);
