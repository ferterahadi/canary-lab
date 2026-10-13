import type { CSSProperties, ReactNode } from 'react'

/** Small sans caps heading for a block inside a benchmark or portify screen —
 *  heavier and wider-set than the mono `.cl-rubric` kicker. Spacing comes from
 *  the caller through `style`; render it as a `span` inside phrasing content
 *  such as a button. */
export function CapsLabel({ as: Tag = 'div', children, style }: {
  as?: 'div' | 'span'
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <Tag style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', fontWeight: 600, ...style }}>
      {children}
    </Tag>
  )
}
