import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { expect, it, vi } from 'vitest'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { deferred } from '../../../../../../tools/test-helpers/deferred'
import { withRunLifecycleLock } from './run-lifecycle-lock'
const tempDir = trackTempDirs('cl-lifecycle-lock-')

it('serializes same-suite writers, permits reentrant work, and releases after failure', async () => {
  const logs = tempDir()
  const gate = deferred<void>()
  const events: string[] = []
  const first = withRunLifecycleLock(logs, 'shop', async () => {
    await withRunLifecycleLock(logs, 'shop', async () => { events.push('nested') })
    await gate.promise
    throw new Error('failed')
  })
  const rejected = expect(first).rejects.toThrow('failed')
  const second = withRunLifecycleLock(logs, 'shop', async () => { events.push('next') })
  await vi.waitFor(() => expect(events).toEqual(['nested']))
  gate.resolve()
  await rejected
  await second
  expect(events).toEqual(['nested', 'next'])
})

it('refuses live process claims and recovers dead process claims without stealing another lease', async () => {
  const logs = tempDir()
  const key = path.join(logs, '.run-locks', createHash('sha256').update('shop').digest('hex'))
  const live = path.join(key, `${process.pid}-peer`)
  fs.mkdirSync(live, { recursive: true })
  const launch = vi.fn(async () => 'started')
  await expect(withRunLifecycleLock(logs, 'shop', launch)).rejects.toMatchObject({ statusCode: 409 })
  expect(launch).not.toHaveBeenCalled()
  expect(fs.existsSync(live)).toBe(true)
  fs.rmSync(live, { recursive: true })
  const dead = path.join(key, '2147483647-exited')
  fs.mkdirSync(dead)
  await expect(withRunLifecycleLock(logs, 'shop', launch)).resolves.toBe('started')
  expect(fs.readdirSync(key)).toEqual([])
})
