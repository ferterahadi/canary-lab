#!/usr/bin/env node
// Offline checker for a Canary Lab behavior certificate (canary-lab/behavior-certificate@1
// and @2 — @2 adds the optional `robustness` block, which is reported, never re-judged).
//
// Re-derives, from files on disk and nothing else, what the certificate claims
// about the suite: every listed spec's sha256, the suite digest built from them,
// and that every listed assertion is really written at its line. Node's own
// `crypto` and `fs` are the only dependencies, so a third party can run this
// without installing or trusting Canary Lab.
//
//   node verify-certificate.mjs certificate.json [--suite <dir>]
//
// `--suite` names the directory holding the specs (the run's snapshot copy, the
// feature's live directory, or a checkout); without it the certificate's own
// recorded directory is used. Exit 0 when every check holds, 1 otherwise, 2 for
// a usage or read error. Output is plain text, one check per line.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const FORMATS = ['canary-lab/behavior-certificate@1', 'canary-lab/behavior-certificate@2']

const out = (line) => process.stdout.write(`${line}\n`)

function main(argv) {
  const [certPath, ...rest] = argv
  if (!certPath) {
    out('usage: node verify-certificate.mjs certificate.json [--suite <dir>]')
    return 2
  }
  const suiteFlag = rest.indexOf('--suite')
  const suiteArg = suiteFlag >= 0 ? rest[suiteFlag + 1] : undefined

  let cert
  try {
    cert = JSON.parse(fs.readFileSync(certPath, 'utf8'))
  } catch (err) {
    out(`cannot read certificate: ${err instanceof Error ? err.message : String(err)}`)
    return 2
  }
  if (!FORMATS.includes(cert.format)) {
    out(`unsupported certificate format: ${String(cert.format)} (this checker reads ${FORMATS.join(', ')})`)
    return 2
  }

  const failures = []
  const check = (ok, label) => {
    out(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
    if (!ok) failures.push(label)
  }

  out(`certificate for run ${cert.run.runId} (${cert.run.feature}) — ${cert.run.status}`)
  out(cert.statement)
  out('')

  // 1. The run's own arithmetic: the buckets sum to the declared roster.
  const c = cert.run.counts
  const summed = c.passed + c.failed + c.skipped + c.interrupted + c.notRun
  check(summed === c.declared, `counts: ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped, ${c.interrupted} interrupted, ${c.notRun} not run = ${c.declared} declared`)
  check(cert.tests.length === c.declared, `tests listed: ${cert.tests.length} (declared ${c.declared})`)

  // 2. The suite content: per-file hashes and the digest over them.
  const suiteDir = suiteArg ?? cert.suite.dir
  if (!suiteDir) {
    check(false, 'suite: no directory to check against (pass --suite <dir>)')
  } else if (!fs.existsSync(suiteDir)) {
    check(false, `suite: directory not found: ${suiteDir}`)
  } else {
    const onDisk = hashSpecs(suiteDir)
    for (const file of cert.suite.files) {
      const actual = onDisk.get(file.path)
      check(actual === file.sha256, `spec ${file.path}: ${actual ? (actual === file.sha256 ? 'sha256 matches' : `sha256 differs (${actual.slice(0, 12)}… vs certified ${file.sha256.slice(0, 12)}…)`) : 'missing on disk'}`)
    }
    for (const rel of onDisk.keys()) {
      if (!cert.suite.files.some((file) => file.path === rel)) check(false, `spec ${rel}: on disk but not in the certificate`)
    }
    const digest = suiteDigest(onDisk)
    check(digest === cert.suite.digest, `suite digest ${digest.slice(0, 16)}… ${digest === cert.suite.digest ? 'matches the certificate' : `differs from certified ${cert.suite.digest.slice(0, 16)}…`}`)
    if (cert.suite.runStartDigest) {
      check(digest === cert.suite.runStartDigest, `suite digest ${digest === cert.suite.runStartDigest ? 'matches' : 'differs from'} the run-start digest ${cert.suite.runStartDigest.slice(0, 16)}…`)
    } else {
      out(`note the run recorded no run-start digest (${cert.suite.reason ?? 'no snapshot'}); the digest above describes the suite as read, not as run`)
    }

    // 3. Every listed assertion is written where the certificate says.
    let predicates = 0
    let located = 0
    for (const test of cert.tests) {
      if (!test.file) continue
      const source = readSpec(suiteDir, test.file)
      if (source === undefined) continue
      const lines = source.split('\n')
      for (const predicate of test.predicates) {
        predicates += 1
        if (predicateAtLine(lines, predicate)) located += 1
        else check(false, `assertion not at ${test.file}:${predicate.line}: ${predicate.source}`)
      }
    }
    check(located === predicates, `assertions located at their lines: ${located}/${predicates}`)
  }

  // 4. Hints and edits are reported, never re-judged.
  out('')
  out(`pending spec edits the verdict never executed: ${cert.specEdits ? cert.specEdits.pending.length : 'unknown (no snapshot boundary)'}`)
  out(`advisory hints: ${cert.hints.length} — ${cert.disclosure}`)
  // 5. Robustness (@2): what the matrix recorded, as recorded. Re-running a cell
  // needs the services, so this checker only relays it — the run ids are there
  // for anyone who wants to.
  if (cert.robustness) {
    const r = cert.robustness
    out(`robustness: ${r.cells.judged}/${r.cells.planned} cells judged (${r.cells.notRun} not run), ${r.findings.length} confirmed finding(s), ${r.unconfirmed.length} unconfirmed — reported from job ${r.jobId} (${r.status}), not re-judged`)
    for (const f of r.findings) out(`  confirmed ${f.cell.specFile} × ${f.cell.atom}: ${f.tests.join(', ')}${f.repro ? ` — ${f.repro}` : ''}`)
    for (const f of r.unconfirmed) out(`  unconfirmed ${f.cell.specFile} × ${f.cell.atom}: ${f.tests.join(', ')}`)
  } else if (cert.format === FORMATS[1]) {
    out('robustness: no matrix ran against this run')
  }
  out('')
  out('not proven by this certificate:')
  for (const line of cert.notProven) out(`  - ${line}`)
  out('')
  out(failures.length === 0 ? 'RESULT: every check holds' : `RESULT: ${failures.length} check(s) failed`)
  return failures.length === 0 ? 0 : 1
}

// A Canary Lab suite's specs are the `.spec.ts` files directly under its `e2e/`
// directory — the same rule the server's spec lister applies when it takes the
// run-start digest, so the two digests are comparable. Paths are `e2e/<name>`.
function hashSpecs(dir) {
  const files = new Map()
  const e2eDir = path.join(dir, 'e2e')
  if (!fs.existsSync(e2eDir)) return files
  for (const entry of fs.readdirSync(e2eDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.spec.ts')) continue
    files.set(`e2e/${entry.name}`, createHash('sha256').update(fs.readFileSync(path.join(e2eDir, entry.name))).digest('hex'))
  }
  return files
}

// Mirrors `suiteDigest` in the server: sha256 over the sorted `<path>\0<sha256>\n` lines.
function suiteDigest(files) {
  const h = createHash('sha256')
  for (const rel of [...files.keys()].sort()) h.update(`${rel}\0${files.get(rel)}\n`)
  return h.digest('hex')
}

function readSpec(dir, rel) {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8')
  } catch {
    return undefined
  }
}

// The certified `source` is the assertion chain with whitespace collapsed. A
// chain may span several lines, so the text is matched against a collapsed
// window that starts at the certified line — but it has to BEGIN on that line:
// a match that only starts further down means the assertion moved.
function predicateAtLine(lines, predicate) {
  const start = predicate.line - 1
  if (start < 0 || start >= lines.length) return false
  const collapse = (text) => text.replace(/\s+/g, ' ').trim()
  const window = collapse(lines.slice(start, start + 12).join(' '))
  const at = window.indexOf(collapse(predicate.source))
  return at !== -1 && at <= collapse(lines[start]).length
}

process.exitCode = main(process.argv.slice(2))
