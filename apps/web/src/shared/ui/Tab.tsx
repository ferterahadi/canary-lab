import type { ButtonHTMLAttributes, ReactNode } from 'react'

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
  return (
    <button
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
