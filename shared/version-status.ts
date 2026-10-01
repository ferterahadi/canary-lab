// The running version and the self-update job, as /api/version returns them.
export type UpdateJobStatus = 'running' | 'done' | 'failed' | 'aborted'

export interface UpdateJobManifest {
  jobId: string
  status: UpdateJobStatus
  /** The version we're installing toward (the registry `latest` at start). */
  targetVersion: string
  startedAt: string
  endedAt?: string
  log: string
  error?: string
}

// Holds the version picture for the running server:
//  - `runningVersion`: snapshot read ONCE at boot. This is the version the
//    process is actually executing — NOT a fresh disk read. After a self-update
//    `npm install` rewrites package.json on disk, but the running code is still
//    the old version until the user restarts, so the snapshot is what we compare
//    against (otherwise `updateAvailable` would flip to false the instant the
//    install finished, hiding the "restart to apply" signal).
//  - `latest`: the registry's published `latest`, refreshed on boot + interval.

export interface VersionStatus {
  /** The version the running process was started with. */
  current: string | null
  /** Latest published on the registry, or null if the check hasn't resolved. */
  latest: string | null
  updateAvailable: boolean
  packageName: string | null
  /** The most recent self-update job, if any. */
  update: UpdateJobManifest | null
}
