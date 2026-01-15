# Codemap

Codemap generates a compact, token-aware map of a codebase: files, symbols, and markdown structure. Designed for feeding context to LLMs and coding agents.

## Supported Languages

- **TypeScript/JavaScript**: Full symbol extraction (functions, classes, interfaces, types, variables, methods, etc.) and cross-file reference tracking
- **C/C++**: Symbol extraction (namespaces, classes, structs, methods, fields, enums) and `#include` dependency tracking
- **Markdown**: Headings and code block ranges
- **Other files**: Listed with line counts (no symbol extraction)

### C++ Notes

C++ support uses [tree-sitter-cpp](https://github.com/tree-sitter/tree-sitter-cpp) for parsing.

**`[exported]` marker meaning:**
- Class members: `[exported]` = `public` access
- Free functions: `[exported]` = external linkage (no `static` keyword)
- `static` functions have internal linkage and are NOT marked exported

**Limitations:**
- **Node.js only**: C++ extraction is disabled when running under Bun (tree-sitter native modules don't work with Bun)
- **No cross-file references**: Reference commands (`find-refs`, `callers`, `call-graph`) only work for TypeScript/JavaScript
- **Include resolution**: Local includes (`"header.hpp"`) are resolved relative to the source file; system includes (`<vector>`) are tracked but not resolved
- **Declaration-only**: Extracts declarations from headers; doesn't follow includes to build full type information

To disable C++ support (faster startup if not needed): `CODEMAP_DISABLE_CPP=1`

## Install

```bash
npm install
npm run build
```

Optional: build a standalone Bun binary (local use only):

```bash
npm run build:bun
./dist/codemap --help
```

## Quick Start

```bash
# Map the current directory
codemap

# Map specific files
codemap "src/**/*.ts"

# Fit output to a token budget (auto-reduces detail)
codemap --budget 4000

# JSON output for programmatic use
codemap -o json
```

## Using with AI Agents

Codemap output is designed to give agents a quick overview of your codebase structure.

See [examples/chat-answer-no-file-reads.txt](examples/chat-answer-no-file-reads.txt) for a real session where an agent answers questions about the codebase using only the codemap output (no file reads needed).

### Building a Prompt File

The safest approach is to build a prompt file, then pass it to your agent:

```bash
# Create prompt with context + instructions
echo "# Codebase Context" > prompt.md
echo "" >> prompt.md
codemap --budget 6000 >> prompt.md
echo "" >> prompt.md
echo "# Task" >> prompt.md
echo "Refactor the auth module to use JWT tokens." >> prompt.md

# Pass to Codex
codex "$(cat prompt.md)"

# Or Claude Code
cat prompt.md | claude

# Or copy to clipboard (macOS)
cat prompt.md | pbcopy
```

### Quick One-Liner (Small Repos)

For small outputs without special characters:

```bash
codemap "src/auth.ts" > /tmp/ctx.txt && codex "$(cat /tmp/ctx.txt) - add rate limiting"
```

### Token Budget and Detail Levels

Use `--budget` to auto-fit output to a token limit. Codemap progressively reduces detail for the largest files until the output fits.

```bash
# Fit to 8K tokens
codemap --budget 8000

# Tighter budget with less metadata
codemap --budget 2000 --no-comments --no-imports
```

**Detail levels** (applied per-file, largest files reduced first):

| Level | Includes |
|-------|----------|
| `full` | Full signatures, JSDoc comments, nested members |
| `standard` | Full signatures, truncated comments (160 chars) |
| `compact` | Full signatures, no comments |
| `minimal` | Names only (no signatures/types), no comments |
| `outline` | File path and line range only |

**Example progression** for a file as budget shrinks:

```
# full - complete signatures and types
src/auth.ts [1-200]
  function:
    15-45: validateToken(token: string, options?: ValidateOptions): Promise<TokenPayload | null> [exported]
      /** Validates a JWT token and returns the payload if valid, null if expired or invalid. */

# minimal - just names
src/auth.ts [1-200]
  function:
    15-45: validateToken [exported]

# outline - file only
src/auth.ts [1-200]
```

The algorithm reduces the largest file first, then the next largest, cycling through until the budget is met or all files are at `outline` level.

## CLI Reference

```bash
codemap [patterns...] [options]

Patterns:
  Glob patterns to include (e.g., "src/**/*.ts" "lib/*.js")

Options:
  -C, --dir              Target directory (default: cwd)
  -o, --output           Output format: text | json (default: text)
  --budget               Token budget (auto-reduces detail to fit)
  --ignore               Ignore patterns (repeatable)
  --exported-only        Only include exported symbols
  --no-comments          Exclude JSDoc comments
  --no-imports           Exclude import lists
  --no-headings          Exclude markdown headings
  --no-code-blocks       Exclude markdown code block ranges
  --no-stats             Exclude project statistics header
  --no-annotations       Exclude annotations from output
  --refs                 Include references (incoming). Use --refs=full for read/write refs
  --refs-in              Include incoming references
  --refs-out             Include outgoing references
  --max-refs             Max references per symbol in output
  --force-refs           Force re-extraction of references
  --no-cache             Force full re-extraction (ignore cache)
  --tsconfig             Path to tsconfig.json or jsconfig.json
  --no-tsconfig          Disable tsconfig-based resolution
```

### Dependency Trees

The `deps` command analyzes import/export statements to build a dependency graph. It resolves:

- Relative imports (`./utils`, `../lib/db`)
- TypeScript path mappings (`@lib/utils` via `tsconfig.json` paths)
- Node.js builtins (`node:fs`, `path`)
- External packages (`react`, `lodash`)
- Dynamic imports and require() calls

```bash
# Show dependency tree for a file
codemap deps src/index.ts

# Reverse dependencies (who imports this file)
codemap deps --reverse src/db.ts

# Limit depth
codemap deps --depth 3 src/cli.ts

# List external packages used in the project
codemap deps --external

# Find circular dependencies
codemap deps --circular

# Combine flags
codemap deps --external --circular

# JSON output
codemap deps src/cli.ts -o json
```

**Example output:**

```
src/cli.ts
  - src/cache/db.ts
    - src/types.ts
    - [external] better-sqlite3
    - [builtin] fs
  - src/render.ts
    - src/types.ts
  - [builtin] path
  - [external] yargs
```

Circular dependencies are marked:
```
src/a.ts
  - src/b.ts
    - src/c.ts
      - src/a.ts (circular ref)
```

### References (Cross-File Symbol Tracking)

Reference tracking finds where symbols are used across your codebase. Use cases:
- "Find all usages" - who calls this function? where is this type used?
- Call graphs - what does this function call? who calls it?
- Type hierarchy - what extends/implements this class/interface?

**Reference kinds tracked:**

| Kind | Example |
|------|---------|
| `import` | `import { foo } from './bar'` |
| `reexport` | `export { foo } from './bar'` |
| `call` | `foo()`, `obj.method()` |
| `instantiate` | `new MyClass()` |
| `type` | `const x: MyType`, `function f(): MyType` |
| `extends` | `class A extends B` |
| `implements` | `class A implements I` |
| `read` | `const x = y` (full mode only) |
| `write` | `x = 5` (full mode only) |

**Basic usage:**

```bash
# Include incoming refs in source map output
codemap "src/**/*.ts" --refs

# Include outgoing refs
codemap "src/**/*.ts" --refs-out

# Both directions
codemap "src/**/*.ts" --refs --refs-in --refs-out

# Include read/write refs (noisier)
codemap "src/**/*.ts" --refs=full

# Limit refs shown per symbol
codemap "src/**/*.ts" --refs --max-refs 5

# Pre-populate cache with refs (without output)
codemap index --refs
```

**Find all usages of a symbol:**

```bash
codemap find-refs CacheDB
```

```
incoming refs for src/cache/db.ts:class CacheDB: 36 [import: 6, instantiate: 1, reexport: 1, type: 28]
- src/deps/tree.ts:1: import (module)
- src/deps/tree.ts:28: type buildForwardNode
- src/refs/update.ts:78: instantiate symbolIndex
- src/sourceMap.ts:266: type buildEntriesFromCache
...
```

Target symbols by path:name for disambiguation:

```bash
codemap find-refs src/cache/db.ts:openCache
codemap find-refs src/types.ts:ReferenceKind:type
```

**Call graph queries:**

```bash
# What does this function call?
codemap calls refreshCache
```

```
calls from src/sourceMap.ts:function refreshCache: 8 [call: 8]
- src/sourceMap.ts:572: call CacheDB.ensureExtractorVersion -> src/cache/db.ts
- src/sourceMap.ts:611: call updateCache -> src/sourceMap.ts
- src/sourceMap.ts:614: call updateReferences -> src/refs/update.ts
...
```

```bash
# Who calls this function?
codemap callers openCache
```

```
callers of src/cache/db.ts:function openCache: 12 [call: 12]
- src/cli.ts:651: call db
- src/cli.ts:659: call db
- src/sourceMap.ts:571: call db
...
```

```bash
# Tree view with depth control
codemap call-graph refreshCache --depth 2
```

```
src/sourceMap.ts:function refreshCache
  - src/cache/db.ts:method ensureExtractorVersion
    - src/cache/db.ts:method clearFiles
    - src/cache/meta.ts:function setMeta
  - src/sourceMap.ts:function updateCache
    - src/cache/db.ts:method updateLastUpdated
    - src/sourceMap.ts:function extractFileForCache
  - src/refs/update.ts:function updateReferences
    - src/cache/db.ts:method deleteRefState
    - src/refs/update.ts:variable clearRefs
```

```bash
# Reverse call graph (callers tree)
codemap call-graph openCache --callers --depth 2
```

**Type hierarchy:**

```bash
# What extends/implements this class/interface?
codemap subtypes MyBaseClass

# What does this class extend/implement?
codemap supertypes MyClass
```

**JSON output:**

```bash
codemap find-refs CacheDB -o json
codemap call-graph main -o json
```

```json
{
  "symbol": "src/cache/db.ts:class CacheDB",
  "refs": {
    "total": 36,
    "sampled": 36,
    "byKind": { "import": 6, "instantiate": 1, "reexport": 1, "type": 28 },
    "items": [...]
  }
}
```

## Caching

Codemap maintains a persistent cache at `.codemap/cache.db` inside each repo. Every run performs a fast scan (mtime/size) and only re-extracts files that changed.

```bash
# View cache statistics
codemap cache

# Clear cache (keeps annotations)
codemap cache clear

# Clear everything including annotations
codemap cache clear --all

# Force full re-extraction on next run
codemap --no-cache
```

- First run populates the cache for the full repo or selected patterns.
- Subsequent runs are incremental unless you pass `--no-cache`.
- Annotations are preserved across cache clears (unless `--all` is used).
- Add `.codemap/` to your `.gitignore`, or commit just the annotations by running `cache clear` first.

## Annotations

Annotations attach persistent notes to files or symbols. They survive reindexing and appear in output.

### File Annotations

```bash
# Add a note to a file
codemap annotate src/db.ts "Core database abstraction layer"

# Update (just run again with new text)
codemap annotate src/db.ts "Updated description"

# Remove
codemap annotate src/db.ts --remove
```

### Symbol Annotations

Symbol targets use the format: `<path>:<name>:<kind>[:<parent>]`

```bash
# Annotate a function
codemap annotate src/auth.ts:validateToken:function "Returns null if expired"

# Annotate a class
codemap annotate src/db.ts:Database:class "Singleton - use getInstance()"

# Annotate a method (specify parent class)
codemap annotate src/db.ts:query:method:Database "Throws on connection failure"

# Remove
codemap annotate src/db.ts:validateToken:function --remove
```

Valid kinds: `function`, `class`, `interface`, `type`, `variable`, `enum`, `enum_member`, `method`, `property`, `constructor`, `getter`, `setter`

### Listing Annotations

```bash
# List all annotations
codemap annotations

# Filter by file
codemap annotations src/db.ts
```

### How Annotations Appear

Text output:
```
src/db.ts [1-250]
  [note: Core database abstraction layer]
  class:
    15-120: Database
      [note: Singleton - use getInstance()]
```

JSON output includes `"annotation"` fields on files and symbols.

### Orphaned Annotations

When files or symbols are renamed/deleted, their annotations become orphaned but preserved. This allows annotations to reconnect if files are restored.

```bash
# Check for orphans
codemap cache
# Shows: orphaned: 2

# To remove all annotations (including orphaned)
codemap cache clear --all
```

## Output Examples

### Text Output (default)

```
# Project Overview

## Languages
- typescript: 15 files
- markdown: 3 files

## Statistics
- Total files: 18
- Total symbols: 142

---

src/index.ts [1-45]
  function:
    12-25: main(): Promise<void> [exported]
    27-45: parseArgs(argv: string[]): Config [exported]
  imports:
    - ./config.js
    - ./server.js

src/server.ts [1-200]
  class:
    15-180: Server [exported]
      constructor:
        20-35: constructor(config: Config)
      method:
        40-80: start(): Promise<void>
        85-120: stop(): Promise<void>
  ...

---
Files: 18
Estimated tokens: 1,847
```

### JSON Output

```bash
codemap -o json | jq '.files[0]'
```

```json
{
  "path": "src/index.ts",
  "language": "typescript",
  "lines": [1, 45],
  "annotation": null,
  "symbols": [
    {
      "name": "main",
      "kind": "function",
      "signature": "main(): Promise<void>",
      "lines": [12, 25],
      "exported": true,
      "annotation": null
    }
  ],
  "imports": ["./config.js", "./server.js"]
}
```

## Programmatic API

Codemap can be used as a library in your own tools:

```bash
npm install codemap
```

```typescript
import { generateSourceMap, renderText, renderJson } from "codemap";

const result = generateSourceMap({
  repoRoot: process.cwd(),
  patterns: ["src/**/*.ts"],
  ignore: ["**/*.test.ts"],
  includeComments: true,
  includeImports: true,
  includeHeadings: true,
  includeCodeBlocks: true,
  includeStats: true,
  includeAnnotations: true,
  exportedOnly: false,
  tokenBudget: 8000,        // optional
  useCache: true,           // default
  forceRefresh: false,      // default
});

// Render as text or JSON
console.log(renderText(result, { repoRoot: process.cwd(), /* ... */ }));
console.log(renderJson(result));

// Or access structured data directly
for (const file of result.files) {
  console.log(file.path, file.symbols.length, "symbols");
  for (const sym of file.symbols) {
    console.log(`  ${sym.kind}: ${sym.name}`);
  }
}
```

### Additional Exports

Lower-level functions for custom integrations:

```typescript
import {
  // Core extraction
  extractFileSymbols,      // Extract symbols from a single TS/JS file
  extractMarkdownStructure, // Extract headings/code blocks from markdown
  discoverFiles,           // Find files matching patterns
  
  // Utilities
  detectLanguage,          // Detect language from file path
  canExtractSymbols,       // Check if language supports symbol extraction
  computeStats,            // Compute project statistics
} from "codemap";

// Types
import type {
  SourceMapResult,
  SourceMapOptions,
  FileEntry,
  SymbolEntry,
  SymbolKind,
  DetailLevel,
} from "codemap";
```

### Dependency Graph API

For programmatic access to dependency information:

```typescript
import { 
  openCache,
  buildDependencyTree,
  buildReverseDependencyTree,
  findCircularDependencies,
  renderDependencyTree 
} from "codemap";
import type { CacheDB, DependencyTreeNode } from "codemap";

// Open the cache (creates/updates as needed)
const db = openCache(process.cwd());

// Get direct dependencies of a file
const deps = db.getDependencies("src/index.ts");
// => ["src/utils.ts", "src/config.ts"]

// Get files that import a given file
const dependents = db.getDependents("src/utils.ts");
// => ["src/index.ts", "src/cli.ts"]

// Get resolved import details
const imports = db.getResolvedImports("src/index.ts");
for (const imp of imports) {
  console.log(imp.source);        // "./utils" or "react"
  console.log(imp.resolved_path); // "src/utils.ts" or null (external)
  console.log(imp.is_external);   // 0 or 1
  console.log(imp.package_name);  // "react" for externals
  console.log(imp.kind);          // "import", "export_from", "dynamic_import", "require"
}

// List all external packages
const external = db.listExternalPackages();
// => ["react", "lodash", "express"]

// Build dependency trees
const tree = buildDependencyTree(db, "src/index.ts", 5); // max depth 5
const reverse = buildReverseDependencyTree(db, "src/utils.ts", 3);

// Detect circular dependencies
const cycles = findCircularDependencies(db);
// => [["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"]]

// Render tree as text
console.log(renderDependencyTree(tree));

db.close();
```

## Tips

### Focusing on What Matters

```bash
# Only exported API surface
codemap --exported-only

# Specific directory
codemap "src/api/**/*.ts"

# Exclude tests and mocks
codemap --ignore "**/*.test.ts" --ignore "**/mocks/**"
```

### Combining with Other Tools

```bash
# Find files with TODOs, then map them
codemap $(grep -rl "TODO" src/)

# Map only recently changed files
codemap $(git diff --name-only HEAD~5)
```

### Agent Workflow Example

```bash
# 1. Add annotations for important context (one-time setup)
codemap annotate src/db.ts "PostgreSQL, pool size 10"
codemap annotate src/auth.ts:hashPassword:function "bcrypt, cost 12"

# 2. Build a prompt file
echo "# Project Context" > prompt.md
codemap --budget 6000 >> prompt.md
echo "" >> prompt.md
echo "# Task" >> prompt.md
echo "Add rate limiting to the API endpoints." >> prompt.md

# 3. Send to agent
codex "$(cat prompt.md)"
```

## Roadmap

### Dependency Analysis
- [ ] Support glob patterns in `deps` command (`codemap deps "src/**/*.ts"`)
- [ ] Support `deps` with no argument to show all files' direct dependencies

## License

MIT
