---
name: cl_flight-progress-model
description: Project-specific corrections about what counts as a flight in Canary Lab and how flight progress is represented. Consult before changing flight records, the flights index, the picker's stage rails, or any UI that decides whether a feature "has flown". Learned conventions for canary-lab.
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# Flight progress model — learned conventions

Corrections captured via /todo-learn. Each is a standing rule for this repo.

## 2026-07-21 — A flight is the stage pipeline, not the flight record

- **Rule:** Treat a *flight* as the pipeline of stages, not as the presence of a
  `logs/flights/<id>/flight.json` record. A stage completed by standalone work —
  a coverage run, repo setup, requirement/PRD setup, docs setup, spec authoring,
  envset capture, portify — counts as that flight stage being done, exactly as if
  the conductor had driven it. A feature whose stages are complete HAS flown; the
  missing record is a bookkeeping gap, not a statement about the feature.
- **Why:** The user's mental model is stage-centric. The flight pipeline is just
  the ordered set of things a feature needs; who ran them (conductor vs. the user
  doing it standalone or via MCP) is an implementation detail. Telling a user with
  7/7 stages complete that they have "not flown" — and offering to start from
  scratch — asks them to redo finished work and makes the flight feature look like
  it only understands work it drove itself.
- **How to apply:** When a UI or API must decide "does this feature have a
  flight?", derive it from stage evidence, not from index membership. Never demote
  evidence-derived progress visually (dimmer squares, hollow rails, an "idle" or
  "not flown" chip) to distinguish it from conductor-driven progress — the two are
  the same fact. If a row shows completed stages, its click target must lead to
  that progress (the flight detail view), never to a start-from-scratch dialog.
  Concretely: `featureActivityRows` / `NotFlownRow` in
  `apps/web/src/features/flights/components/FlightsPill.tsx` and the flights index
  in `apps/web-server` are the surfaces where this rule is easy to violate.
