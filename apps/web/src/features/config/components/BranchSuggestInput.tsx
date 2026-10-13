import { useState, type CSSProperties } from 'react'
import type { GitRepoStatus } from '@/shared/api/workspace'
import { blurOnEnter } from '@/shared/ui/keyboard'

// One home for the branch-picking UI: the Advanced setup Service tab
// (BranchControl) and the flight Suite setup panel render the SAME input +
// local/remote suggestion dropdown, differing only in commit semantics
// (draft-buffered SAVE there, write-on-commit in the flight panel) and skin.

/** Local + remote branches, deduped, in that order. */
export function branchSuggestions(status: GitRepoStatus | null): string[] {
  return [
    ...(status?.localBranches ?? []),
    ...(status?.remoteBranches ?? []),
  ].filter((branch, index, arr) => arr.indexOf(branch) === index)
}

/** The branch input with its suggestion dropdown. Opening (focus/click) shows
 *  the FULL branch list — the current value pinned first — and only text typed
 *  AFTER opening filters it; filtering on the stored value would hide every
 *  branch that doesn't happen to contain it. onChange fires per keystroke AND
 *  for a suggestion click; onSelect additionally marks the click (immediate
 *  commit for callers that save outside a draft); Enter blurs. */
export function BranchSuggestInput({
  value,
  branches,
  placeholder,
  inputClassName,
  inputStyle,
  testId,
  onChange,
  onSelect,
  onBlur,
}: {
  value: string
  branches: string[]
  placeholder?: string
  inputClassName: string
  inputStyle?: CSSProperties
  testId?: string
  onChange: (next: string) => void
  onSelect?: (branch: string) => void
  onBlur?: () => void
}) {
  const [open, setOpen] = useState(false)
  /** null = freshly opened, nothing typed yet → no filtering. */
  const [filter, setFilter] = useState<string | null>(null)
  const normalized = (filter ?? '').trim().toLowerCase()
  const matches = branches.filter((branch) => !normalized || branch.toLowerCase().includes(normalized))
  const visible = (filter === null && value && matches.includes(value)
    ? [value, ...matches.filter((branch) => branch !== value)]
    : matches
  ).slice(0, 80)

  return (
    <div className="relative min-w-0 flex-1">
      <input
        type="text"
        data-testid={testId}
        value={value}
        placeholder={placeholder}
        onFocus={() => { setFilter(null); setOpen(true) }}
        onClick={() => { setOpen(true) }}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 120)
          onBlur?.()
        }}
        onChange={(e) => {
          setOpen(true)
          setFilter(e.target.value)
          onChange(e.target.value)
        }}
        onKeyDown={blurOnEnter}
        spellCheck={false}
        className={inputClassName}
        style={inputStyle}
      />
      {open && visible.length > 0 && (
        <div
          className="cl-popover absolute left-0 right-0 top-[calc(100%+4px)] z-50 max-h-44 overflow-y-auto rounded-md py-1 text-xs scrollbar-thin"
          style={{
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {visible.map((branch) => (
            <button
              key={branch}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(branch)
                onSelect?.(branch)
                setOpen(false)
              }}
              className="block w-full truncate px-2.5 py-1.5 text-left"
              style={{
                color: branch === value ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: branch === value ? 'var(--bg-selected)' : 'transparent',
              }}
            >
              {branch}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
