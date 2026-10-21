// SPDX-License-Identifier: GPL-2.0-or-later
// Short, uncompressed MODs with a high-channel note after F00.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha256} from './build-evidence.mjs';
export function makeF00Mod(channels) {
 const b=Buffer.alloc(1084+256*channels+32),sample=1084+256*channels;
 b.write('F00 policy regression');b[950]=1;b.write(channels===8?'8CHN':'M.K.',1080);
 b.writeUInt16BE(16,42);b[45]=64;b.writeUInt16BE(16,48);b.fill(64,sample);
 const event=(row,ch,period,fx,param)=>{const o=1084+(row*channels+ch)*4;b[o]=period>>8;b[o+1]=period&255;b[o+2]=(period?16:0)|fx;b[o+3]=param;};
 event(0,0,0,15,3);event(0,1,0,15,150);event(0,channels-1,428,0,0);
 event(1,channels-1,0,15,0);event(2,channels-1,320,0,0);event(3,0,0,13,0);
 return b;
}
if(import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const out=resolve(process.argv[2]??'build/f00-test-audio');mkdirSync(out,{recursive:true});
 const files=[4,8].map(ch=>{const name=`F00MOD${ch}.MOD`,b=makeF00Mod(ch);writeFileSync(join(out,name),b);return {name,bytes:b.length,sha256:sha256(b)};});
 writeFileSync(join(out,'fixtures.json'),JSON.stringify({files,expected:{tick_frames:800,speed:3,bpm:150,f00_frame:2400,post_note_frame:4800,post_period:320,eof_frame:9600}},null,2)+'\n');
}
