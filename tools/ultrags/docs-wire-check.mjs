// SPDX-License-Identifier: GPL-2.0-or-later
// Compare guide/schema against the executing production dispatcher, not a mock.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {NativeCard} from '../../tests/ultrags/dss/native-card.mjs';
const schema=JSON.parse(readFileSync('tools/ultrags/wire-schema.json'));
const c=new NativeCard(readFileSync('build/host/s2-catalog.bin'),{adlib:true,addon:process.cwd()+'/build/native/native-card.node'});
const results=[];
const sizes={u8:1,u16:2,u32:4,u64:8};
function length(f){return sizes[f.type]??(f.type.startsWith('struct:')?schema.structs[f.type.slice(7)].size:Number(f.type.split(':')[1]));}
for(const op of schema.opcodes){
 const code=Number(op.hex);
 if(op.name.startsWith('QUEUE_')){assert.equal(c.command(code)[0],1);results.push([op.name,'BAD_OPCODE']);continue;}
 const n=op.reqStruct?schema.structs[op.reqStruct].size:(op.req??[]).reduce((s,f)=>s+length(f),0);
 const [e]=c.command(code,Buffer.alloc(n+1));
 assert.equal(e,op.name==='INFO'?1:3,op.name+' malformed payload');results.push([op.name,'length '+n+' + 1 rejected as '+e]);
}
for(const name of ['INFO','CAPS','MEM_INFO','STATS','LEGACY_INFO','SNAPSHOT']){
 const op=schema.opcodes.find(o=>o.name===name),[e,r]=c.command(Number(op.hex));assert.equal(e,0);assert.equal(r.length,schema.structs[op.respStruct].size,name);
 let offset=0;
 for(const f of schema.structs[op.respStruct].fields){
  if(f.name==='playlist_entries'){assert.equal(r.readUInt16LE(offset),0);}
  else if(f.const!==undefined){
   if(f.type.startsWith('bytes:'))assert.equal(r.subarray(offset,offset+length(f)).toString(),f.const);
   else assert.equal(r.readUIntLE(offset,length(f)),Number(f.const),name+'.'+f.name);
  }
  offset+=length(f);
 }
 assert.equal(offset,r.length);results.push([name,'response layout/constants']);
 if(name==='CAPS'){assert.equal(r.readUInt32LE(0)&16,0);assert.equal(r.readUInt32LE(4),511);assert.equal(r.readUInt16LE(20),32);}
}
writeFileSync('build/host/docs/wire-check.json',JSON.stringify({scope:'production C dispatcher',knownSchemaDifference:'CAPS.playlist_entries=0, schema const32',results},null,2)+'\n');
console.log('Guide wire check PASS',results.length);
