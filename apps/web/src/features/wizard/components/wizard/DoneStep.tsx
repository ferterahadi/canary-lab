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
        <div className="mx-auto max-w-2xl space-y-4">
          <div
            className="flex items-start gap-3 p-4"
            style={{
              border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)',
              background: 'color-mix(in srgb, var(--success) 8%, transparent)',
              borderRadius: 8,
            }}
          >
            <span
              aria-hidden="true"
              className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
              style={{ background: 'var(--success)', color: '#ffffff', fontSize: 11 }}
            >
              ✓
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Feature created
              </div>
              <div className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                Spec files were written to{' '}
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-primary)',
                  }}
                >
                  features/{featureName}/
                </span>
              </div>
            </div>
          </div>

          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Run the new feature now to verify it loads, or close and pick it from the features
            sidebar.
          </p>
        </div>
      </div>

      <div className="cl-panel-footer flex items-center justify-end gap-2 px-6 py-3">
        <button
          type="button"
          onClick={onClose}
          className="cl-button px-3 py-1.5"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onRunNow}
          disabled={starting}
          className="cl-button-primary px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Run it now'}
        </button>
      </div>
    </div>
  )
}
