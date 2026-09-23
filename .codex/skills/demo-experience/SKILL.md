---
name: demo-experience
description: Project-specific corrections about Canary Lab demos. Consult before creating, changing, or verifying a shipped demo or contributor demo command.
metadata:
  internal: true
---

<!-- GENERATED FROM .claude/skills — DO NOT EDIT.
     Run `npm run gen:skills` after editing the source skill (the build does this too). -->

# Demo experience — learned conventions

Corrections captured via /todo-learn. Each is a standing rule for this repo.

## 2026-08-06 — A demo is tester-controlled
- **Rule:** Keep `npm run demo` as one interactive entry that provisions and opens a fresh workspace without starting work for the tester. It currently offers two paths: a full Flight from the un-onboarded `flight-app/`, and a repair tour of the prepared `storefront-journey` suite. Do not present the automated `smoke:demo` gate as the interactive product demo.
- **Why:** The tester must be able to pause, inspect, respond, rerun, and explore. A finished automated result cannot teach those actions.
- **How to apply:** Retain the interactive workspace until explicit cleanup. Verify the Flight path from a fresh state against every current stage (derive the list from `FLIGHT_STAGE_KEYS` in `shared/flights/types.ts`); verify the prepared-suite path separately against the repair loop.

## 2026-08-06 — Multi-service means cross-service repair evidence
- **Rule:** A multi-service demo must require application changes in multiple participating services.
- **Why:** Merely booting extra processes while one service owns every failure and edit does not demonstrate multi-service diagnosis, isolation, or change capture.
- **How to apply:** Pin acceptance to the Services view showing every process and the Changes view capturing files under multiple service roots.

## 2026-08-06 — Reveal dependent defects across repair cycles
- **Rule:** Design the demo's failures as a dependency chain whose next defect becomes observable only after the earlier contract is repaired.
- **Why:** Several simultaneously obvious bugs can be fixed in one pass and do not demonstrate Canary Lab's iterative heal loop or Journal.
- **How to apply:** Use ordered contract, integration, and journey checks with a failure cap chosen for the intended demo. The current storefront sets `healOnFailureThreshold: 4`, so up to four journeys can fail in one run while each journey still reveals its later contract only after the earlier one is repaired. Require Journal entries and real agent evidence for newly revealed layers.
