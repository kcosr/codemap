# Tag Filtering: Missing Tag Keys

## Background

Codemap already supports tag-based filtering via `--filter-tag` and `--filter-tag-any`.
The missing piece is discovering items that do not have a required tag key, especially
when tags are used to denote required dimensions (for example, `domain`, `feature`, or
`owner`). We want a focused way to find items that match some tags but are missing others.

## Goals

- Add a `--missing-tag <key>` filter that matches items missing that tag key.
- Support the new filter in both the main map command and `codemap annotations`.
- Treat repeated `--missing-tag` flags as AND semantics.
- Keep validation consistent with existing tag key rules (lowercase, `TAG_KEY_RE`).
- No schema changes.

## Non-Goals

- Value-level negation (`--exclude-tag key=value`), except as a future extension.
- Automatic tag normalization or key/value rewriting.
- Tagging export-only content or index changes beyond filtering.

## Proposed CLI Options

### Map command

- `--filter-tag key=value` (repeatable, AND semantics)
- `--filter-tag-any key=value` (repeatable, OR semantics)
- `--missing-tag key` (repeatable, AND semantics)
- Optional follow-up: `--exclude-tag key=value` (not part of this change)

### Annotations command

- `--tag key=value` (existing, repeatable, AND semantics)
- `--missing-tag key` (repeatable, AND semantics)

## Semantics

- `--missing-tag key` matches items whose tag map **does not contain** the tag key.
  - Items with no tags at all are treated as missing every key.
  - The key is lowercased and validated against `TAG_KEY_RE` (same as tags).
- Repeating `--missing-tag` requires all provided keys to be missing (intersection).
- Tag filters (`--filter-tag`, `--filter-tag-any`, `--missing-tag`) are treated as a
  set intersection; order does not matter.
- Applies per entry scope:
  - File filtering uses file tag maps.
  - Symbol filtering uses symbol tag maps.
- Map-only: when `--missing-tag` is combined with `--annotated`, only entries that
  already have tags are returned (untagged items are excluded).
- `codemap annotations` does not support `--annotated`; `--unannotated` already
  lists files without tags, so `--missing-tag` is effectively redundant there.

## Examples

- `domain=web` but `feature` is missing (include untagged items):
  ```bash
  codemap annotations --scope symbols --kinds class,enum,interface \
    --tag domain=web \
    --missing-tag feature
  ```
- `domain=web` but `feature` is missing (only already-tagged items):
  ```bash
  codemap --filter-tag domain=web --missing-tag feature \
    --kinds class,enum,interface \
    --annotated
  ```
- `domain=web` and `feature=auth`:
  ```bash
  codemap --filter-tag domain=web --filter-tag feature=auth \
    --kinds class,enum,interface
  ```

## Implementation Sketch

- CLI parsing:
  - Add a `--missing-tag` option (repeatable string) to:
    - `codemap [patterns...]`
    - `codemap annotations`
  - Parse keys with a helper (lowercase + `TAG_KEY_RE` validation).
- Filtering:
  - Add `missingTagKeys?: string[]` to `SourceMapOptions`.
  - Extend tag filtering in `buildEntriesFromCache`:
    - Determine if a tag map contains any of the keys.
    - Exclude entries where any `missingTagKey` is present.
  - Update the annotations listing path to apply the same check for files and symbols.

## Files to Update

- `src/cli.ts` (new flag parsing + wiring)
- `src/sourceMap.ts` (filter logic)
- `src/types.ts` (options shape)
- `src/tags.ts` (tag key parsing or helper)
- `README.md` (document the new option)
- `tests/annotations.test.ts` (new filter cases)

## Open Questions

- No `--missing-tag-any` for now (AND semantics only).
- Defer `--exclude-tag key=value` until a later iteration.
