// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {readZip,readFat12} from './verify-package.mjs';
import {makeZip,makeImg} from './disk-formats.mjs';
const dir='build/host/docs/';
const entries=readdirSync(dir+'examples').filter(n=>/\.(EXE|WAV|MOD)$/.test(n)&&!n.startsWith('DISCOVER')).sort().map(n=>{
 if(n.length>12||n.split('.')[0].length>8)throw Error('not DOS 8.3: '+n);
 return [n,readFileSync(dir+'examples/'+n)];
});
entries.push(['LESSONS.TXT',Buffer.from('UltraGS guide examples. Configure ULTRAGS / BASE 02A0 first.\r\nStandalone lessons, suffix 0 = slot 0, suffix 1 = slot 1:\r\nDISCOV0  card probe\r\nPCM0     first sound: own 256-byte tone\r\nMODFX0   looped MOD plus an effect on top (uses GUIDE.MOD built in)\r\nFM0      one OPL2 note\r\nGSMOD0   the same MOD through General Sound commands\r\nS3M0 / GSS3M0  S3M by native API / by GS commands\r\nEntry units that reuse the complete diagnostic applications:\r\nGSFX GS\r\nPCM PCM /VERIFY\r\nSTREAM STREAM GUIDE.WAV /BUFFER:16 /PREFILL:8 /LOW:4\r\nAdd /SLOT:1 to these three for slot 1.\r\nDo not use /RESET. Storage lessons require an empty store.\r\nGSFX includes a 120-second LOAD pause.\r\nHOST tested; hardware acceptance pending.\r\n')]);
writeFileSync(dir+'EXAMPLES.ZIP',makeZip(entries));writeFileSync(dir+'EXAMPLES.IMG',makeImg(entries));
console.log('Example-only ZIP/IMG written; CURRENT.* unchanged');

for(const [ext,decode] of [['ZIP',readZip],['IMG',readFat12]]){const actual=decode(readFileSync(dir+'EXAMPLES.'+ext));for(const [name,data]of entries)assert.deepEqual(actual.get(name),data,name+' '+ext);assert.equal(actual.size,entries.length);}
