// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {readZip,readFat12} from './verify-package.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
const dir='build/host/docs/';
const entries=readdirSync(dir+'examples').filter(n=>/\.(EXE|WAV)$/.test(n)&&!n.startsWith('DISCOVER')).sort().map(n=>{
 if(n.length>12||n.split('.')[0].length>8)throw Error('not DOS 8.3: '+n);
 return [n,readFileSync(dir+'examples/'+n)];
});
entries.push(['LESSONS.TXT',Buffer.from('UltraGS guide examples. Configure ULTRAGS / BASE 02A0 first.\r\nDISCOV0 (slot0) or DISCOV1 (slot1)\r\nPCM0 (slot0) or PCM1 (slot1): standalone first-sound lesson\r\nOther EXEs below reuse complete diagnostic applications.\r\nGSMOD MOD4\r\nGSFX GS\r\nPCM PCM /VERIFY\r\nMODFX MOD8 /VERIFY\r\nFM MIX /FX:STEREO /TURBO:OFF /SECONDS:2\r\nSTREAM STREAM GUIDE.WAV /BUFFER:16 /PREFILL:8 /LOW:4\r\nAdd /SLOT:1 to all lessons except DISCOV1/PCM1 for slot1.\r\nDo not use /RESET. GS lessons and PCM0/PCM1 require an empty store.\r\nGSFX includes a 120-second LOAD pause.\r\nHOST tested; hardware acceptance pending.\r\n')]);
writeFileSync(dir+'EXAMPLES.ZIP',makeZip(entries));writeFileSync(dir+'EXAMPLES.IMG',makeImg(entries));
console.log('Example-only ZIP/IMG written; CURRENT.* unchanged');

for(const [ext,decode] of [['ZIP',readZip],['IMG',readFat12]]){const actual=decode(readFileSync(dir+'EXAMPLES.'+ext));for(const [name,data]of entries)assert.deepEqual(actual.get(name),data,name+' '+ext);assert.equal(actual.size,entries.length);}
