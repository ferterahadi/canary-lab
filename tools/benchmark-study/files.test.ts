import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { command } from './files'
import { trackTempDirs } from '../test-helpers/temp-dir'

const makeTemp = trackTempDirs('command-deadline-')

it('settles at the deadline even when an exited child leaves an inherited output pipe open', async () => {
  const root = makeTemp()
  const pidFile = path.join(root, 'descendant.pid')
  const descendant = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
  const launcher = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore',process.stdout,process.stderr]});c.unref();process.stdout.write('parent finished');`
  try {
    const started = Date.now()
    const result = await command(process.execPath, ['-e', launcher], { cwd: os.tmpdir(), timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.stdout).toContain('parent finished')
    expect(Date.now() - started).toBeLessThan(5_000)
  } finally {
    // This fixture deliberately escapes the process group to hold its pipe;
    // the command deadline bounds the wait, rather than claiming containment.
    if (fs.existsSync(pidFile)) process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL')
  }
}, 7_000)
