# Codemap

Codemap generates a compact, token-aware map of a codebase: files, symbols, and markdown structure.

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

## Usage

```bash
# Run on the current directory
node dist/cli.js

# JSON output with a token budget
node dist/cli.js --output json --budget 2000

# Limit to specific files
node dist/cli.js "src/**/*.ts" --ignore "**/*.test.ts"

# Run the local package from any folder (after build)
npx /path/to/repo --help

# Optional: link a global-style command
npm link
codemap --help
```

## Programmatic API

```typescript
import { generateSourceMap, renderText } from "codemap";

const result = generateSourceMap({
  repoRoot: process.cwd(),
  includeComments: true,
  includeImports: true,
  includeHeadings: true,
  includeCodeBlocks: true,
  includeStats: true,
  exportedOnly: false,
  output: "text",
});

console.log(renderText(result, {
  repoRoot: process.cwd(),
  includeComments: true,
  includeImports: true,
  includeHeadings: true,
  includeCodeBlocks: true,
  includeStats: true,
  exportedOnly: false,
  output: "text",
}));
```
