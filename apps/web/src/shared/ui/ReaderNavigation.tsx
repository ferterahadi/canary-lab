import type { ReactNode } from 'react'
import { StepsIcon } from './Icons'

export function ReaderNavigation({ title, children, onChoose, back, expanded, visual, fit, onExpand, onFit }: {
  title: string; children?: ReactNode; onChoose: (value: string) => void; back?: () => void
  expanded?: boolean; visual: boolean; fit?: boolean; onExpand: () => void; onFit?: () => void
}) {
  return <nav className="function-bar" aria-label="Function navigation">
    {back && <button type="button" className="caller-back" aria-label="Back to caller" onClick={back}>← <span>Back</span></button>}
    <div className="location-picker">
      <span className="location-caption" aria-hidden="true"><StepsIcon size={13} /><span>{title}</span><span>⌄</span></span>
      <select aria-label="Choose function" value="" onChange={e => onChoose(e.target.value)}>
        <option value="">{title}</option>{children}
      </select>
    </div>
    {!expanded ? <button type="button" className="location-action" onClick={onExpand}>↗ Expand</button>
      : visual && <button type="button" className="location-action" aria-pressed={!!fit} onClick={onFit}>{fit ? 'Reset zoom' : 'Fit to width'}</button>}
  </nav>
}
