import { useMemo } from 'react'
import { Decoration, EditorView, lineNumbers } from '@codemirror/view'
import type { CodeLanguage } from './code-highlighter'
import { TestLanguageSwitch } from './TestLanguageSwitch'
import { TestReaderEditor } from './TestReaderEditor'

/** Captured source, with the line numbers and failure evidence the producer
 * actually kept. Plain-text payloads share the editor without a grammar. */
export function SourceExcerptEditor({ source, numbers, failedLine, lang, label, visualUnavailable }: {
  source: string; numbers?: readonly number[]; failedLine?: number; lang?: CodeLanguage | null; label: string
  visualUnavailable?: string
}) {
  const extensions = useMemo(() => {
    let offset = 0
    const marks = source.split('\n').map((text, i) => {
      const line = numbers?.[i] ?? i + 1
      const mark = Decoration.line({ attributes: {
        'data-source-line': String(line),
        ...(line === failedLine ? { 'data-execution-highlight': 'failed', 'aria-label': 'Failed here, line ' + line, 'data-evidence': 'Failed here' } : {}),
      } }).range(offset)
      offset += text.length + 1
      return mark
    })
    return [EditorView.lineWrapping, lineNumbers({ formatNumber: n => String(numbers?.[n - 1] ?? n) }),
      EditorView.decorations.of(Decoration.set(marks))]
  }, [source, numbers, failedLine])
  return <div className="test-reader cl-source-excerpt">
    {visualUnavailable && <TestLanguageSwitch reader="compact" mode="code" onVisual={() => {}} onChange={() => {}}
      disabled={{ reason: visualUnavailable }} />}
    <TestReaderEditor label={label} doc={source} syntaxSource={lang === null ? '' : source} lang={lang ?? undefined}
      visual={false} extensions={extensions} />
  </div>
}
