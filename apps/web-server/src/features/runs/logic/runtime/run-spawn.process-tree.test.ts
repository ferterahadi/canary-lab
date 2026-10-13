import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// Run real group signals in a child interpreter: the unit-test process blocks
// negative PIDs. Every signaled group below is created by this fixture itself.
const run = promisify(execFile)
const modules = {
  spawn: require.resolve('./run-spawn.ts'),
  agent: require.resolve('../../../agent-sessions/logic/agent-process.ts'),
}

describe('owned process-tree shutdown', () => {
  it.each(['agent', 'forced'] as const)('stops descendants through the %s adapter', async (mode) => {
    const code = `
      const {spawn}=require('node:child_process');
      const {once}=require('node:events');
      const {runAgentProcess}=require(${JSON.stringify(modules.agent)});
      const {killTree,scheduleSigkillFallback}=require(${JSON.stringify(modules.spawn)});
      const childCode=${JSON.stringify(mode === 'forced' ? "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)" : "process.send('ready');setInterval(()=>{},1000)")};
      const parentCode="const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"+JSON.stringify(childCode)+"],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>console.log(c.pid));setInterval(()=>{},1000)";
      const alive=(pid)=>{try{process.kill(pid,0);return true}catch{return false}};
      const until=async(fn)=>{const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw Error('condition timeout');await new Promise(r=>setTimeout(r,10))}};
      (async()=>{
        let target;
        try {
          let descendant;
          const mode=${JSON.stringify(mode)};
          if(mode==='agent') {
            const handle=runAgentProcess({command:process.execPath,args:['-e',parentCode],cwd:process.cwd(),onChunk:chunk=>{descendant=Number(chunk.trim())}});
            target=handle.child;
            await until(()=>Number.isInteger(descendant));
            handle.stop('SIGTERM');
            await handle.done;
          } else {
            target=spawn(process.execPath,['-e',parentCode],{detached:true,stdio:['ignore','pipe','ignore']});
            const [chunk]=await once(target.stdout,'data');descendant=Number(chunk.toString().trim());
            const exited=once(target,'exit');killTree(target,'SIGTERM');await exited;
            if(!alive(descendant))throw Error('forced fixture must survive graceful signal');
            scheduleSigkillFallback(target,10);
          }
          await until(()=>!alive(descendant));
          console.log(JSON.stringify({descendantStopped:true}));
        } finally {
          if(target?.pid>1){try{process.kill(-target.pid,'SIGKILL')}catch{ /* fixture already exited */ }}
        }
      })().catch(e=>{console.error(e);process.exitCode=1});
    `
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '-e', code], { timeout: 10_000 })
    expect(JSON.parse(stdout)).toEqual({ descendantStopped: true })
  })
})
