import { writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { renderVocabularyMarkdown } from './controlled-english-vocabulary-markdown'

const outputFile = resolve(process.cwd(), 'docs/controlled-english/typescript-ast-vocabulary.md')
writeFileSync(outputFile, renderVocabularyMarkdown(), 'utf8')
console.log(`Generated ${relative(process.cwd(), outputFile)}`)
