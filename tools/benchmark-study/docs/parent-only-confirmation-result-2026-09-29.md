# Parent-only confirmation: result and partial evidence recovery

**The 40-attempt confirmation completed and passed the numerical gate when inspected live. Original temporary campaign artifacts were subsequently purged.** Native session evidence has been recovered and preserved; independent evaluator receipts, final patch snapshots, the original manifest/results, and stage timing files are no longer locally re-auditable. Production remains per-failure.

## What was observed live

Before deletion, the agent read the complete report and compared all 40 manifest result rows with their independent receipts. All 40 receipts matched; each independent evaluator verdict recorded seven passed journeys, no failed or skipped journeys, and passing extra checks. The campaign was complete with no stop reason. These are prior live-tool observations retained in the conversation, not newly recovered evaluator files.

| Scenario | Parent-only token reduction, 95% block bootstrap | Time-to-independent-verdict reduction, 95% block bootstrap |
| --- | --- | --- |
| Single-service, ten blocks | 66.5% (63.3–69.5%) | 31.2% (25.2–36.3%) |
| Cross-service, ten blocks | 57.1% (48.8–64.9%) | 28.1% (19.8–35.5%) |

Across the balanced scenario mix, reported parent-only means were 433,260 tokens and 80.69 s to independent verdict, versus 1,114,195 tokens and 114.16 s for per-failure: reductions of 61.1% and 29.3%. The live-observed maxima also favored parent-only: 67.46 s versus 102.90 s in single-service, and 119.90 s versus 163.32 s in cross-service. These small samples do not establish stable tail latency or reliability parity.

The predeclared numerical gate required at least 20% fewer mean tokens, 10% lower mean verdict time, no observed success regression, and no scenario mean latency regression above 5%. The observed outcomes met those conditions, with positive scenario bootstrap intervals. This is a historical assessment; missing originals prevent a fresh independent re-audit of timing, protected-file integrity, and evaluator success.

## What is recovered and verifiable now

The selected workspace holds partial recovery evidence (`<workspace>/benchmark-evidence/parent-only-confirmation-20260929-recovered/README.md`), session inventory (`<workspace>/benchmark-evidence/parent-only-confirmation-20260929-recovered/inventory.json`), and SHA-256 inventory (`<workspace>/benchmark-evidence/parent-only-confirmation-20260929-recovered/SHA256SUMS`).

- Recovery selected native Codex logs whose first session metadata record named the exact original confirmation attempt directory. It found 107 sessions: 40 repair parents, 66 children, and one runtime preflight. Every session had a final native usage counter.
- Summing final input plus output once per native session gives **30,992,307 tokens**, exactly matching the campaign total reported before deletion. Cached input is already included. This does not establish dollar cost or restore independent verdict timing.
- Every copied file's SHA-256 matched its source native file. Private directory/file permissions protect raw source and command content. Raw sessions are outside the package repository; the inventory preserves their original working directories and identities. Checksums verify preserved bytes, not the truth of an agent's claims.
- Recovered review found zero children in all 20 parent-only attempts. Ten single-service controls used three children each; six cross-service controls used four and four used three. Three of those four parents explicitly handled the remaining failure; cross-service repetition 10 attempted a fourth spawn but hit the thread limit. Retain these controls in their assigned arm. Child tool-call scans found no write or restart command candidates. These transcript observations support the limited adherence assessment; counts alone do not certify complete failure-ledger coverage, and the generated adherence field remains `unknown`.

## Consequences and next work

Retain the original campaign dossier (`<workspace>/benchmark-evidence/study-notes/parent-only-confirmation-campaign-2026-09-29.md`) as design provenance. Its former `/private/tmp` paths are historical identifiers, not working artifact links or runnable prepared input. Do not reconstruct evaluator receipts from native agent answers or silently label a replay as the original experiment.

Child-context and child-effort experiments remain unnecessary for this selected candidate; direct-launcher work remains deferred. Claude transfer can be designed, but execution should wait until the independent-evidence limitation is resolved or explicitly accepted for that exploratory next step. Broad default adoption remains gated on transfer and installed checks, and cannot be justified by recovered usage alone.

Future campaigns should prepare directly under the selected workspace's `benchmark-evidence/` directory, with fresh immutable inputs and a private evidence root. Preserve manifests, per-attempt receipts, evaluator verdicts, patches, rendered prompts, native sessions, and timing files as they are produced; finish with a checksum inventory and a verified copy before reporting completion. The current harness fingerprints the root, so choose the durable location at preparation rather than moving an active or resumable campaign afterward. No runtime change is needed merely to select a durable `--out` directory.
