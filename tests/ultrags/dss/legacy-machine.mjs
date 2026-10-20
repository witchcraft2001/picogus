// SPDX-License-Identifier: GPL-2.0-or-later
// The additional DSS/BIOS calls made by the unchanged PROPLAY.EXE.
// ABI reference: Estex-DSS GetVMod/GetMem/Read/Execute and BIOS C4.
import {SprinterMachine} from './ug-harness.mjs';
export class LegacyMachine extends SprinterMachine {
 constructor(options){super({...options,rejectTurboIsa:false});this.videoMode=3;this.memoryBlock=null;}
 biosCall(st){
  if(st.c!==0xc4||st.a!==this.memoryBlock||st.b!==0)throw Error('Unexpected legacy BIOS request');
  st.a=0xc0;st.flags={...st.flags,C:0};this.returnCall(st);
 }
 returnCall(st){const sp=st.sp;st.pc=this.mem[sp]|this.mem[sp+1]<<8;st.sp=(sp+2)&65535;}
 dssCall(st){
  const fn=st.c,wanted=st.d<<8|st.e;
  if([0x51,0x50,0x02,0x01,0x1e,0x1d,0x3d,0x3e].includes(fn)){
   if(this.isaOpen)throw Error('Legacy DSS request with ISA window mapped');
   this.dssCalls.push({fn,sp:st.sp});
   switch(fn){
    case 0x51:st.a=this.videoMode;st.b=1;break;
    case 0x50:this.videoMode=st.a;break;
    case 0x02:st.a=2;break;
    case 0x01:case 0x1d:break;
    case 0x1e:this.mem[st.h<<8|st.l]=92;this.mem[(st.h<<8|st.l)+1]=0;break;
    case 0x3d:if(st.b!==1||this.memoryBlock!==null)throw Error('Unsupported legacy memory allocation');this.memoryBlock=1;st.a=1;break;
    case 0x3e:this.memoryBlock=null;break;
   }
   st.flags={...st.flags,C:0};this.returnCall(st);return null;
  }
  const result=super.dssCall(st);
  // DSS READ returns A=FF on the final (possibly exactly full) read, A=0
  // otherwise; DE is the actual count. Never patch the guest to emulate it.
  if(fn===0x13 && !st.flags?.C){const n=st.d<<8|st.e;const f=[...this.fileHandles.values()][0];st.a=n<wanted||f&&f.pos>=this.files.get(f.path).length?255:0;}
  return result;
 }
}
