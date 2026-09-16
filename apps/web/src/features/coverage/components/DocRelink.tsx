import { useCallback, useState } from 'react'
import { linkFeatureDocPath } from '@/shared/api/client'

/** Both document surfaces preserve the source name and refresh through their
 * existing loader; the server also broadcasts coverage-changed to other views. */
export function useDocRelink(feature: string, onChanged: () => void) {
  return useCallback(async (relPath: string, targetPath: string) => {
    await linkFeatureDocPath(feature, targetPath, { relPath, relink: true })
    onChanged()
  }, [feature, onChanged])
}

export function DocRelink({ relPath, linkTarget, busy, onRelink }: {
  relPath: string
  linkTarget?: string
  busy: boolean
  onRelink: (targetPath: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [targetPath, setTargetPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = busy || saving

  return (
    <div className="mt-1 flex flex-col gap-2 cl-type-meta">
      <div className="text-warning">Source unavailable. Where is the file now?</div>
      {linkTarget && <div className="break-all font-mono text-muted">Previous path: {linkTarget}</div>}
      {editing ? (
        <form className="flex flex-col gap-2" onSubmit={async (event) => {
          event.preventDefault()
          if (locked || !targetPath.trim()) return
          setSaving(true)
          setError(null)
          try {
            await onRelink(targetPath.trim())
            setEditing(false)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setSaving(false)
          }
        }}>
          <input
            className="cl-input w-full px-2 py-1 font-mono"
            aria-label={`New path for ${relPath}`}
            placeholder="Absolute path or ~/Documents/…"
            value={targetPath}
            disabled={locked}
            onChange={(event) => setTargetPath(event.target.value)}
          />
          <div className="text-muted">Use the moved source document. Changed contents will be checked for requirements drift.</div>
          {error && <div role="alert" className="text-danger">{error}</div>}
          <div className="flex gap-2">
            <button type="submit" className="cl-button-primary px-2 py-1" disabled={locked || !targetPath.trim()}>
              {saving ? 'Relinking…' : 'Save new path'}
            </button>
            <button type="button" className="cl-button px-2 py-1" disabled={locked} onClick={() => { setEditing(false); setError(null) }}>Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" className="cl-button self-start px-2 py-1" disabled={locked} aria-label={`Relink ${relPath}`} onClick={() => setEditing(true)}>Relink</button>
      )}
    </div>
  )
}
