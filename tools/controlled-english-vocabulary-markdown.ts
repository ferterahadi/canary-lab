import {
  BINARY_OPERATOR_PHRASES,
  COMPOUND_ASSIGNMENT_PHRASES,
  MODIFIER_WORDS,
} from '../apps/web-server/src/shared/controlled-english/ast-to-ir'
import { CONTROLLED_ENGLISH_TYPESCRIPT_VERSION } from '../apps/web-server/src/shared/controlled-english/compiler-context'
import {
  SYNTAX_KIND_INFO,
  canonicalKindName,
  type KindDisposition,
} from '../apps/web-server/src/shared/controlled-english/syntax-kinds'
import {
  VOCABULARY,
  type VocabularyEntry,
} from '../apps/web-server/src/shared/controlled-english/vocabulary'

const DISPOSITION_ORDER: readonly KindDisposition[] = [
  'translated',
  'keyword-token',
  'operator-token',
  'jsdoc',
  'structural-child',
  'punctuation',
  'modifier',
  'compiler-internal',
  'trivia',
]

const DISPOSITION_MEANINGS: Readonly<Record<KindDisposition, string>> = {
  translated: 'Has exactly one canonical English form (documented below)',
  'keyword-token': 'A keyword token consumed by its owning construct',
  'operator-token': 'Rendered through an operator phrase table, never as a node',
  jsdoc: 'JSDoc structure — trivia to the translator',
  'structural-child': 'Never rendered alone — translated as part of its parent construct',
  punctuation: 'Pure syntax — carries no meaning of its own',
  modifier: 'Rendered through the modifier word table',
  'compiler-internal': 'Synthetic/internal kinds a parsed source file never contains',
  trivia: 'Comments and whitespace — comments render as explicit `comment:` lines',
}

function operatorRows(phrases: ReadonlyMap<number, string>): string[] {
  return [...phrases].map(([kind, phrase]) => `| \`${canonicalKindName(kind)}\` | ${phrase} |`)
}

function modifierRows(): string[] {
  return Object.entries(MODIFIER_WORDS).map(([kind, word]) =>
    `| \`${canonicalKindName(Number(kind))}\` | ${word} |`,
  )
}

function exampleLanguage(entry: VocabularyEntry): string {
  return entry.exampleFile?.endsWith('x') ? 'tsx' : 'ts'
}

function entryLines(entry: VocabularyEntry): string[] {
  const lines = [
    `### ${entry.syntaxKind}`,
    '',
    `- **Node interface:** \`${entry.nodeInterface}\``,
    `- **Category:** ${entry.category}`,
    `- **TypeScript-only:** ${entry.typescriptOnly ? 'yes' : 'no'}`,
    `- **Canonical English:** ${entry.canonicalEnglish}`,
    `- **Template:** ${entry.englishTemplate}`,
    `- **Children:** ${entry.children.length === 0 ? 'none' : entry.children.join(', ')}`,
    `- **Evaluation order:** ${entry.evaluationOrder}`,
    `- **Semantic info required:** ${entry.semanticInfoRequired}`,
  ]
  if (entry.notes) lines.push(`- **Notes:** ${entry.notes}`)
  lines.push(
    '',
    entry.exampleFile ? `Example (\`${entry.exampleFile}\`):` : 'Example:',
    '',
    `\`\`\`${exampleLanguage(entry)}`,
    entry.exampleSource,
    '\`\`\`',
    '',
    '\`\`\`text',
    entry.exampleEnglish,
    '\`\`\`',
    '',
  )
  return lines
}

/** Render the checked-in human vocabulary from the same tables used by the
 * translator. A byte-for-byte test keeps this document from becoming a
 * second, manually maintained wording source. */
export function renderVocabularyMarkdown(): string {
  const translated = SYNTAX_KIND_INFO.filter((row) => row.disposition === 'translated')
  const lines = [
    '# TypeScript AST Vocabulary — Controlled English',
    '',
    '**Generated file — do not edit by hand.** Regenerate it from the repository-owned tables with:',
    '',
    '```sh',
    'node --import tsx tools/gen-controlled-english-vocabulary.ts',
    '```',
    '',
    `Compiled against TypeScript **${CONTROLLED_ENGLISH_TYPESCRIPT_VERSION}** — the pinned grammar version`,
    '(`apps/web-server/src/shared/controlled-english/compiler-context.ts`). Every example below is a complete',
    'program whose exact whole-file rendering is enforced byte-for-byte by `vocabulary.test.ts`.',
    '',
    '## Kind inventory (Phase 1)',
    '',
    'Every `ts.SyntaxKind` name is classified in `apps/web-server/src/shared/controlled-english/syntax-kinds.ts`:',
    '',
    '| Disposition | Kinds | Meaning |',
    '| --- | ---: | --- |',
    ...DISPOSITION_ORDER.map((disposition) => {
      const count = SYNTAX_KIND_INFO.filter((row) => row.disposition === disposition).length
      return `| ${disposition} | ${count} | ${DISPOSITION_MEANINGS[disposition]} |`
    }),
    '',
    'A kind outside this table (or a translated kind missing an implementation) throws',
    '`UNSUPPORTED_SYNTAX_KIND: <kind>` — the engine never falls back to source code or silent prose (Phase 6).',
    '',
    '## Binary operator phrases',
    '',
    'One distinct phrase per operator — two different operators can never read alike.',
    '',
    '| Operator token | English |',
    '| --- | --- |',
    ...operatorRows(BINARY_OPERATOR_PHRASES),
    '',
    'Simple assignment (`=`) reads **assign X the value Y**, and the comma operator reads',
    '**evaluate and discard X then yield Y** — both structured forms, not table rows.',
    '',
    '## Compound assignment phrases',
    '',
    '| Operator token | English |',
    '| --- | --- |',
    ...operatorRows(COMPOUND_ASSIGNMENT_PHRASES),
    '',
    '## Modifier words',
    '',
    'Rendered in source order. The table is total over `ts.ModifierSyntaxKind` by type,',
    'so a TypeScript upgrade that adds a modifier fails compilation.',
    '',
    '| Modifier | English |',
    '| --- | --- |',
    ...modifierRows(),
    '',
    '## Translated kinds — summary',
    '',
    `${translated.length} kinds carry a canonical English form:`,
    '',
    '| SyntaxKind | Category | Canonical English |',
    '| --- | --- | --- |',
    ...VOCABULARY.map((entry) =>
      `| \`${entry.syntaxKind}\` | ${entry.category} | ${entry.canonicalEnglish} |`,
    ),
    '',
    '## Translated kinds — full entries',
    '',
    ...VOCABULARY.flatMap(entryLines),
  ]
  return `${lines.join('\n').trimEnd()}\n`
}
