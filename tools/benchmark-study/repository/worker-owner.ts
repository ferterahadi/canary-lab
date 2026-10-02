import path from 'node:path'
import net from 'node:net'
import { readJson } from '../files'
import type { StudyManifest } from '../types'

export function watchRepositoryOwner(onDisconnect: () => void): net.Socket {
  // A socket closes immediately on release. A file ReadStream can leave a
  // blocking pipe read in flight and prevent a finished worker from exiting.
  const lease = new net.Socket({ fd: 3, readable: true, writable: false })
  lease.on('end', onDisconnect)
  lease.on('error', onDisconnect)
  lease.resume()
  return lease
}

export function assertRepositoryWorkerOwner(manifest: StudyManifest, id: string, leased: boolean, parentPid = process.ppid): void {
  const owner = readJson<{ pid: number }>(path.join(manifest.root, 'study.lock'))
  if (!leased || owner.pid !== parentPid || manifest.active?.attempt.id !== id) {
    throw new Error('Repository workers require the active scheduler and its owner lease')
  }
}
