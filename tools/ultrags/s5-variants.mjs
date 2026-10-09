// SPDX-License-Identifier: GPL-2.0-or-later
// Additional actual-EXE paths: older CAPS fallback and the benchmark's
// known-NMI branch. The NMI exclusion is a HOST fixture, never a real profile.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadZ80,parseExe,SprinterMachine,runImage} from '../../tests/ultrags/dss/ug-harness.mjs';
import {SlowCard} from '../../tests/ultrags/dss/slow-card.mjs';
import {verifyBuild,executionInputs} from './build-evidence.mjs';
const root=resolve(new URL('../..',import.meta.url).pathname),build=resolve(process.argv[2]||'build');
const hash=b=>createHash('sha256').update(b).digest('hex');
const assembly=verifyBuild(root,join(build,'ultrags/dss')),inputs=executionInputs(root);
const scriptHash=hash(readFileSync(new URL(import.meta.url)));
const catalog=readFileSync(join(build,'host/s2-catalog.bin')),Z80=loadZ80(root);
const results=[],executed=new Map();
function run(name,app,cli,card,opts={}) {
    const bytes=readFileSync(join(build,'ultrags/dss',app+'.EXE')),h=parseExe(bytes);
    executed.set(app,{name:app+'.EXE',size:bytes.length,sha256:hash(bytes)});
    const m=new SprinterMachine({card,cardSlot:opts.slot??0,cpuHz:opts.cpuHz??21000000,
        commandLine:cli,movingClock:true,clockStart:86399,logLimit:512,files:opts.files??{}});
    // Explicit HOST-only exclusion of NMI. Execute the unmodified release
    // EXE's conditional ALL path; explicit STACK still refuses in release.
    const listing=readFileSync(join(build,'ultrags/dss',app.toLowerCase()+'.lst'),'utf8');
    const labels={};
    for(const line of listing.split('\n')) {
        const match=line.match(/\+*([0-9A-F]{4})\s+(BENCH_COMMAND_COUNT|BENCH_CRC_COST):\s*$/);
        if(match)labels[match[2]]=parseInt(match[1],16);
    }
    let injected=false;
    m.beforeStep=st=>{
        if(opts.knownNmi)m.mem[0xbc2d]=1;
        if(opts.saturate&&!injected&&st.pc===labels.BENCH_COMMAND_COUNT&&m.mem[0x5810]) {
            m.mem.fill(255,0x5822,0x5826);injected=true;
        }
        if(opts.negativeCost&&st.pc===labels.BENCH_CRC_COST&&m.mem[0x580e]===1) {
            // Exercise signed subtraction at a clock-quantization boundary.
            const n=m.mem[0x580f]===0?0x5848:0x584c;
            m.mem[n]=1;m.mem.fill(0,n+1,n+4);
        }
    };
    const dss=m.dssCall.bind(m);
    m.dssCall=st=>{const fn=st.c,result=dss(st);if(result!=='exit'&&fn!==0x15){st.ix=0xdead;st.iy=0xbeef;}return result;};
    m.mem.set(bytes,h.loadAddr);
    const outcome=runImage(Z80,m,{entry:h.entry,stack:h.stack,iff:opts.iff??1,budget:100000000});
    const context=m.system===m.systemInit&&m.page3===m.page3Init&&outcome.end.sp===h.stack-2&&!!outcome.end.iff1===!!(opts.iff??1);
    const ok=outcome.exitCode===0&&context&&!m.violations.length&&!m.fileHandles.size&&!card.transfer&&m.text.includes('RESULT PASS code=0')&&opts.check(card,m);
    results.push({name,ok,text:m.text,steps:outcome.steps,maxWindowUs:m.maxWindowUs,context,
        profile:opts.knownNmi?'HOST-only known-NMI exclusion; CPU model':'release unknown profile; simulated older CAPS'});
    if(!ok)throw Error(JSON.stringify(results.at(-1)));
    console.log('PASS S5 variant '+name);return m;
}
for(const slot of [0,1])for(const cpuHz of [21000000,3500000])for(const iff of [0,1]) {
    const card=new SlowCard(catalog,{alias:0x280});
    run(`benchmark known-NMI ${slot}/${cpuHz}/${iff}`,'UGBENCH',`/BYTES:33 /LOOPS:1 /BLOCK:32 /METHOD:ALL /SLOT:${slot}`,card,
        {slot,cpuHz,iff,knownNmi:true,check:(c,m)=>!c.objects.size&&m.text.includes('STACK direction=WRITE check=NONE')&&m.text.includes('STACK direction=WRITE check=CRC')&&m.text.includes('STACK READ NOT_APPLICABLE')&&m.text.includes('crc_cost_seconds=')});
}
const card=new SlowCard(catalog),command=card.command.bind(card);
card.command=(op,...args)=>{const result=command(op,...args);if(op===1&&!result[0])result[1].writeUInt32LE(result[1].readUInt32LE()&~4);return result;};
const data=Buffer.from(Array.from({length:257},(_,i)=>(i^0xa5)&255));
const gsOnly=(c,m)=>m.text.includes('transport=GS_DATA')&&c.trace.filter(t=>[32,34].includes(t.op)).every(t=>(Buffer.from(t.q,'hex')[8]&1)===1);
run('UGLOAD older CAPS fallback','UGLOAD','TEST.BIN /TYPE:BLOB',card,{files:{'TEST.BIN':data},check:(c,m)=>gsOnly(c,m)&&c.objects.size===1&&[...c.objects.values()][0].data.equals(data)});
const handle=[...card.objects.keys()][0];
run('UGDUMP older CAPS fallback','UGDUMP',`${handle} BACK.BIN`,card,{check:(c,m)=>gsOnly(c,m)&&c.objects.size===1&&m.files.get('BACK.BIN').equals(data)});
run('ROUNDTRIP older CAPS preserves foreign object','UGMEM','ROUNDTRIP 33',card,{check:(c,m)=>gsOnly(c,m)&&c.objects.size===1&&c.objects.get(handle).data.equals(data)});
run('benchmark counter saturation','UGBENCH','/BYTES:33 /LOOPS:1 /BLOCK:32 /METHOD:FIXED /DIRECTION:WRITE /CHECK:NONE',new SlowCard(catalog),
    {saturate:true,check:(c,m)=>!c.objects.size&&m.text.includes('4294967295/')&&m.text.includes('measurement_overflow=SATURATED speed=UNAVAILABLE')});
