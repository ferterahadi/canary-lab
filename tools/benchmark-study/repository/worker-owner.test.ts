import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { command, sourceRoot } from '../files'
import { trackTempDirs } from '../../test-helpers/temp-dir'

const tempDir = trackTempDirs('repository-lease-')

const helper = path.join(__dirname, 'worker-owner.ts')
const loader = require.resolve('tsx')

it('lets a finished worker exit while its scheduler still owns the pipe', async () => {
  const script = `const {watchRepositoryOwner}=require(${JSON.stringify(helper)});const lease=watchRepositoryOwner(()=>{});setTimeout(()=>lease.destroy(),20)`
  const result = await command(process.execPath, ['--import', loader, '-e', script], { cwd: sourceRoot, parentLease: true, timeoutMs: 3000 })
  expect(result.timedOut).toBe(false)
  expect(result.code).toBe(0)
}, 10_000)

it('notifies an orphan worker when its exact scheduler is killed', async () => {
  const root = tempDir()
  const ready = path.join(root, 'worker.pid')
  const receipt = path.join(root, 'receipt')
  const worker = `const fs=require('node:fs');const {watchRepositoryOwner}=require(${JSON.stringify(helper)});watchRepositoryOwner(()=>fs.writeFileSync(${JSON.stringify(receipt)},'owner-disconnected'));fs.writeFileSync(${JSON.stringify(ready)},String(process.pid))`
  const parentCode = `const {command}=require(${JSON.stringify(path.join(sourceRoot, 'tools/benchmark-study/files.ts'))});command(process.execPath,['--import',${JSON.stringify(loader)},'-e',${JSON.stringify(worker)}],{cwd:${JSON.stringify(root)},parentLease:true,timeoutMs:20000})`
  const parent = spawn(process.execPath, ['--import', loader, '-e', parentCode], { stdio: 'ignore' })
  let workerPid: number | undefined
  try {
    await expect.poll(() => fs.existsSync(ready), { timeout: 5000 }).toBe(true)
    workerPid = Number(fs.readFileSync(ready, 'utf8'))
    parent.kill('SIGKILL')
    await expect.poll(() => fs.existsSync(receipt), { timeout: 5000 }).toBe(true)
    expect(fs.readFileSync(receipt, 'utf8')).toBe('owner-disconnected')
  } finally {
    parent.kill('SIGKILL')
    if (workerPid) { try { process.kill(workerPid, 'SIGKILL') } catch { /* Worker already exited. */ } }
  }
}, 15_000)
