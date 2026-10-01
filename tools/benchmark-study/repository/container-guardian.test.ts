import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { json } from '../files'
import { ContainerGuardian } from './container-guardian'
import { recoveryLabel, type ContainerRecoveryPlan } from './container-recovery'

function fixture(): ContainerRecoveryPlan {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'container-guardian-'))
  const plan: ContainerRecoveryPlan = { privateDir, executable: path.join(privateDir, 'docker.cjs'),
    env: { TEST_ROOT: privateDir }, owner: 'synthetic-owner', volume: 'synthetic-volume', containers: ['synthetic-build'] }
  json(path.join(privateDir, 'container-state.json'), { volumeRemoved: false, containers: [{ stopped: false, removed: false }] })
  json(path.join(privateDir, 'resources.json'), {})
  // A real child CLI deliberately delays daemon-side creation until the test
  // releases it, so the evaluator's death occurs before any resource exists.
  fs.writeFileSync(plan.executable, `#!${process.execPath}
const fs=require('fs'),path=require('path');const root=process.env.TEST_ROOT;const args=process.argv.slice(2);
const file=path.join(root,'resources.json');const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));const save=value=>fs.writeFileSync(file,JSON.stringify(value));
async function main(){
if(args[0]==='create'){
fs.writeFileSync(path.join(root,'pending'),'1');
while(!fs.existsSync(path.join(root,'release')))await new Promise(resolve=>setTimeout(resolve,20));
save({'synthetic-build':{Id:'synthetic-build',Config:{Labels:{'${recoveryLabel}':'synthetic-owner'}},State:{Running:true,Pid:123}},'synthetic-volume':{Labels:{'${recoveryLabel}':'synthetic-owner'}}});return;
}
if(fs.existsSync(path.join(root,'unavailable'))){const count=path.join(root,'unavailable-count');fs.writeFileSync(count,String(Number(fs.existsSync(count)?fs.readFileSync(count,'utf8'):0)+1));process.stderr.write('daemon unavailable');process.exitCode=1;return;}
const resources=read();const name=args[1]==='inspect'||args[0]==='volume'?args[2]:args[1];
if(args[1]==='inspect'){if(!resources[name]){process.stderr.write('No such '+args[0]+': '+name);process.exitCode=1;return;}process.stdout.write(JSON.stringify([resources[name]]));return;}
if(args[0]==='kill')resources[name].State={Running:false,Pid:0};else if(args[0]==='rm'||args[1]==='rm')delete resources[name];else throw Error('Unexpected '+args);
save(resources);
}
main().catch(error=>{process.stderr.write(String(error));process.exitCode=1});
`, { mode: 0o755 })
  return plan
}

it('drains creation after evaluator death before removing late-created resources', async () => {
  const plan = fixture()
  const log = fs.openSync(path.join(plan.privateDir, 'evaluator.log'), 'a')
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'),
    path.join(__dirname, '__fixtures__/guardian-evaluator.ts'), JSON.stringify(plan)], { stdio: ['ignore', 'ignore', log] })
  fs.closeSync(log)
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    await expect.poll(() => fs.existsSync(path.join(plan.privateDir, 'pending')), { timeout: 10_000 }).toBe(true)
    child.kill('SIGKILL')
    await exited
    expect(JSON.parse(fs.readFileSync(path.join(plan.privateDir, 'resources.json'), 'utf8'))).toEqual({})
    expect(JSON.parse(fs.readFileSync(path.join(plan.privateDir, 'container-recovery.json'), 'utf8')).status).toBe('armed')
    fs.writeFileSync(path.join(plan.privateDir, 'release'), '1')
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(plan.privateDir, 'container-recovery.json'), 'utf8')).status,
      { timeout: 10_000 }).toBe('cleaned')
    expect(JSON.parse(fs.readFileSync(path.join(plan.privateDir, 'resources.json'), 'utf8'))).toEqual({})
    expect(JSON.parse(fs.readFileSync(path.join(plan.privateDir, 'container-recovery.json'), 'utf8')).reason).toBe('evaluator-disconnected')
  } finally {
    child.kill('SIGKILL')
    fs.writeFileSync(path.join(plan.privateDir, 'release'), '1')
  }
}, 20_000)

it('keeps failed cleanup visible and retries automatically when Docker returns', async () => {
  const plan = fixture()
  fs.writeFileSync(path.join(plan.privateDir, 'unavailable'), '1')
  const guardian = new ContainerGuardian(plan)
  try {
    const receipt = await guardian.finish()
    expect(receipt.status).toBe('failed')
    expect(receipt.errors[0]).toContain('daemon unavailable')
    await expect.poll(() => Number(fs.readFileSync(path.join(plan.privateDir, 'unavailable-count'), 'utf8')),
      { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    fs.rmSync(path.join(plan.privateDir, 'unavailable'))
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(plan.privateDir, 'container-recovery.json'), 'utf8')).status,
      { timeout: 15_000 }).toBe('cleaned')
  } finally {
    fs.rmSync(path.join(plan.privateDir, 'unavailable'), { force: true })
  }
}, 20_000)
