import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { PickerState, TokenPicker } from './TokenPicker'
import { caretAnchor, insertNodeAtSelection, makePillNode, renderValueIntoDom, serializeDom, stripTrailingDollarBrace, textBeforeCaret } from './templated-dom'

export type TokenNamespace = 'envset' | 'port'

export function TemplatedInput({
  value,
  onChange,
  feature,
  placeholder,
  disabled,
  namespaces = ['envset', 'port'],
  style,
}: {
  value: string
  onChange: (v: string) => void
  feature: string
  placeholder?: string
  disabled?: boolean
  /** Which token namespaces the picker offers (see file header). */
  namespaces?: TokenNamespace[]
  /** Extra styles merged over the defaults (e.g. paddingRight for an overlay button). */
  style?: CSSProperties
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  // True when we just emitted an onChange from typing — skip the next prop sync
  // so the cursor doesn't jump.
  const skipSync = useRef(false)

  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (skipSync.current) {
      skipSync.current = false
      return
    }
    const current = serializeDom(el)
    if (current !== value) renderValueIntoDom(el, value)
  }, [value])

  const handleInput = useCallback((): void => {
    const el = editorRef.current
    if (!el) return
    skipSync.current = true
    const next = serializeDom(el)
    onChange(next)

    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const before = textBeforeCaret(el, range)
    if (before.endsWith('${')) {
      const cleanedRange = stripTrailingDollarBrace()
      const cleaned = serializeDom(el)
      if (cleaned !== next) onChange(cleaned)
      setPicker({
        caret: caretAnchor(cleanedRange, el),
        replacingPill: null,
      })
    }
  }, [onChange])

  const handleClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement
    const pill = target.closest('[data-pill]') as HTMLElement | null
    if (!pill) return
    if (target.closest('[data-detach]')) {
      e.preventDefault()
      const slot = pill.getAttribute('data-slot') ?? ''
      const key = pill.getAttribute('data-key') ?? ''
      pill.replaceWith(document.createTextNode(`\${${slot}.${key}}`))
      skipSync.current = true
      onChange(serializeDom(editorRef.current!))
      return
    }
    e.preventDefault()
    const rect = pill.getBoundingClientRect()
    setPicker({
      caret: { top: rect.bottom + 4, left: Math.max(rect.left, 8) },
      replacingPill: pill,
      initialSlot: pill.getAttribute('data-slot') ?? undefined,
      initialKey: pill.getAttribute('data-key') ?? undefined,
    })
  }

  const handlePick = (slot: string, key: string): void => {
    const el = editorRef.current
    if (!el) return
    const pillNode = makePillNode(slot, key)
    if (picker?.replacingPill) {
      picker.replacingPill.replaceWith(pillNode)
    } else {
      insertNodeAtSelection(el, pillNode)
    }
    skipSync.current = true
    onChange(serializeDom(el))
    setPicker(null)
  }

  return (
    <>
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={handleInput}
        onClick={handleClick}
        data-placeholder={placeholder ?? ''}
        className="templated-input w-full rounded-md px-2.5 py-1.5 text-xs outline-none focus:ring-1"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)',
          minHeight: '1.75rem',
          opacity: disabled ? 0.55 : 1,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          ...style,
        }}
      />
      <style>{`
        .templated-input:empty::before {
          content: attr(data-placeholder);
          color: var(--text-muted);
          opacity: 0.6;
          pointer-events: none;
        }
        .templated-input [data-pill] {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 1px 4px 1px 6px;
          margin: 0 1px;
          border-radius: 4px;
          background: var(--bg-base);
          border: 1px dashed var(--border-default);
          color: var(--text-primary);
          font-size: 11px;
          line-height: 1.3;
          cursor: pointer;
          user-select: none;
        }
        .templated-input [data-pill]:hover {
          border-style: solid;
        }
        .templated-input [data-detach] {
          all: unset;
          cursor: pointer;
          color: var(--text-muted);
          font-size: 11px;
          padding: 0 2px;
        }
        .templated-input [data-detach]:hover {
          color: var(--danger);
        }
      `}</style>
      {picker && (
        <TokenPicker
          feature={feature}
          state={picker}
          namespaces={namespaces}
          onClose={() => setPicker(null)}
          onPick={handlePick}
        />
      )}
    </>
  )
}
