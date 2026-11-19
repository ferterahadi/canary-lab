import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'
import { isProcessAlive } from '../../../../../../shared/runtime/active-servers'

const pending = new Map<string, Promise<unknown>>()
const held = new AsyncLocalStorage<ReadonlySet<string>>()

/** Review, start and continuation share a suite lock, including across servers.
 * A live peer is refused rather than having its lease stolen after a timeout. */
export async function withRunLifecycleLock<T>(logsDir: string, feature: string, apply: () => Promise<T>): Promise<T> {
  const key = path.join(path.resolve(logsDir), '.run-locks', createHash('sha256').update(feature).digest('hex'))
  if (held.getStore()?.has(key)) return apply()
  const work = Promise.resolve(pending.get(key)).catch(() => { /* A failed request does not block its successor. */ }).then(async () => {
    // The PID is part of the atomic directory claim, so a crash between
    // mkdir and a separate PID write cannot strand an ownerless lock. Unique
    // claims also prevent stale cleanup from deleting a new owner's lease.
    fs.mkdirSync(key, { recursive: true })
    const claim = `${process.pid}-${randomUUID()}`
    const claimPath = path.join(key, claim)
    fs.mkdirSync(claimPath)
    const keys = new Set([...(held.getStore() ?? []), key])
    try {
      for (const peer of fs.readdirSync(key)) {
        if (peer === claim) continue
        const pid = Number(peer.split('-')[0])
        if (!pid || isProcessAlive(pid)) throw Object.assign(new Error('Another run action is in progress. Retry after it settles.'), { statusCode: 409 })
        fs.rmSync(path.join(key, peer), { recursive: true, force: true })
      }
      return await held.run(keys, apply)
    } finally { keys.delete(key); fs.rmSync(claimPath, { recursive: true, force: true }) }
  })
  pending.set(key, work)
  try { return await work } finally { if (pending.get(key) === work) pending.delete(key) }
}
