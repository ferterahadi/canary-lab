Test readability:
- Declare each variable in a separate statement. Use descriptive names and visibly separate setup, action, and assertions.
- Keep helpers small enough that their inputs and effects are clear. Prefer explicit branches to nested conditional expressions. Do not use comma expressions to combine actions.
- Draft acceptance automatically splits ordinary grouped declarations and formats the specs. It rejects syntax errors and comma expressions, and reports nested conditionals for review. It does not infer intent or rewrite test logic.
- Audit existing test source with `canary-lab test-readability <file-or-directory>`. Add `--fix` for approved declaration fixes and formatting; use `--rules-only` to preserve existing layout.
- Preserve assertions, test titles, requirement tags, skips, fixtures, and execution order during cleanup. Run affected tests after editing. Never weaken an assertion to make a run pass, and never rewrite recorded run artifacts.
