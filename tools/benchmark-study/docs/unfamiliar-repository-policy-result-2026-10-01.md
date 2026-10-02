# Unfamiliar-repository diagnosis policy result — 2026-10-01

**Both fresh campaigns completed with every assigned attempt independently verified: Codex 20/20 and Claude 16/16.** Parent-only diagnosis was faster and used fewer tokens than per-failure diagnosis in every matched pair, for both agents and both defect scenarios. Codex reached five complete blocks per scenario, so its reductions carry 95% block-bootstrap intervals; Claude ran four blocks per scenario, so its reductions are point estimates only. Transcript review found no cross-failure diagnostic reads in any of the 18 per-failure attempts. On the strength of this result, production now defaults to parent-only; per-failure and adaptive remain selectable.

Both campaigns ran on `nextjs-mcp` with the same two injected-defect scenarios (`independent`, `overlap`), seed 3001, a 15-minute repair budget, six feedback checks per attempt and a separate trusted container verdict. Results are not pooled with each other, with the storefront study, or with the earlier V3/V6/V8 unfamiliar-repository campaigns.

## Codex (gpt-6-sol, high effort)

| Scenario | Complete blocks | Repair time reduction | Time-to-verdict reduction | Token reduction |
| --- | ---: | --- | --- | --- |
| independent | 5/5 | 20.7% (95% CI 10.2–29.0) | 19.5% (9.5–27.3) | 48.3% (43.1–53.4) |
| overlap | 5/5 | 21.9% (11.0–33.5) | 20.6% (10.3–31.7) | 47.7% (43.2–51.7) |

| Scenario | Variant | Verified / recorded | Total tokens |
| --- | --- | --- | ---: |
| independent | per-failure | 5/5 | 6,089,983 |
| independent | parent-only | 5/5 | 3,149,821 |
| overlap | per-failure | 5/5 | 4,079,945 |
| overlap | parent-only | 5/5 | 2,135,439 |

The campaign consumed 15,455,188 native tokens against a 25,000,000 dispatch ceiling. Evidence and report (`<workspace>/benchmark-evidence/unfamiliar-nextjs-mcp-codex-fresh-r5-20261001/study/report.md`); configuration digest `5deed678e7f6d587cd412aa4bb22aef66fdecc38ac14cbf078013b3af4c20ea4`.

## Claude (Opus 5.5, high effort)

| Scenario | Complete blocks | Repair time reduction | Time-to-verdict reduction | Token reduction |
| --- | ---: | --- | --- | --- |
| independent | 4/4 | 42.8% | 38.2% | 30.7% |
| overlap | 4/4 | 45.3% | 39.7% | 53.9% |

Intervals are unknown because each scenario has fewer than five complete blocks. Token totals include cache reads and writes. The pinned native permission probe passed before dispatch. Evidence and report (`<workspace>/benchmark-evidence/unfamiliar-nextjs-mcp-claude-full-20261001/study/report.md`); configuration digest `a8c4be8ad2fe16aa6d5f8f37f0bdf75d75cbd629d123191bba3a7a1882664bb2`.

## Policy adherence review

Every diagnosis-child transcript in the 18 per-failure attempts (10 Codex, 8 Claude) was compared with the failure packet named in that child's assignment. No child's tool calls or tool output contained the other failure's identifier, and no child ran a search rooted outside `app/`. Claude children that opened `failure-context/` opened only their own packet. Parent-only attempts spawn no children.

For these two campaigns this was an operator review, not an enforced guarantee. The agent sandbox isolates each attempt, not each child, so "read only your packet" was prompt prose; the earlier V8 Codex attempt 1 violated it through an attempt-root search.

Campaigns prepared after this result enforce it. A frozen `PreToolUse`/`SubagentStart` hook (`repository/child-read-guard.cjs`) checks every call that carries a subagent identity: a child may read only `app/`, and may not write, delegate, run checks, or reach packets, the index, the ledger or the parent prompt. The handoff already carries the child's own diagnostic. Each attempt's `child-read-guard-review.json` lists the denials, and an attempt fails adherence if the guard did not start on every diagnosis child. Live probes on Claude Code 2.1.284 and Codex 0.158 confirmed that child calls carry `agent_id`, parent calls do not, and both CLIs honour the denial. Read, Grep and Glob arguments are checked exactly; shell commands are checked by parsing their paths, which blocks searches rooted at the attempt and hidden or parent paths but is not a full shell interpreter.

## Operational notes

- A combined 20-second Docker daemon and pinned-image check ran before each campaign's preparation and launch, not before every attempt, and passed each time.
- The V8 campaign stopped on a catalog-drift false alarm while a Codex client rewrote `~/.codex/models_cache.json`. For this campaign the Codex desktop app and the VS Code Codex extension were closed. The cache's last write (01:02:04) came from preparation's own catalog inspection, before dispatch began at 01:02:39; it did not change during the run. The guard itself is unchanged.
- The operator's approval write and launch were denied by the Claude Code auto-mode classifier for the Claude campaign; the user ran both from their own terminal. The Codex approval quotes the user's in-chat choice of five repetitions and a 25M ceiling.

## Limits

One repository and two defect scenarios per agent. Dollar cost is unmeasured. The report makes no general superiority claim; the result supports parent-only for this repository's failure shapes and matches the direction of the separate storefront study.
