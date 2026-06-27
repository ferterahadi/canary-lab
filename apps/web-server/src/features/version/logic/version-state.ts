import { fetchLatestVersion, isOutdated } from '../../../../../../shared/runtime/registry-version'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import type { UpdateJobManifest, UpdateJobStore } from './update-job'

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

export interface VersionStateOptions {
  packageName: string | null
  runningVersion: string | null
  fetchImpl?: typeof fetch
  workspaceEvents?: WorkspaceEventPublisher
}

export class VersionState {
  private latest: string | null = null
  private readonly packageName: string | null
  private readonly runningVersion: string | null
  private readonly fetchImpl?: typeof fetch
  private readonly workspaceEvents?: WorkspaceEventPublisher

  constructor(opts: VersionStateOptions) {
    this.packageName = opts.packageName
    this.runningVersion = opts.runningVersion
    this.fetchImpl = opts.fetchImpl
    this.workspaceEvents = opts.workspaceEvents
  }

  /** Fetch the registry `latest`; emit `version-changed` if it moved so live
   *  clients pick up a newly-published release without a refresh. Fail-silent. */
  async refresh(): Promise<void> {
    if (!this.packageName) return
    const next = await fetchLatestVersion(this.packageName, { fetchImpl: this.fetchImpl })
    if (next && next !== this.latest) {
      this.latest = next
      publishWorkspaceEvent(this.workspaceEvents, { type: 'version-changed' })
    }
  }

  status(updateStore: UpdateJobStore): VersionStatus {
    return {
      current: this.runningVersion,
      latest: this.latest,
      updateAvailable: isOutdated(this.runningVersion, this.latest),
      packageName: this.packageName,
      update: updateStore.current(),
    }
  }

  /** The version a fresh update job should target, or null if none is newer. */
  pendingTarget(): string | null {
    return isOutdated(this.runningVersion, this.latest) ? this.latest : null
  }
}
