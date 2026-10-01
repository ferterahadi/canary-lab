import fs from 'node:fs'
import path from 'node:path'
import { CandidateContainers } from '../container'

async function main(): Promise<void> {
  const [output, cache, phase] = process.argv.slice(2)
  const containers = new CandidateContainers(output, cache)
  await containers.verifyRuntime()
  await containers.createVolume()
  if (phase !== 'volume') {
    const id = await containers.create(phase === 'host' ? 'host' : 'build')
    const worker = `setInterval(()=>require('fs').writeFileSync('/tmp/heartbeat',String(Date.now())),50)`
    const launcher = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:'ignore'});child.unref();process.stdout.write(String(child.pid))`
    const pid = await containers.exec(id, ['node', '-e', launcher])
    await containers.exec(id, ['sh', '-c', `kill -0 ${pid}`])
    fs.writeFileSync(path.join(output, 'worker.json'), JSON.stringify({ id, pid }))
    if (phase === 'busy') {
      const busy = containers.exec(id, ['node', '-e',
        `require('fs').writeFileSync('/tmp/busy','1');setTimeout(()=>{},1500)`])
      fs.writeFileSync(path.join(output, 'ready'), 'busy')
      await busy
    }
  }
  fs.writeFileSync(path.join(output, 'ready'), phase)
  setInterval(() => {}, 1000)
}

main().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1 })
