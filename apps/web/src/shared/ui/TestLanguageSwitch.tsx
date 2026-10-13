export type TestLanguage = 'english' | 'code'

/** Test cards and source comparisons share one format control. A view that
 * can show code only keeps the control in place, disabled, with the reason. */
export function TestLanguageSwitch({ mode, onChange, disabled }: { mode: TestLanguage; onChange: (mode: TestLanguage) => void; disabled?: { reason: string } }) {
  return <div className="cl-lang-switch" role="tablist" aria-label="Test description format" data-mode={mode}
    aria-disabled={disabled ? true : undefined} title={disabled?.reason}>
    <span className="cl-lang-switch-thumb" aria-hidden="true" />
    {(['english', 'code'] as const).map((value) => <button
      key={value} type="button" role="tab" aria-selected={mode === value}
      aria-label={value === 'english' ? 'English' : 'Code'} title={disabled ? undefined : value === 'english' ? 'English' : 'Code'}
      disabled={disabled !== undefined}
      data-active={mode === value ? 'true' : 'false'} data-testid={`test-presentation-${value}-tab`}
      className="cl-lang-switch-btn" onClick={() => onChange(value)}
    >{value === 'english' ? 'Aa' : '</>'}</button>)}
  </div>
}
