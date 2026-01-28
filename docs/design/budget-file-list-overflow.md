# Handle budgets smaller than the file list

## Context
`--budget` is intended to keep codemap output within a token limit by reducing detail. Today the budget logic only reduces per-file detail levels. When a repo has many files, the outline-only file list can still exceed the budget. The output then violates the user budget, and the reported token estimate can be far above the requested limit.

## Problem
- `fitToBudget` reduces detail down to `outline` but never removes files.
- If the sum of outline entries is still larger than `tokenBudget`, total output exceeds the budget.
- The output provides no warning or fallback, so `--budget` appears broken for small budgets in large repos.

## Goals
- Ensure `--budget` never produces an output larger than the requested budget.
- Preserve a useful, predictable fallback when the file list itself is too large.
- Avoid surprising or misleading summary stats.

## Non-goals
- Perfect token counting (still an approximation).
- Changing the default output format when no budget is provided.

## Current behavior
- `fitToBudget` computes `tokenEstimate` using `renderFileEntry` and reduces detail levels until all files are `outline`.
- If total still exceeds the budget, the loop ends and the final output can exceed `tokenBudget`.

## Proposed approach
1. Keep the existing detail reduction step.
2. After all entries are `outline`, if total still exceeds the budget:
   - Drop file entries until `total <= budget`.
   - Track how many entries were omitted (`omittedFiles`) and how many were shown.
3. Keep project stats based on the full file set, but update the footer to show both total and displayed counts.
4. Add a short note in text output when truncation occurs.
5. Mirror the counts in JSON output.

This makes `--budget` strict while still returning some file list context (when possible).

## Decisions
- Truncate the file list (keep the first N entries in sorted order) when outline output still exceeds budget.
- Add a single summary line in the footer when detail levels are reduced (no per-file notes).

## Alternatives
- **Stats-only fallback**: If the outline list exceeds budget, omit file entries entirely and render only summary stats.
- **Add an extra detail level** (e.g., `path-only`) before truncation. This helps a little but does not solve large repos.

## Implementation sketch
- Update `fitToBudget` to return `{ entries, omitted }` or add a new helper that trims entries after detail reduction.
- Keep a copy of `entries` before trimming for stats.
- Extend `SourceMapResult` with fields like `filesShown`, `filesTotal`, `filesOmitted` (or similar).
- Update `renderText` footer to display `Files: <total> (showing <shown>)` and add a one-line note when truncation happens.
- Update `renderJson` to include `files_total`, `files_shown`, `files_omitted`.

## Tests
- Add a test that builds a temp project with many small files, sets a tiny budget, and verifies:
  - `result.totalTokens <= budget`
  - `filesShown < filesTotal` when truncation occurs
  - `stats.totalFiles` remains equal to the full file count
- Add a test for a budget that fits after outline reduction but without truncation.

## Files to update
- `src/sourceMap.ts`
- `src/types.ts`
- `src/render.ts`
- `tests/sourceMap.test.ts`
- `README.md` (document truncation or fallback behavior)

## Open questions
- Prefer truncation with counts (proposed) or an automatic stats-only fallback when the outline list exceeds budget?
- If truncating, should we drop files from the end (alphabetical) or remove the largest entries first?
