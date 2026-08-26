import { sourceKey } from './ast'
import {
  actionFromIdentifier,
  assignedNameFromStatement,
  calledNameFromText,
  humanizeIdentifier,
  looksLikeIdentifier,
  readableActionName,
  readableCreatedObject,
  readableObject,
  sentenceCase,
} from '../../../../shared/readable-tests/language'
import { splitAnnotations } from './text'
import type { FlowNode, TestReviewCase } from './types'

export {
  actionFromIdentifier,
  assignedNameFromStatement,
  readableActionName,
  readableCreatedObject,
  readableObject,
} from '../../../../shared/readable-tests/language'

export function audienceTitle(title: string): string {
  const cleaned = title
    .replace(/^[A-Z]\.\s+/, '')
    .replace(/\b(incl\.?|incl)\b/gi, 'including')
    .replace(/\bauto-resolved\b/gi, 'automatically resolved')
    .replace(/\bwarn\b/gi, 'warning')
    .replace(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/g, (match) => {
      return looksLikeIdentifier(match) ? humanizeIdentifier(match) : match
    })
    .replace(/\s*-\s*>|\s*→\s*/g, ' then ')
    .replace(/\s+/g, ' ')
    .trim()
  return sentenceCase(cleaned)
}

export function audienceFlowTitle(node: FlowNode, test: TestReviewCase): string {
  if (node.readable) return node.title
  if (node.kind === 'start') return 'Start the scenario'
  if (node.kind === 'end') return node.title.replace(/^Result:/, 'Run result:')
  if (node.kind === 'assertion') return 'Check the expected outcome'
  if (node.kind === 'helper') {
    const helperName = node.title.replace(/^Helper:\s*/, '')
    // `readableActionName` never returns an empty string — it carries its own
    // 'Run the next step' fallback — so the `|| readableHelperName(…) || 'Run a
    // shared test step'` chain that used to sit here could never be reached.
    // NOTE: that also means a helper whose name yields no recognisable action
    // words gets the generic label rather than the humanised helper name the
    // dead arm intended. Changing that changes exported report text, so it is
    // recorded here rather than fixed in a coverage pass.
    return readableActionName(helperName, node.detail ?? helperName)
  }
  if (node.kind === 'setup') return 'Prepare the scenario'
  if (node.detail) return readableAction(node.detail, test)
  return 'Run the next step'
}

export function audienceFlowDetail(detail: string): string {
  const nested = detail.match(/^(\d+)\s+nested assertions?$/i)
  if (nested) return `${nested[1]} check${nested[1] === '1' ? '' : 's'} inside this shared step`
  if (/\b(await|expect|const|let|return|function)\b|=>|[{}=()]|[_$]/.test(detail)) return 'Uses the recorded test step.'
  return detail
    .replace(/\bassertions?\b/gi, 'checks')
    .replace(/\bnested assertion(s)?\b/gi, 'checks inside this shared step')
    .replace(/\bnested\b/gi, 'included')
    .replace(/\bstrict\b/gi, 'exact')
    .replace(/\bunknown\b/gi, 'not graded')
}

export function readableAction(statement: string, test: TestReviewCase): string {
  if (/\btest\.skip\b/.test(statement)) return 'Skip if required test setup is missing'
  const called = calledNameFromText(statement)
  if (/\bexpect\b/.test(statement)) return 'Check the expected outcome'
  if (called) return readableActionName(called, statement)
  if (/\broute|mock|intercept|fixture|seed\b/i.test(statement)) return 'Prepare test data or mocks'
  if (/\bclick\b/i.test(statement)) return 'Click the relevant control'
  if (/\bfill\b/i.test(statement)) return 'Enter the required value'
  if (/\bwaitForURL\b/i.test(statement)) return 'Wait for the expected page'
  return sentenceCase(audienceTitle(test.title))
}

/** The headline a reader sees. Annotation tags are stripped (they render as tags),
 *  and a rewrite that stripped down to nothing falls back to the raw title rather
 *  than leaving the case unlabelled. */
export function displayCaseTitle(audienceTitleText: string, rawTitle: string): string {
  // Sentence-cased AFTER the tags come off: `@req-R5 @path-sad refuses to …`
  // otherwise renders with a lowercase opening word.
  return sentenceCase(splitAnnotations(audienceTitleText).text || splitAnnotations(rawTitle).text || rawTitle)
}

export function specFileLabel(location: string): string {
  const file = sourceKey(location).replace(/:\d+$/, '')
  return file.split(/[\\/]/).pop() || file
}

/** `/very/long/abs/path/e2e/foo.spec.ts:138` → `e2e/foo.spec.ts:138`. The absolute
 *  prefix is machine-specific noise in a document meant to be read by a person. */
export function shortLocation(location: string): string {
  const parts = location.split(/[\\/]/)
  return parts.slice(-2).join('/')
}
