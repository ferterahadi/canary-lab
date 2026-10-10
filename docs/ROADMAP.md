# Roadmap

These are planned product milestones after [2.3.0 Verification Integrity](CHANGELOG.md). The version numbers describe the intended order, not shipped features or release dates. Each milestone must preserve the link between what Canary Lab shows and what a run actually tested.

## 3.0.x — 3D Workspace

Make the Canary Lab workspace an explorable, animated 3D environment while keeping its name, brand colors, and real feature labels. Use a factory metaphor: the workspace is the factory, suites are GPU boards, test cases are components, and recorded code locations are smaller parts. Running suites move through a testing conveyor; repairs move to a workbench before returning for verification.

Represent the wider product through interactive stations for project and model settings, suite creation and configuration, requirements, portification, execution, repair, code diffs, coverage, history, and reports. Support progressive exploration from workspace to suite to test to recorded code location, with readable details and links to source and evidence.

**Release bar:** Status and animation follow recorded runner or workflow evidence. A completed repair stays verification pending until a rerun confirms success. Recorded failure locations never imply complete line execution or coverage; unavailable evidence remains explicit. Live activity, timestamped snapshots, and historical playback are clearly distinguished. Live views update without refresh, and the experience supports light and dark themes, reduced motion, and large workspaces.

## 3.1.x — Stub Detector

Show whether a tested path reached a real implementation, a stub or mock, or something Canary Lab cannot yet determine. Point to the code and run configuration behind the assessment so a green test cannot quietly stand in for an untested real integration.

**Release bar:** The result distinguishes real, stubbed, and unknown paths. An uncertain path stays unknown; a source file or passing test alone is not proof that the real implementation ran.

## 3.2.x — Custom Artifacts

Let the user tell Canary Lab which proofs a run must produce, such as a provider receipt, database record, screenshot, or application log. Collect those artifacts with the run and show them beside the test and evaluation report.

**Release bar:** The report identifies requested, collected, missing, and unverified proof separately, with its run and source. Attaching a file by itself does not establish that the behavior succeeded.

## 3.3.x — Robustness Lab

Run controlled disruptions against a suite, then show how the tested system behaved and recovered. Examples include a delayed dependency, a service restart, or a temporary failure, with the original test result and the disruption evidence kept together.

**Release bar:** Each result names the disruption, the observed behavior, and the recovery check. A simulated dependency or an unobserved recovery cannot be presented as proof of production resilience.
