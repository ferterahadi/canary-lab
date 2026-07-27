import { PlusIcon, TextInput } from '@/shared/ui/atoms'

export function NewEnvControl({
  adding,
  busy,
  newEnvName,
  setNewEnvName,
  setAdding,
  onAddEnv,
}: {
  adding: boolean
  busy: boolean
  newEnvName: string
  setNewEnvName: (v: string) => void
  setAdding: (v: boolean) => void
  onAddEnv: () => void
}) {
  if (adding) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="w-44">
          <TextInput value={newEnvName} onChange={setNewEnvName} placeholder="e.g. production" />
        </div>
        <button
          type="button"
          onClick={onAddEnv}
          disabled={busy || !newEnvName.trim()}
          className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
          style={{ color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => { setAdding(false); setNewEnvName('') }}
          className="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          Cancel
        </button>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider"
      style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-default)' }}
    >
      <PlusIcon />
      Env
    </button>
  )
}
