// SPDX-License-Identifier: GPL-2.0-or-later
// Independent SRAM wire model; firmware is separately exercised with SDK mocks.
import {readFileSync} from 'node:fs';
const {constants:c} = JSON.parse(readFileSync(new URL('../../../tools/ultrags/diag-schema.json', import.meta.url)));
export class DiagCard {
  constructor(opts={}) { this.opts=opts; this.base=c.UGD_BASE; this.active=false; this.sel=0; this.snapshot=[]; this.cursor=0; this.session=1; this.reset(); this.totalWritten=0; this.totalRead=0;this.profile=0;this.elapsedUs=0;this.cmdResult=0;this.spikeBusy=opts.spikeBusy??0;this.snapshotBusy=opts.spikeSnapshotBusy??0;this.snapshotValid=true; }
  reset() { this.session++; this.written=this.read=this.errors=this.blocks=this.length=this.pos=this.state=this.stored=0; this.wp=this.rp=7; this.data=new Uint8Array(1024); }
  tickUs(us) {if(this.profile)this.elapsedUs+=us;}
  latch() { const b=Buffer.alloc(c.UGD_BUS_SIZE); [this.session,this.written+(this.opts.badCounter?1:0),this.read,this.errors,this.blocks].forEach((v,i)=>b.writeUInt32LE(v>>>0,i*4)); b.writeUInt16LE(this.pos,20); b.writeUInt16LE(this.length,22); b[24]=this.state; b[25]=(this.opts.fuse||this.opts.fuseReported)?1:0; this.snapshot=b; this.cursor=0; }
  command(v) {
    if (this.opts.fuse) { this.errors++; return; }
    if (v===c.UGD_RESET) return this.reset();
    if (v===c.UGD_CANCEL) {this.state=this.pos=0; return;}
    if (v===c.UGD_END) { if (!this.state || this.pos!==this.length) this.errors++; else {if(this.state===1)this.stored=this.length;this.blocks++;} this.state=0;return; }
    if (this.state || this.length<1 || this.length>1024 || v<1 || v>3 || (v===2&&this.stored!==this.length)) {this.errors++;return;}
    if(v===c.UGD_WRITE)this.stored=0;this.state=v;this.pos=0;
  }
  writePort(p,v) {
    p&=1023;
    if(p===0x1d2&&this.sel===c.UGD_SEL_CMD&&this.active){
      if(v===3){this.profile=0;this.cmdResult=0;return;}
      if(v<1||v>2){this.cmdResult=c.UGD_CMD_BAD_ARGUMENT;return;}
      if(this.spikeBusy>0){this.spikeBusy--;this.cmdResult=c.UGD_CMD_BUSY;return;}
      this.cmdResult=0;this.profile=v;this.elapsedUs=0;return;
    }
    if(p===0x1d0) {if(v===0xcc){this.active=true;return;}if(this.active){this.sel=v;if(v===c.UGD_SEL_BUS)this.latch();
        if(v===c.UGD_SEL_STATUS){
          this.snapshotValid=this.snapshotBusy--<=0;
          const b=Buffer.alloc(c.UGD_SPIKE_SIZE);b[0]=85;b[1]=71;b[2]=c.UG_DIAG_VERSION;
          b[c.UGD_SPIKE_STATE]=this.opts.spikeFault?c.UGD_STATE_ERR:this.opts.spikeInit?c.UGD_STATE_INIT:this.elapsedUs>=64000000?c.UGD_STATE_DONE:c.UGD_STATE_RUN;
          b[4]=1;b[c.UGD_SPIKE_PROFILE]=this.opts.spikeWrongProfile?3:this.profile;b[6]=1;b[c.UGD_SPIKE_FLAGS]=this.opts.spikeNoAudit?0:this.opts.spikeFuse?5:1;
          b.writeUInt32LE(370000,8);b.writeUInt32LE(30833,12);b.writeUInt32LE(48000,16);
          b.writeUInt32LE(this.elapsedUs>>>0,c.UGD_SPIKE_ELAPSED_US);
          for(const [key,offset] of [['spikeUnderruns',c.UGD_SPIKE_UNDERRUNS],['spikeFetchErrors',c.UGD_SPIKE_FETCH_ERRORS],['spikeBgErrors',c.UGD_SPIKE_BG_ERRORS],['spikeResFaults',c.UGD_SPIKE_RES_FAULTS]])if(this.opts[key])b.writeUInt32LE(1,offset);
          this.snapshot=b;this.cursor=0;}}return;}
    if(p===this.base) {
      this.totalWritten++;
      if(this.opts.drop && this.totalWritten===50)return;
      if(this.state!==1||this.pos>=this.length){this.errors++;this.state=0;return;}
      this.data[this.pos++]=v;
      if(v!==this.wp)this.errors++;
      this.wp=(this.wp+13)&255;this.written++;
      if(this.opts.duplicate&&this.totalWritten===50){this.pos++;this.written++;}
    } else if(p===this.base+1)this.command(v);
    else if(p===this.base+2){if(this.state)this.errors++;else this.length=(this.length&0xff00)|v;}
    else if(p===this.base+3){if(this.state)this.errors++;else this.length=(this.length&255)|(v<<8);}
    else if(p===this.base+4)this.latch();
  }
  readPort(p) {
    const mirror=!!(p&1024);p&=1023;
    if(p===0x1d0)return this.sel;
    if(p===0x1d1)return this.sel===c.UGD_SEL_BASE?this.base&255:this.sel===c.UGD_SEL_CMD?this.cmdResult:this.sel===c.UGD_SEL_STATUS&&!this.snapshotValid?c.UGD_CMD_BUSY:0;
    if(p===0x1d2) {
      if(!this.active)return 255;
      if(this.sel===0)return 0xdd;
      if(this.sel===1)return this.opts.protocol??4;
      if(this.sel===3)return this.opts.mode??0;
      if(this.sel===c.UGD_SEL_VERSION)return this.opts.version??c.UG_DIAG_VERSION;
      if(this.sel===c.UGD_SEL_BASE)return this.base>>8;
      if(this.sel===c.UGD_SEL_BUS||this.sel===c.UGD_SEL_STATUS)return this.cursor<this.snapshot.length?this.snapshot[this.cursor++]:255;
      return 255;
    }
    if(p===this.base) {
      this.totalRead++;
      if((this.state!==2&&this.state!==3)||this.pos>=this.length){this.errors++;this.state=0;return 255;}
      let v=this.state===2?this.data[this.pos]:this.rp;
      this.pos++;this.rp=(this.rp+13)&255;this.read++;
      if((this.opts.corrupt && this.totalRead===50)||(mirror&&this.opts.mirrorCorrupt))v^=1;
      return v;
    }
    if(p===this.base+1)return this.opts.timeout?1:this.errors?0x80:this.state;
    if(p===this.base+4)return this.cursor<this.snapshot.length?this.snapshot[this.cursor++]:255;
    return 255;
  }
}
