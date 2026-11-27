import type { SingleTestViewMode, TestViewMode } from '@shared/test-view/render-model'

export type TestLanguage = TestViewMode

/** Test cards and source comparisons share one format control. A view that
 * can show code only keeps the control in place, disabled, with the reason. */
export function TestLanguageSwitch({ mode, onChange, disabled, onVisual, reader }: { mode: SingleTestViewMode; reader?: 'compact'|'expanded'; onVisual?: () => void; onChange: (mode: TestLanguage) => void; disabled?: { reason: string } }) {
  const visualButton = onVisual && <button type="button" role="tab" aria-selected={mode === 'visual'} className="cl-lang-switch-btn"
      disabled={!!disabled} data-active={mode === 'visual'} onClick={onVisual} aria-label="Visual" title="Visual">
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" className="mx-auto"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>{reader==='expanded' && <span> Visual</span>}
    </button>
  return <div className="cl-lang-switch" role="tablist" aria-label="Test description format" data-mode={mode} data-visual={Boolean(onVisual && !reader)} data-reader={reader}
    aria-disabled={disabled ? true : undefined} title={disabled?.reason}>
    <span className="cl-lang-switch-thumb" aria-hidden="true" />
    {reader && visualButton}
    {((reader ? ['code'] : ['english', 'code']) as TestLanguage[]).map((value) => <button
      key={value} type="button" role="tab" aria-selected={mode === value}
      aria-label={value === 'english' ? 'English' : 'Code'} title={disabled ? undefined : value === 'english' ? 'English' : 'Code'}
      disabled={disabled !== undefined}
      data-active={mode === value ? 'true' : 'false'} data-testid={`test-presentation-${value}-tab`}
      className="cl-lang-switch-btn" onClick={() => onChange(value)}
    >{value === 'english' ? 'Aa' : '</>'}{reader==='expanded' && <span> Code</span>}</button>)}
    {!reader && visualButton}
  </div>
}
