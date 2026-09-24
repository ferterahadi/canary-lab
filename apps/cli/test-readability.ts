import fs from 'node:fs'
import path from 'node:path'
import { describeReadabilityIssue, inspectTestReadability, type TestReadabilityIssue } from '../../shared/test-readability'
import { runAsScript } from './run-as-script'

const EXCLUDED = new Set(['node_modules', 'dist', 'logs', 'test-results', 'playwright-report', '__fixtures__', '__snapshots__', '.git', '.claude', '.codex', '.agents'])
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const SOURCE_FILE = /\.[cm]?[jt]sx?$/
const USAGE = 'canary-lab test-readability <file-or-directory...> [--fix] [--rules-only] [--json]'

interface Options { fix?: boolean; rulesOnly?: boolean }
export interface ReadabilityFileReport {
  file: string
  changed: boolean
  needsChanges: boolean
  issues: TestReadabilityIssue[]
}

function collectFiles(targets: string[]): string[] {
  const files = new Set<string>()
  const visit = (target: string, explicit: boolean): void => {
    const absolute = path.resolve(target)
    if (absolute.split(path.sep).some((part) => EXCLUDED.has(part))) {
      if (explicit) throw new Error(`Refusing generated artifacts or fixture source: ${absolute}`)
      return
    }
    const stat = fs.lstatSync(absolute)
    if (fs.realpathSync(absolute).split(path.sep).some((part) => EXCLUDED.has(part))) {
      if (explicit) throw new Error(`Refusing generated artifacts or fixture source: ${absolute}`)
      return
    }
    if (stat.isSymbolicLink()) {
      if (explicit) throw new Error(`Refusing a symbolic link: ${absolute}`)
      return
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute)) visit(path.join(absolute, entry), false)
    } else if (stat.isFile() && (explicit ? SOURCE_FILE : TEST_FILE).test(absolute) && !absolute.endsWith('.d.ts')) {
      files.add(absolute)
    } else if (explicit) {
      throw new Error(`Expected a JavaScript/TypeScript source file or test directory: ${absolute}`)
    }
  }
  for (const target of targets) visit(target, true)
  if (files.size === 0) throw new Error('No test files found in the selected paths.')
  return [...files].sort()
}

export async function checkTestFiles(targets: string[], options: Options = {}): Promise<ReadabilityFileReport[]> {
  const prepared = []
  for (const file of collectFiles(targets)) {
    const original = fs.readFileSync(file, 'utf8')
    const result = await inspectTestReadability(original, file, options)
    prepared.push({ file, original, result })
  }
  if (options.fix) {
    // Formatting is asynchronous. Check the entire batch again before the first
    // write so an editor/agent's intervening change cannot be overwritten.
    for (const { file, original } of prepared) {
      if (fs.readFileSync(file, 'utf8') !== original) throw new Error(`File changed during inspection; retry: ${file}`)
    }
    for (const { file, result } of prepared) {
      if (result.changed) fs.writeFileSync(file, result.code, 'utf8')
    }
  }
  return prepared.map(({ file, result }) => ({
    file,
    changed: !!options.fix && result.changed,
    needsChanges: !options.fix && result.changed,
    issues: options.fix ? result.remaining : result.issues,
  }))
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: ${USAGE}`)
    return
  }
  const flags = new Set(['--fix', '--rules-only', '--json'])
  const unknown = args.find((arg) => arg.startsWith('-') && !flags.has(arg))
  if (unknown) throw new Error(`Unknown option: ${unknown}. Usage: ${USAGE}`)
  const targets = args.filter((arg) => !flags.has(arg))
  if (targets.length === 0) throw new Error(`Usage: ${USAGE}`)
  const reports = await checkTestFiles(targets, { fix: args.includes('--fix'), rulesOnly: args.includes('--rules-only') })
  const errors = reports.flatMap((report) => report.issues).filter((issue) => issue.severity === 'error').length
  const warnings = reports.flatMap((report) => report.issues).filter((issue) => issue.severity === 'warning').length
  const changed = reports.filter((report) => report.changed).length
  const needsChanges = reports.filter((report) => report.needsChanges).length
  if (args.includes('--json')) {
    console.log(JSON.stringify({ files: reports, errors, warnings, changed, needsChanges }, null, 2))
  } else {
    for (const report of reports) {
      for (const issue of report.issues) console.log(describeReadabilityIssue(report.file, issue))
      if (report.changed) console.log(`Updated ${report.file}`)
    }
    console.log(`${reports.length} files checked; ${changed} updated; ${needsChanges} need fixes; ${errors} errors; ${warnings} review warnings.`)
  }
  process.exitCode = errors > 0 ? 1 : 0
}

runAsScript(module, main)
