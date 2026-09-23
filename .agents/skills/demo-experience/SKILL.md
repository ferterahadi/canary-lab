---
name: demo-experience
description: Project-specific corrections about Canary Lab demos. Consult before creating, changing, or verifying a shipped demo or contributor demo command.
metadata:
  internal: true
---

# Demo experience — learned conventions

Corrections captured via /todo-learn. Each is a standing rule for this repo.

## 2026-08-06 — A demo is a tester-controlled full Flight
- **Rule:** Ship one canonical demo that starts from an un-onboarded application and lets the tester drive every Flight stage; do not substitute an automated run that leaves behind a finished result.
- **Why:** The demo must teach the complete product journey and preserve the tester's ability to pause, inspect, respond, rerun, and explore.
- **How to apply:** When adding or changing a demo command, make its job provision + open + retain the workspace. Verify every current Flight stage from a fresh state (derive the list from `FLIGHT_STAGE_KEYS` in `shared/flights/types.ts`) and keep the workspace until explicit cleanup.

## 2026-08-06 — Multi-service means cross-service repair evidence
- **Rule:** A multi-service demo must require application changes in multiple participating services.
- **Why:** Merely booting extra processes while one service owns every failure and edit does not demonstrate multi-service diagnosis, isolation, or change capture.
- **How to apply:** Pin acceptance to the Services view showing every process and the Changes view capturing files under multiple service roots.

## 2026-08-06 — Reveal dependent defects across repair cycles
- **Rule:** Design the demo's failures as a dependency chain whose next defect becomes observable only after the earlier contract is repaired.
- **Why:** Several simultaneously obvious bugs can be fixed in one pass and do not demonstrate Canary Lab's iterative heal loop or Journal.
- **How to apply:** Use ordered contract, integration, and journey checks with a failure cap chosen for the intended demo. The current storefront sets `healOnFailureThreshold: 4`, so up to four journeys can fail in one run while each journey still reveals its later contract only after the earlier one is repaired. Require Journal entries and real agent evidence for newly revealed layers.