run('benchmark signed CRC cost','UGBENCH','/BYTES:1 /LOOPS:1 /METHOD:FIXED /CHECK:BOTH',new SlowCard(catalog),
    {negativeCost:true,check:(c,m)=>!c.objects.size&&m.text.split('crc_cost_seconds=-1').length===3});
run('benchmark older CAPS SLOW','UGBENCH','/BYTES:33 /LOOPS:1 /METHOD:SLOW /CHECK:BOTH',card,
    {check:(c,m)=>c.objects.size===1&&m.text.includes('method=SLOW')&&m.text.includes('chunk=1')&&m.text.includes('crc_cost_seconds=')});
run('benchmark older CAPS ALL','UGBENCH','/BYTES:33 /LOOPS:1 /METHOD:ALL /CHECK:NONE',card,
    {check:(c,m)=>c.objects.size===1&&m.text.includes('BULK SKIP NOT_SUPPORTED')&&m.text.includes('method=SLOW')&&m.text.includes('chunk=1')&&!m.text.includes('method=FIXED')});
verifyBuild(root,join(build,'ultrags/dss'));
if(JSON.stringify(inputs)!==JSON.stringify(executionInputs(root))||scriptHash!==hash(readFileSync(new URL(import.meta.url))))throw Error('variant inputs changed');
writeFileSync(join(build,'ultrags/logs/s5-variants.json'),JSON.stringify({results,executed:[...executed.values()],inputs,buildInputs:assembly.inputs,scriptSha256:scriptHash},null,2)+'\n');
