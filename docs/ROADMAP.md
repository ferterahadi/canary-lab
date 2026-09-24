# Roadmap

These are planned product milestones after [2.3.0 Verification Integrity](CHANGELOG.md). The version numbers describe the intended order, not shipped features or release dates. Each milestone must preserve the link between what Canary Lab shows and what a run actually tested.

## 2.4.x — Stub Detector

Show whether a tested path reached a real implementation, a stub or mock, or something Canary Lab cannot yet determine. Point to the code and run configuration behind the assessment so a green test cannot quietly stand in for an untested real integration.

**Release bar:** The result distinguishes real, stubbed, and unknown paths. An uncertain path stays unknown; a source file or passing test alone is not proof that the real implementation ran.

## 2.5.x — Visual Test Cases

Add **Visual** as a third view alongside **English** and **Code** for each test case. Show its actions, checks, branches, retries, and helper calls as a source-linked flow that is easier to scan than a wall of text. The viewer must identify whether it is showing current source or the version recorded by a run.

**Release bar:** Every visual step opens the corresponding source. Unsupported or dynamic behavior remains visible as unknown rather than being drawn as a certain path.

## 2.6.x — Custom Artifacts

Let the user tell Canary Lab which proofs a run must produce, such as a provider receipt, database record, screenshot, or application log. Collect those artifacts with the run and show them beside the test and evaluation report.

**Release bar:** The report identifies requested, collected, missing, and unverified proof separately, with its run and source. Attaching a file by itself does not establish that the behavior succeeded.

## 2.7.x — Robustness Lab

Run controlled disruptions against a suite, then show how the tested system behaved and recovered. Examples include a delayed dependency, a service restart, or a temporary failure, with the original test result and the disruption evidence kept together.

**Release bar:** Each result names the disruption, the observed behavior, and the recovery check. A simulated dependency or an unobserved recovery cannot be presented as proof of production resilience.
