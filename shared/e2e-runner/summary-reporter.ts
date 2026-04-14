import fs from 'fs'
import path from 'path'
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import { LOGS_DIR } from './paths'

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

interface TestEntry {
  name: string
  passed: boolean
}

class SummaryReporter implements Reporter {
  private results: TestEntry[] = []

  onTestEnd(test: TestCase, result: TestResult): void {
    this.results.push({
      name: `test-case-${slugify(test.title)}`,
      passed: result.status === 'passed',
    })
  }

  onEnd(_result: FullResult): void {
    const summary = {
      total: this.results.length,
      passed: this.results.filter((r) => r.passed).length,
      failed: this.results.filter((r) => !r.passed).map((r) => r.name),
    }

    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify(summary, null, 2) + '\n',
    )
  }
}

export default SummaryReporter
