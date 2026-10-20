// SPDX-License-Identifier: GPL-2.0-or-later
// Functional SDK adapter executing production C framing/storage/mixer/GS.
// Peripheral clocks, pads, PIO and DMA timing require the separate binary gates.
import {createRequire} from 'node:module';
import {ConfigCard} from './config-card.mjs';
export class NativeCard extends ConfigCard {
 constructor(catalog,options={}) {
  super(catalog,{mode:8,...options});
  if(!options.addon)throw Error('NativeCard requires the fresh native-card.node path');
  this.backend=createRequire(import.meta.url)(options.addon);this.backend.init();
  this.gs=options.gs??false;this.syncMap();this.session=this.backend.command(0,Buffer.alloc(0))[1].readBigUInt64LE(12);
  this.nativeReads=0;this.nativeWrites=0;this.fraction=0;
 }
 get transfer(){return this.backend?.transfer()?{}:null;}
 syncMap(){this.backend.map(this.base,this.alias,+this.gs);}
 owns(p){return p>=this.base&&p<this.base+32 || this.alias!==65535&&p>=this.alias&&p<this.alias+32 || this.gs&&(p===0xb3||p===0xbb);}
 tickUs(us){const session=this.session;super.tickUs(us);if(this.session!==session){this.backend.init();this.syncMap();}if(this.mode===8)this.backend.tick(us);}
 readPort(p){if(p>=0x1d0&&p<=0x1d2)return super.readPort(p);if(this.mode!==8||!this.owns(p))return 255;this.nativeReads++;return this.backend.read(p);}
 writePort(p,v){if(p>=0x1d0&&p<=0x1d2){this.o.busy=this.mode===8&&!this.backend.idle();super.writePort(p,v);this.syncMap();return;}if(this.mode===8&&this.owns(p)){this.nativeWrites++;this.backend.write(p,v);}}
 powerCycle(){super.powerCycle();this.backend.init();this.syncMap();}
 command(op,q=Buffer.alloc(0)){return this.backend.command(op,Buffer.from(q));}
}
