import ts from 'typescript'

/** Only rewrite words that actually look like code — dotted paths, snake_case,
 *  $-prefixed, or camelCase. Ordinary prose has to survive verbatim. */
export function looksLikeIdentifier(word: string): boolean {
  if (/[_$]/.test(word)) return true
  // A dotted word is only a property path when both sides are real names —
  // otherwise prose abbreviations ("e.g.", "i.e.") get split into "e g".
  if (word.includes('.')) return word.split('.').every((part) => part.length > 1)
  return /^[a-z][\w$]*[A-Z]/.test(word)
}

export function readableHelperName(name: string): string {
  return sentenceCase(actionFromIdentifier(name) || humanizeIdentifier(name))
}

export function humanizeIdentifier(value: string): string {
  const parts = value.split('.').flatMap(identifierWords)
  return readableObject(parts) || value
}

export function identifierWords(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // A digit splits from a following camel word (`order2Confirm`) or acronym
    // (`step2API`), but stays glued inside a digit-carrying acronym: `E2E_USER`
    // must read "e2e user", never "e2 e user".
    .replace(/([0-9])([A-Z][a-z])/g, '$1 $2')
    .replace(/(?<![A-Z])([0-9])([A-Z])(?![a-z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_$.-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
}

export function displayWord(word: string): string {
  if (word === 'ids') return 'identifiers'
  if (word === 'id') return 'identifier'
  if (word === 'res') return 'response'
  if (word === 'req') return 'request'
  if (word === 'conn') return 'connection'
  if (word === 'env') return 'environment'
  if (word === 'msg') return 'message'
  return word
}

export function sentenceCase(value: string): string {
  if (!value) return value
  return `${value[0].toUpperCase()}${value.slice(1)}`
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

export function calledNameFromText(statement: string): string | undefined {
  const match = statement.match(/(?:await\s+|return\s+)?(?:\(?\s*)?([A-Za-z_$][\w$]*)\s*\(/)
  return match?.[1]
}

export function setupLikeStatement(statement: string): boolean {
  return /\b(route|mock|intercept|fixture|seed|login|storageState|setExtraHTTPHeaders|addInitScript)\b/i.test(statement)
}

/** A statement belongs in a readable flow when it performs work rather than
 *  merely declaring a literal or identifier. */
export function isMeaningfulFlowStatement(node: ts.Node): boolean {
  let found = false
  const visit = (child: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(child) || ts.isAwaitExpression(child) || ts.isNewExpression(child)) {
      found = true
      return
    }
    child.forEachChild(visit)
  }
  visit(node)
  return found
}
