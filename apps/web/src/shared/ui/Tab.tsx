import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

/** One tab in a tab row — the `.cl-tab` face every tab strip shares (run detail,
 *  service sub-tabs, Playwright's Terminal/Playback switch, the suite config
 *  editor, the notification filter, the Tests source toggle). `className` adds
 *  layout utilities beside the face; any other button prop (aria, title, the
 *  handlers a `Tooltip` clones on) passes through to the `<button>`. */
export function Tab({
  active,
  disabled,
  className,
  style,
  children,
  ...button
}: {
  active: boolean
  disabled?: boolean
  className?: string
  children: ReactNode
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'>) {
  const classes = ['cl-tab', className, active ? 'cl-tab-active' : null].filter(Boolean).join(' ')
  const ref = useRef<HTMLButtonElement>(null)
  // A row that scrolls sideways hides its scrollbar, so an active tab past its
  // edge — the last run tab in a narrow panel — would sit cut off with no sign
  // there is more. Only the row scrolls, never the page around it, which is why
  // this is not `scrollIntoView`.
  useEffect(() => {
    if (!active) return
    const tab = ref.current!
    const row = tab.parentElement!
    if (row.scrollWidth <= row.clientWidth) return
    const t = tab.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    if (t.left < r.left) row.scrollLeft -= r.left - t.left
    else if (t.right > r.right) row.scrollLeft += t.right - r.right
  }, [active])
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={classes}
      style={{ cursor: disabled ? 'not-allowed' : 'pointer', ...(disabled ? { opacity: 0.45 } : {}), ...style }}
      {...button}
    >
      {children}
    </button>
  )
}
