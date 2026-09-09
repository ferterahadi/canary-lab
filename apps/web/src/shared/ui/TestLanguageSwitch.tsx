export type TestLanguage = 'english' | 'code'

/** Test cards and source comparisons share one format control. */
export function TestLanguageSwitch({ mode, onChange }: { mode: TestLanguage; onChange: (mode: TestLanguage) => void }) {
  return <div className="cl-lang-switch" role="tablist" aria-label="Test description format" data-mode={mode}>
    <span className="cl-lang-switch-thumb" aria-hidden="true" />
    {(['english', 'code'] as const).map((value) => <button
      key={value} type="button" role="tab" aria-selected={mode === value}
      aria-label={value === 'english' ? 'English' : 'Code'} title={value === 'english' ? 'English' : 'Code'}
      data-active={mode === value ? 'true' : 'false'} data-testid={`test-presentation-${value}-tab`}
      className="cl-lang-switch-btn" onClick={() => onChange(value)}
    >{value === 'english' ? 'Aa' : '</>'}</button>)}
  </div>
}
