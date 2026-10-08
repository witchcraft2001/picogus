// SPDX-License-Identifier: GPL-2.0-or-later
// Independent S2 hardware model: watchdog request, persisted Flash, async SAVE.
export function crc32(bytes) { let c=0xffffffff; for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);} return (c^0xffffffff)>>>0; }
export class ConfigCard {
 constructor(catalog,opts={}) {
  this.o=opts; this.catalog=Buffer.from(catalog); this.mode=opts.mode??1;this.desired=this.mode;
  this.base=opts.base??0x2a0;this.alias=opts.alias??0xffff;this.gs=false;
  this.flash={mode:this.mode,base:this.base,alias:this.alias}; this.boot=opts.boot??0;
  this.result=0; this.sel=0;this.low=0;this.index=0;this.now=0;this.saveAt=0;this.rebootAt=0;this.rebootStartAt=0;
  this.reboots=0;this.saves=0;this.mutations=[];this.request=[];this.response=[];this.portWrites=0;
 }
 tickUs(us) {
  this.now+=us;
  if(this.saveAt&&this.now>=this.saveAt&&!this.o.saveTimeout){this.flash={...this.snapshot};this.saveAt=0;this.result=this.o.saveFail?22:0;this.saves++;}
  if(this.rebootAt&&this.now>=this.rebootAt&&!this.o.timeout){this.rebootAt=0;this.mode=this.o.fallback?1:this.desired;this.boot=this.o.fallback?2:0;this.base=this.flash.base;this.alias=this.flash.alias;this.gs=false;this.request=[];this.response=[];this.low=0;if(this.o.protocolAfterReboot)this.o.protocol=this.o.protocolAfterReboot;if(this.o.catalogFailureAfterReboot){this.catalog[0]^=1;this.boot=5;this.mode=1;this.o.invalidRaw=true;}}
 }
 powerCycle(){this.mode=this.desired=this.flash.mode;this.base=this.flash.base;this.alias=this.flash.alias;this.gs=false;this.boot=0;this.request=[];this.response=[];this.saveAt=this.rebootAt=0;this.low=0;}
 offline(){return this.rebootAt && this.now>=this.rebootStartAt;}
 readPort(p) {
  if(this.offline())return 255;
  if(p===0x1d1)return this.sel===0x76?this.base&255:this.sel===0x77?this.alias&255:0;
  if(p===0x1d2){switch(this.sel){case 0:return 0xdd;case 1:return this.o.protocol??4;case 3:return this.desired;case 0x76:return this.base>>8;case 0x77:return this.alias>>8;case 0x78:return this.result;case 0x79:return +this.gs;case 0xe3:return this.o.legacy?255:this.snapshotCatalog[this.index++]??255;case 0xe4:return this.o.legacy?255:this.mode;case 0xe5:return this.o.legacy?255:this.boot;default:return 255;}}
  if(this.mode!==8)return 255;
  switch(p-this.base){case 1:return this.response.length?4:this.request.length?0:1;case 3:return this.response.shift()??255;case 8:return 1;case 9:return 0;default:return 0;}
 }
 writePort(p,v) {
  if(this.offline())return;
  if(p===0x1d0){if(v===0xcc)return;this.sel=v;this.low=0;if(v===0xe3){this.index=0;this.snapshotCatalog=Buffer.from(this.catalog);if(!this.o.invalidRaw){this.snapshotCatalog[17+(this.mode-1)*16]|=2;this.snapshotCatalog.writeUInt32LE(crc32(this.snapshotCatalog.subarray(0,144)),144);}}return;}
  if(p===0x1d1){this.low=v;return;}
  if(p===0x1d2){
   this.mutations.push([this.sel,v]); if(this.saveAt)return;
   this.result=0;
   if(this.sel===3){if(v<1||v>8)this.result=2;else if(!(this.catalog[17+(v-1)*16]&1))this.result=6;else this.desired=v;}
   else if(this.sel===0x76||this.sel===0x77){
    this.portWrites++; const n=this.low|(v<<8);let b=this.sel===0x76?n:this.base,a=this.sel===0x77?n:this.alias;
    if(this.o.busy)this.result=5;
    else if((this.o.rejectAt===this.portWrites)||(this.o.rollbackFail&&this.portWrites>=2))this.result=2;
    else if(b<0x200||b>0x3e0||(b&31)||(a!==65535&&(a<0x200||a>0x3e0||(a&31)||a===b)))this.result=2;
    else {this.base=b;this.alias=a;}
   } else if(this.sel===0x79){if(this.mode!==8)this.result=6;else if(v>1)this.result=2;else if(this.o.busy)this.result=5;else this.gs=!!v;}
   else if(this.sel===0xe1){if(this.o.busy){this.result=5;return;}this.snapshot={mode:this.desired,base:this.base,alias:this.alias};this.saveAt=this.now+20000;this.result=5;}
   else if(this.sel===0xe2){this.reboots++;if(!this.o.ignoredReboot){this.rebootStartAt=this.now+(this.o.rebootDelayUs??0);this.rebootAt=this.rebootStartAt+300000;}}
   return;
  }
  if(this.mode!==8)return;
  if(p-this.base===2 && v===0xa0){this.request=[];this.response=[];}
  if(p-this.base===3){this.request.push(v);if(this.request.length>=2&&this.request.length===2+this.request[1]+(this.request[0]&128?4:0)){
   const r=Buffer.alloc(42);r[1]=36;r.write('UGS1',2);r[6]=this.o.api??1;r[8]=8;r[9]=this.o.bootState??(this.o.notReady?2:0);r.write('0123456789abcde+',22);r.writeUInt32LE(crc32(r.subarray(0,38)),38);if(this.o.badInfoCrc)r[38]^=1;this.response=[...r];this.request=[];
  }}
 }
}
