import { useEffect, useState } from 'react'
import * as api from '@/shared/api/client'
import { Modal } from '@/shared/ui/atoms'
import { DiffView } from '@/shared/ui/DiffView'
import { fileCountLabel } from '../utils/repair-files'

// The whole of one repo's captured repair, for the two moments the card can't
// answer on its own: a file list too long to print, and a repo that has moved
// out from under the run so there is nothing left to open.
//
// One patch holds every file the agent changed in that repo — teardown writes a
// single `git diff` per repo — so this dialog is per repo, not per file, and the
// footer's copy/open actions point at that one file. The diff renders through
// the app's shared `DiffView`; the patch text arrives from the read route that
// was built for exactly this and had no caller until now.

export function RepairPatchDialog({
  open,
  onClose,
  runId,
  repoName,
  files,
  fileNames,
}: {
  open: boolean
  onClose: () => void
  runId: string
  repoName: string
  /** True count from the capture — `fileNames` is capped, so this is what the
   *  header says and what tells the reader some paths aren't listed. */
  files: number
  fileNames: string[]
}) {
  const [patch, setPatch] = useState<api.RunFixPatch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) { setPatch(null); setError(null); setCopied(false); return }
    let live = true
    api.getRunFixPatch(runId, repoName)
      .then((r) => { if (live) setPatch(r) })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [open, runId, repoName])

  const unlisted = Math.max(0, files - fileNames.length)

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Captured repair"
      title={repoName}
      status="running"
      description={`${fileCountLabel(files)} in one patch.`}
      width={760}
      testId={`changes-patch-dialog-${repoName}`}
      footer={
        <>
          <span className="mr-auto text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {copied ? 'Path copied' : 'Every file in this repo is in this one patch'}
          </span>
          {patch && (
            <>
              <button
                type="button"
                data-testid={`changes-patch-copy-${repoName}`}
                onClick={() => { void navigator.clipboard?.writeText(patch.patchPath); setCopied(true) }}
                className="cl-button px-2.5 py-1 text-[11px]"
              >
                Copy path
              </button>
              {/* Best-effort: the launcher only opens files inside the project
                  root, so a workspace whose logs live elsewhere gets the copy
                  path instead of a working launch. Never the only route. */}
              <button
                type="button"
                data-testid={`changes-patch-open-${repoName}`}
                onClick={() => { void api.openEditor({ file: patch.patchPath }).catch(() => {}) }}
                className="cl-button px-2.5 py-1 text-[11px]"
              >
                Open patch file ↗
              </button>
            </>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        <section>
          <div className="cl-rubric mb-1.5">Files changed</div>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid={`changes-patch-files-${repoName}`}>
            {fileNames.map((f) => (
              <li
                key={f}
                className="min-w-0 truncate text-[11px]"
                style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}
                title={f}
              >
                {f}
              </li>
            ))}
            {unlisted > 0 && (
              <li className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                +{unlisted} more the run didn’t record by name — the patch has them all
              </li>
            )}
          </ul>
        </section>

        <section>
          <div className="cl-rubric mb-1.5">Patch</div>
          {error ? (
            <div className="text-[11px]" style={{ color: 'var(--danger)' }} data-testid={`changes-patch-error-${repoName}`}>
              {error}
            </div>
          ) : patch ? (
            <DiffView diff={patch.diff} />
          ) : (
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Reading the patch…</div>
          )}
        </section>
      </div>
    </Modal>
  )
}
