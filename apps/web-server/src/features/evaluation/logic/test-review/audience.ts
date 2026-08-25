import path from 'path'
import ts from 'typescript'
import { sourceKey } from './ast'
import { calledNameFromText } from './flowchart'
import { displayWord, humanizeIdentifier, identifierWords, looksLikeIdentifier, readableHelperName, sentenceCase, splitAnnotations } from './text'
import type { FlowNode, TestReviewCase } from './types'

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

export function readableActionName(name: string, statement: string): string {
  if (/\bnew\s+Date\b/.test(statement)) return 'Record the start time'
  const action = actionFromIdentifier(name, assignedNameFromStatement(statement))
  return action ? sentenceCase(action) : 'Run the next step'
}

export function actionFromIdentifier(name: string, assignedName?: string): string {
  const words = identifierWords(name)
  if (!words.length) return ''
  const first = words[0]
  const rest = words.slice(1)
  if (first === 'expect' || first === 'assert' || first === 'check') return `check ${readableObject(rest) || 'the expected outcome'}`
  if (first === 'mock') return `prepare ${readableObject(rest) || 'test data'}`
  if (first === 'create' || first === 'make' || first === 'build' || first === 'generate' || first === 'prepare') {
    return `prepare ${readableCreatedObject(rest, assignedName)}`
  }
  if (first === 'send' || first === 'post' || first === 'submit' || first === 'publish') {
    return `send ${readableObject(rest.filter((word) => word !== 'send' && word !== 'post')) || 'the request'}`
  }
  if (first === 'query' || first === 'read' || first === 'fetch' || first === 'get' || first === 'find') {
    return `read ${readableObject(rest) || 'the saved record'}`
  }
  if (first === 'poll' || first === 'wait') return `wait for ${readableObject(rest) || 'the expected result'}`
  if (first === 'toggle' || first === 'enable' || first === 'disable' || first === 'restore' || first === 'update' || first === 'upsert') {
    return `${first} ${readableObject(rest) || 'test data'}`
  }
  if (first === 'with') return `check ${readableObject(rest) || 'the related records'}`
  if (words.includes('click')) return 'click the relevant control'
  if (words.includes('fill')) return 'enter the required value'
  return readableObject(words)
}

export function readableCreatedObject(words: string[], assignedName?: string): string {
  const targetWords = words.length ? words : identifierWords(assignedName ?? '')
  if (targetWords.includes('id') || targetWords.includes('ids')) return 'unique identifiers'
  return readableObject(targetWords) || 'test data'
}

export function readableObject(words: string[]): string {
  return words
    .filter((word) => word && word !== 'async')
    .map(displayWord)
    .join(' ')
    .trim()
}

export function assignedNameFromStatement(statement: string): string | undefined {
  return statement.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/)?.[1]
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
