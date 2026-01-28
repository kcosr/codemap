# Codemap Annotation and Indexed Reference Design

## Background
Codemap already supports free-text annotations on files and symbols stored in the local
cache (`.codemap/cache.db`). For large SDKs, free-text notes are not enough: we need
structured tags to support discovery, filtering, and a compact index that agents can
load without scanning the full repo.

This document refines requirements and a concrete design for structured tags and
annotation-driven output, building on the current annotation feature set.

## Current State (as of today)
- File and symbol annotations are stored as free-text notes in SQLite tables.
- CLI commands: `codemap annotate` and `codemap annotations`.
- Output supports annotations in text and JSON (`annotation` fields).
- Cache lives at `.codemap/cache.db` and survives reindexing.
- Orphaned annotations are preserved until cleared.

## Goals
1. Support structured tags on files and symbols (alongside free-text notes).
2. Discover and list tags with counts (by scope and key).
3. Filter codemap output by tags and kinds.
4. Export a compact, tag-driven index for LLM prompts.
5. Support bulk annotation via globs and optional heuristics.
6. Report coverage and drift (unannotated, orphaned, summary).

## Non-Goals
- Replacing the codemap parser or adding new language support.
- Full schema extraction for every API surface.
- Building a standalone search engine or knowledge base.

## Design Overview

### 1) Tag Model
- Tag format: `key=value`.
- Keys are lowercased on write to avoid duplicates (`Category` -> `category`).
- Values are stored as provided (trimmed), case-sensitive.
- Multiple values per key are allowed.
- Tags are optional; notes continue to work without tags.

Validation (proposed):
- `key` must match `[a-z][a-z0-9_-]*`.
- `value` must be non-empty and must not contain whitespace.
- Invalid tags should fail the command with a clear error.

### 2) Storage Model
Keep notes in existing tables and add normalized tag tables to avoid JSON queries.

New tables (proposed):
- `file_annotation_tags(path, tag_key, tag_value, created_at, updated_at)`
- `symbol_annotation_tags(path, symbol_name, symbol_kind, parent_name, signature,
  tag_key, tag_value, created_at, updated_at)`

Primary keys:
- File tags: `(path, tag_key, tag_value)`
- Symbol tags: `(path, symbol_name, symbol_kind, parent_name, signature, tag_key, tag_value)`

Indexes:
- `(tag_key, tag_value)` for tag listing and filtering.
- `(path)` to support cleanup and joins with files/symbols.

Orphan handling:
- Tags are orphaned the same way notes are. Orphan cleanup should remove both
  note and tag rows for deleted paths/symbols. Default behavior is to keep
  orphaned rows until explicitly pruned.

Schema migration:
- Bump the cache schema version.
- On startup, create new tables/indexes if missing.

### 3) CLI Surface

#### Annotate
Extend `codemap annotate` to support tags without breaking existing usage.

Examples:
- `codemap annotate src/db.ts "Core database" --tag category=command --tag domain=users`
- `codemap annotate src/db.ts --tag category=command` (no note)
- `codemap annotate src/db.ts --clear-tags`
- `codemap annotate src/db.ts --remove-tag category=command`
- `codemap annotate src/db.ts --note "Core database"` (explicit note flag)

Bulk:
- `codemap annotate --glob "sdk/models/*Command*.ts" --tag category=command`
- `codemap annotate --glob "**/*Handler*.ts" --tag category=handler`
- `codemap annotate --auto command --tag category=command` (optional heuristic)
- `codemap annotate --glob "sdk/models/*Command*.ts" --tag category=command --dry-run`

Behavior:
- `--tag` adds tags; duplicates are ignored.
- `--remove-tag` removes specific tags; `--clear-tags` removes all tags on target.
- If neither `--note` nor positional note is provided, only tags are updated.
- `--note` takes precedence over a positional note. If both are provided and differ,
  return an error to avoid ambiguity.
- `--dry-run` prints planned changes without writing to the cache.

#### List Annotations
Extend `codemap annotations`:
- `codemap annotations --tag category=command`
- `codemap annotations --kinds class,enum,interface`
- `codemap annotations --scope files|symbols|all`
- `codemap annotations --unannotated` (no notes or tags)
- `codemap annotations --orphans`
- `codemap annotations --summary` (counts by scope and tag key)

#### Tag Listing
New command for discovery:
- `codemap tags`
- `codemap tags --filter category`
- `codemap tags --scope files|symbols|all`

Output includes counts per scope:
```
category=command (42 files, 61 symbols)
category=handler (12 files, 17 symbols)
```

#### Map Output Filters
Add new flags for main `codemap` output:
- `--annotated` (only files/symbols with notes or tags)
- `--annotations-only` (output only annotations, no symbol list)
- `--filter-tag category=command` (repeatable; AND semantics)
- `--filter-tag-any category=command` (repeatable; OR semantics)
- `--kinds class,enum,interface`
- `--group-by tag:category` or `--group-by tag:domain`

### 4) Export
Add `codemap export` for compact index generation:
- `codemap export --format json --output .codemap/index.json`
- `codemap export --format markdown --output .codemap/index.md`
- Default export includes annotated items only; `--all` includes everything.

Minimal JSON schema:
```json
{
  "files": [
    {
      "path": "sdk/models/ExampleCommand.ts",
      "note": "Core command",
      "tags": { "category": ["command"], "domain": ["users"] },
      "symbols": [
        {
          "name": "ExampleCommand",
          "kind": "class",
          "note": "Command class",
          "tags": { "category": ["command"] }
        }
      ]
    }
  ]
}
```

Markdown export should be one file per export with deterministic ordering
(path, then symbol name) to keep diffs stable.

### 5) Coverage and Drift
- `codemap annotations --unannotated` should include files without notes or tags.
- `codemap annotations --summary` should show counts for notes and tags by scope.
- Orphan removal should delete both note and tag rows, but only on explicit prune
  commands (default is no pruning).

### 6) Backwards Compatibility
- Existing notes and commands continue to work with no changes.
- New tag flags are optional; no tags in output unless requested.
- JSON output keeps `annotation` fields and adds `tags` when present.
- `tags` should be omitted when empty and use deterministic ordering for keys
  and values when present.

### 7) Performance and Caching
- Tag queries should use indexes on `(tag_key, tag_value)` and `(path)`.
- Default codemap output should not do extra tag joins unless requested.
- `--group-by tag:*` should include items in all matching tag groups when multiple
  values exist for the key.

## Suggested Tagging Conventions (Generic)
- `category=command`
- `category=callback`
- `category=resource`
- `category=enum`
- `domain=users|billing|messaging|storage|reports`

## Maintenance Workflow
1. Weekly or per release: `codemap annotations --unannotated` and tag new files.
2. Before agent tasks: `codemap tags` to discover categories and query.
3. Prompt building: `codemap export --format markdown --output .codemap/index.md`.
4. Cleanup: `codemap annotations --orphans` after large refactors.

## Files to Update
- `src/cache/schema.ts` (new tag tables + indexes)
- `src/cache/annotations.ts` (CRUD for tag storage and queries)
- `src/cli.ts` (new flags/commands)
- `src/types.ts` (output types add `tags`)
- `src/render.ts` (include tags when requested)
- `README.md` (document tags, filters, and export)
- `docs/design/annotation-design.md` (keep in sync)

## Open Questions
None.
