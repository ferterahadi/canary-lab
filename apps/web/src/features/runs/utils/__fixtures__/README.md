# Run regression fixtures

These are anonymized recordings for Canary's own tests. Original feature suites,
fixtures, and run artifacts belong in the selected Canary workspace. Repository
tests must work in a fresh checkout without that workspace.

| Fixture | Regression preserved |
| --- | --- |
| `run-snapshot-review.json` | Workspace source and recorded snapshot use different roots; 77 passed, 12 failed, 9 skipped; pending edits keep the run awaiting review. |
| `run-snapshot-renamed.json` | Current test names differ from the recorded roster; 85 passed, 4 failed, 9 skipped. |
| `run-legacy-roster.json` | A legacy run retains 23 passes and its roster but has no saved source snapshot. |

Names, IDs, dates, and roots are placeholders. The recorded shapes, counts,
ordering, shared locations, and result membership are retained. Keep those
relationships when updating a fixture; do not copy private run data into the
repository or point tests at a local workspace.

The conventions check rejects personal home paths and fixture symlinks. Use
portable roots such as `/workspace` or placeholders resolved by the test.
