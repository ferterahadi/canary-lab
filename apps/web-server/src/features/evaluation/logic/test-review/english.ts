import type { ReadableStoryItem } from '../../../../../../../shared/readable-tests/types'
import { translateReadableSource } from '../../../../shared/readable-tests/translator'
import { escapeHtml } from './text'

/** The full explanation shares the review grammar and has no diagram step cap. */
export function renderEnglishSource(file: string, source: string): string {
  const story = translateReadableSource(file.replace(/:\d+(?::\d+)?$/, ''), source)
  const render = (items: ReadableStoryItem[]): string => `<ol>${items.map((item) => `<li>
    <span class="muted">${escapeHtml(item.role)} · </span>${item.presentation === 'syntax-fallback' ? '<strong>English incomplete · </strong>' : ''}<span style="white-space:pre-wrap">${escapeHtml(item.text)}</span>
    ${item.kind === 'flow' && item.children.length ? render(item.children) : ''}
  </li>`).join('')}</ol>`
  if (story.steps.length) return render(story.steps)
  return /^\s*(?:\{\s*\})?\s*$/.test(source)
    ? '<p class="muted">This body has no statements.</p>'
    : '<p class="muted">English unavailable. Review the source code.</p>'
}
