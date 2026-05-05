interface Props {
  featureName: string
  onRunNow: () => void
  onClose: () => void
  starting: boolean
}

// Step 4: success state. The feature has been written into `features/<name>/`
// and the wizard offers a one-click "Run it now" that triggers POST /api/runs
// for the new feature and closes the wizard.
export function DoneStep({ featureName, onRunNow, onClose, starting }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4">
            <div className="text-sm font-medium text-emerald-700 dark:text-emerald-200">Feature created</div>
            <div className="mt-2 text-xs text-emerald-800/80 dark:text-emerald-100/80">
              Spec files were written to{' '}
              <span className="font-mono">features/{featureName}/</span>.
            </div>
          </div>

          <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            You can run the new feature now to verify it loads, or close and pick it from the
            features sidebar.
          </div>
        </div>
      </div>

      <div className="cl-panel-footer flex items-center justify-end gap-2 px-6 py-3">
        <button
          type="button"
          onClick={onClose}
          className="cl-button px-3 py-1.5 text-xs"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onRunNow}
          disabled={starting}
          className="cl-button-primary px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Run it now'}
        </button>
      </div>
    </div>
  )
}
