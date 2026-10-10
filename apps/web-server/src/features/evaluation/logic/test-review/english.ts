import type { ExtractedTest } from '../../../../../../../shared/extracted-test'
import { storyDisplaySpans, storyKeyword, storyKeywordTone } from '../../../../../../../shared/readable-tests/story-presentation'
import { storyLocalSequenceLabel, storySequenceLabel } from '../../../../../../../shared/readable-tests/story-source-map'
import type { ReadableStoryItem } from '../../../../../../../shared/readable-tests/types'
import { translateReadableSource } from '../../../../shared/readable-tests/translator'
import { escapeAttr, escapeHtml } from './text'

/** One story as the Tests column lays it out: each step numbered by its place
 * in the story (01, 02 and 02.1 inside it), led by its keyword, with the
 * keyword's redundant words dropped from the sentence. `sourceFile` names the
 * test's own file, so a step read from a helper elsewhere says where. */
function renderStory(steps: readonly ReadableStoryItem[], sourceFile?: string, parent: number[] = []): string {
  return `<ol class="story${parent.length ? ' story-nested' : ''}">${steps.map((step, index) => {
    const sequence = [...parent, index + 1]
    const where = sourceFile && step.source.file !== sourceFile ? `<span class="story-where"> // ${escapeHtml(step.source.file.split('/').pop()!)}</span>` : ''
    const lines = sourceFile ? ` data-source-line="${step.source.startLine}"` : ''
    const text = storyDisplaySpans(step).map((span) => span.kind ? `<span class="sp-${span.kind}">${escapeHtml(span.text)}</span>` : escapeHtml(span.text)).join('')
    return `<li class="story-row" data-story-sequence="${escapeAttr(storySequenceLabel(sequence))}"${lines}>
      <span class="story-line${step.role === 'note' ? ' story-note' : ''}"><span class="story-label">${storyLocalSequenceLabel(sequence)}</span><span class="story-keyword tone-${storyKeywordTone(step)}">${escapeHtml(storyKeyword(step))}</span><span class="story-text">${step.presentation === 'syntax-fallback' ? '<span class="story-fallback">English incomplete · </span>' : ''}${text}${where}</span></span>
      ${step.kind === 'flow' && step.children.length ? renderStory(step.children, sourceFile, sequence) : ''}
    </li>`
  }).join('')}</ol>`
}

const NO_STATEMENTS = '<p class="muted">This body has no statements.</p>'

/** A test's English exactly as the Tests column numbers it, from the same
 * extracted test. The translator leaves out the story of a body with no
 * statements, as the web reads it. */
export function renderTestEnglish(test: ExtractedTest, sourceFile: string): string {
  const steps = test.readable.story?.steps
  if (!steps?.length) return NO_STATEMENTS
  const partial = test.readable.completeness === 'partial' ? '<p class="muted">English representation is incomplete</p>' : ''
  return `${partial}${renderStory(steps, sourceFile)}`
}

/** The full explanation shares the review grammar and has no diagram step cap. */
export function renderEnglishSource(file: string, source: string): string {
  const story = translateReadableSource(file.replace(/:\d+(?::\d+)?$/, ''), source)
  if (story.steps.length) return renderStory(story.steps)
  return /^\s*(?:\{\s*\})?\s*$/.test(source)
    ? NO_STATEMENTS
    : '<p class="muted">English unavailable. Review the source code.</p>'
}
