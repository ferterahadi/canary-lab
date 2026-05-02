import { TextInput, IconButton, PlusIcon, TrashIcon } from './atoms'

interface Props {
  values: string[]
  onChange: (next: string[]) => void
  itemPlaceholder?: string
  addLabel?: string
}

export function StringListEditor({ values, onChange, itemPlaceholder, addLabel = 'Add' }: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      {values.length === 0 && (
        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          (none)
        </div>
      )}
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <div className="flex-1">
            <TextInput
              value={v}
              onChange={(next) => {
                const copy = [...values]
                copy[i] = next
                onChange(copy)
              }}
              placeholder={itemPlaceholder}
            />
          </div>
          <IconButton
            ariaLabel={`Remove ${v || 'item'}`}
            variant="danger"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
          >
            <TrashIcon />
          </IconButton>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ''])}
        className="self-start inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider transition-colors duration-150"
        style={{
          color: 'var(--text-muted)',
          border: '1px dashed var(--border-default)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)' }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)' }}
      >
        <PlusIcon />
        {addLabel}
      </button>
    </div>
  )
}
