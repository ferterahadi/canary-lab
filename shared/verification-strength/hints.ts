// An integrity hint (D13): the verification-strength differential's reading of
// a live spec edit the run has NOT executed, shaped for a reader — the UI, an
// MCP result, a skill, the behavior certificate. Advisory by construction; the
// server derives them in `runtime/run-integrity-hints.ts`, and the type lives in
// the root shared tree (like the disclosure) so the certificate format and the
// web can name it without reaching into the server.

export type IntegrityHint =
  | {
      kind: 'weaker'
      /** Spec path relative to the suite dir. */
      file: string
      /** Test name on the live side; for a deleted test, the name the copy knew. */
      test: string
      /** `@req-*` ids the live test carries. Absent when it carries none or is gone. */
      requirements?: string[]
      /** Assertion source as written, before-side then live-side, for the changes that weakened. */
      was: string[]
      now: string[]
    }
  | {
      kind: 'cannot-classify'
      file: string
      /** Absent when the whole file could not be read (a side that does not parse). */
      test?: string
      reason: string
    }
