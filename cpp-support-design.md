# C++ Support Design Document

## Overview

Add C++ language support to codemap using native tree-sitter bindings for parsing. This enables symbol extraction (functions, classes, structs, enums, namespaces) and include dependency tracking for C++ codebases.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        sourceMap.ts                              │
│                    extractFileForCache()                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │   languages.ts      │
                    │ canExtractSymbols() │
                    └─────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │   symbols.ts    │             │ symbols-cpp.ts  │  ← NEW
    │   (TS/JS)       │             │ (C++)           │
    │   ts-morph      │             │ tree-sitter     │
    └─────────────────┘             └─────────────────┘
              │                               │
              ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │ extract-imports │             │extract-includes │  ← NEW
    │     (TS/JS)     │             │     (C++)       │
    └─────────────────┘             └─────────────────┘
```

## Components

### 1. Type Extensions (`src/types.ts`)

```typescript
// Add to Language union
export type Language =
  | "typescript"
  | "javascript"
  | "markdown"
  | "cpp"           // ← Add
  | "other";

// Add C++ specific symbol kinds
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "enum"
  | "enum_member"
  | "method"
  | "property"
  | "constructor"
  | "getter"
  | "setter"
  | "namespace"     // ← Add (C++ namespaces)
  | "struct"        // ← Add (distinguish from class)
  | "destructor";   // ← Add (C++ specific)

// Add C++ include kinds (used in resolved_imports)
export type ImportKind =
  | "import"
  | "export_from"
  | "dynamic_import"
  | "require"
  | "side_effect"
  | "include";      // ← Add

// Add include resolution method
export type ResolutionMethod =
  | "relative"
  | "paths"
  | "baseUrl"
  | "ts"
  | "node"
  | "include";      // ← Add
```

### 2. Language Detection (`src/languages.ts`)

```typescript
const EXTENSION_MAP: Record<string, Language> = {
  // Existing...
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".cc": "cpp",
  ".c++": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".hh": "cpp",
  ".h++": "cpp",
  ".h": "cpp",      // Assume C++ for .h (common in C++ projects)
};

export function canExtractSymbols(language: Language): boolean {
  return language === "typescript"
      || language === "javascript"
      || language === "cpp";  // ← Add
}

// Note: .h is treated as C++ by default; some C headers may parse imperfectly.
```

### 3. C++ Symbol Extractor (`src/symbols-cpp.ts`) - NEW

**Dependencies:**
- `tree-sitter` - native parser runtime
- `tree-sitter-cpp` - C++ grammar

**Exported Functions:**
```typescript
export function extractCppSymbols(
  filePath: string,
  content: string,
  opts?: { includeComments?: boolean }
): { symbols: SymbolEntry[]; includes: IncludeSpec[] };
```

**Parser initialization:**
- `const parser = new Parser();`
- `parser.setLanguage(CppLanguage);`

**Tree-sitter Node Types to Handle:**

| C++ Construct | Tree-sitter Node Type | Output SymbolKind |
|---------------|----------------------|-------------------|
| `namespace foo {}` | `namespace_definition` | `namespace` |
| `class Foo {}` | `class_specifier` | `class` |
| `struct Bar {}` | `struct_specifier` | `struct` |
| `enum Color {}` | `enum_specifier` | `enum` |
| `void foo() {}` | `function_definition` | `function` |
| `void foo();` | `declaration` (function) | `function` |
| `void Cls::method() {}` | `function_definition` | `method` |
| `Cls() {}` | `function_definition` | `constructor` |
| `~Cls() {}` | `function_definition` | `destructor` |
| `int x;` (class member) | `field_declaration` | `property` |
| `typedef int MyInt;` | `type_definition` | `type` |
| `using MyInt = int;` | `alias_declaration` | `type` |
| `enum { A, B }` members | `enumerator` | `enum_member` |

**Signature Extraction:**

For each symbol, extract the full signature as it appears in source:

```cpp
// Source
template<typename T>
virtual bool process(const std::vector<T>& items) const override;

// Extracted signature
"template<typename T> virtual bool process(const std::vector<T>& items) const override"
```

Key elements to capture:
- Template declarations (`template<...>`)
- Storage class (`static`, `extern`, `inline`)
- Qualifiers (`virtual`, `explicit`, `constexpr`)
- Return type
- Name and parameters
- CV-qualifiers (`const`, `volatile`)
- Ref-qualifiers (`&`, `&&`)
- Specifiers (`override`, `final`, `noexcept`)

**Hierarchy Handling:**

C++ has nested scopes. The extractor should:
1. Track namespace/class context while walking
2. Set `parentName` to the fully qualified parent key (e.g., `utils::Parser`)
3. Keep symbols flat; rendering groups children by parent key (applies to TS/JS too)

```typescript
// Example output structure
{
  name: "Parser",
  kind: "class",
  signature: "class Parser",
  children: [
    { name: "Parser", kind: "constructor", signature: "Parser()", parentName: "Parser" },
    { name: "parse", kind: "method", signature: "bool parse(const string& input)", parentName: "Parser" },
    { name: "m_data", kind: "property", signature: "int m_data", parentName: "Parser" }
  ]
}
```

For nested scopes, `parentName` uses the full key (e.g., method parentName is `utils::Parser`).

### 4. Include Extraction (`src/deps/extract-includes.ts`) - NEW

**Purpose:** Parse `#include` directives from C++ files.

```typescript
export type IncludeSpec = {
  source: string;           // e.g., "vector", "myheader.h"
  kind: "system" | "local"; // <...> vs "..."
  line: number;
};

export function extractIncludes(content: string): IncludeSpec[];
```

**Parsing approach:**
- Use regex or tree-sitter's `preproc_include` node
- Distinguish `<header>` (system) from `"header"` (local)

```cpp
#include <vector>           // { source: "vector", kind: "system" }
#include <sys/types.h>      // { source: "sys/types.h", kind: "system" }
#include "myheader.h"       // { source: "myheader.h", kind: "local" }
#include "../utils/foo.hpp" // { source: "../utils/foo.hpp", kind: "local" }
```

### 5. Include Resolution (`src/deps/cpp-resolver.ts`) - NEW (Phase 1 minimal)

**Purpose:** Resolve include paths to actual files in the repository.

```typescript
export function resolveIncludes(
  importerPath: string,
  includes: IncludeSpec[],
  ctx: CppResolverContext
): ResolvedImport[];
```

**Resolution strategy:**
1. **Local includes (`"..."`):**
   - Search relative to including file's directory
   - Then search include paths
2. **System includes (`<...>`):**
   - Search include paths only
   - Mark standard library headers as `isBuiltin: true`

**Include path sources (future):**
- `compile_commands.json` (CMake, Meson, etc.)
- `.clangd` configuration
- Manual configuration

**Initial implementation:** Resolve local includes relative to file, mark system includes as external/builtin. Use `kind: "include"` and `resolutionMethod: "include"` (or `relative` for file-relative hits) in `ResolvedImport`.

## Integration Points

### sourceMap.ts Changes

In `extractFileForCache()` (~line 176):

```typescript
// Current logic
if (canExtractSymbols(language)) {
  // calls extractFileSymbolsDetailed() for TS/JS
}

// Updated logic
if (canExtractSymbols(language)) {
  if (language === "cpp") {
    const result = extractCppSymbols(fullPath, content, { includeComments });
    // Convert to SymbolRow[]
    // Map IncludeSpec[] to imports (string list) and resolvedImports via resolveIncludes()
  } else {
    // Existing TS/JS path
  }
}
```

Also update `extractFileEntryNoCache()` and the public `extractFileSymbols()` path to call the C++ extractor when `language === "cpp"`.

### References

`updateReferences()` uses ts-morph and should only run for TS/JS. Add a new guard (e.g., `canExtractReferences`) or explicit filter to avoid passing C++ files into ts-morph.

### Cache Schema

Schema changes are required due to CHECK constraints:
- `files.language` must allow `cpp`
- `symbols.kind` must allow `namespace`, `struct`, `destructor`
This requires a schema version bump and a migration to rebuild these tables with the expanded checks.

### Rendering

`render.ts` needs updates for:
- Parent key grouping (use fully qualified keys when attaching children)
- New symbol kinds in group order and label formatting (`namespace`, `struct`, `destructor`)
- Container kinds for nested output (`namespace`, `class`, `struct`, `enum`)
- Optional: label C++ includes as `includes` instead of `imports`

## Data Flow Example

```
Input: src/parser.cpp
─────────────────────────────────────────────
#include <string>
#include "types.h"

namespace utils {
  class Parser {
  public:
    bool parse(const std::string& input);
  private:
    int m_count = 0;
  };
}
─────────────────────────────────────────────

                    │
                    ▼
           tree-sitter parse
                    │
                    ▼

Symbols extracted:
─────────────────────────────────────────────
[
  {
    name: "utils",
    kind: "namespace",
    signature: "namespace utils",
    startLine: 4, endLine: 12,
    children: [
      {
        name: "Parser",
        kind: "class",
        signature: "class Parser",
        startLine: 5, endLine: 11,
        parentName: "utils",
        children: [
          {
            name: "parse",
            kind: "method",
            signature: "bool parse(const std::string& input)",
            startLine: 7, endLine: 7,
            parentName: "utils::Parser",
            exported: true  // public
          },
          {
            name: "m_count",
            kind: "property",
            signature: "int m_count = 0",
            startLine: 9, endLine: 9,
            parentName: "utils::Parser",
            exported: false  // private
          }
        ]
      }
    ]
  }
]
─────────────────────────────────────────────

Includes extracted:
─────────────────────────────────────────────
[
  { source: "string", kind: "system", line: 1 },
  { source: "types.h", kind: "local", line: 2 }
]
─────────────────────────────────────────────

                    │
                    ▼
            Rendered output

src/parser.cpp [1-12]
  namespace:
    4-12: namespace utils
  class:
    5-11: class Parser [exported]
      7-7: bool parse(const std::string& input) [exported]
      9-9: int m_count = 0
  includes:
    - <string>
    - "types.h"
```

## Edge Cases

### 1. Header vs Implementation Files
- `.h` files often contain declarations only (no function bodies)
- `.cpp` files contain definitions
- Both should be indexed; declarations show signatures, definitions show full span

### 2. Templates
```cpp
template<typename T, typename U = int>
class Container { ... };
```
- Extract full template parameter list in signature
- Template specializations are separate symbols

### 3. Macros
```cpp
#define API_EXPORT __declspec(dllexport)
API_EXPORT void foo();
```
- Tree-sitter sees macros as-is (unexpanded)
- `API_EXPORT void foo()` is the signature (acceptable)

### 4. Anonymous Constructs
```cpp
struct { int x; } instance;      // Anonymous struct
enum { A, B, C };                // Anonymous enum
namespace { void helper(); }    // Anonymous namespace
```
- Use placeholder names like `<anonymous>` or skip

### 5. Forward Declarations
```cpp
class Foo;  // Forward declaration
class Foo { ... };  // Definition
```
- Both appear as symbols; forward decl has minimal signature

### 6. Extern "C"
```cpp
extern "C" {
  void c_function();
}
```
- Extract functions inside, note linkage in signature if desired

## Dependencies

```json
{
  "dependencies": {
    "tree-sitter": "^0.21.1",
    "tree-sitter-cpp": "^0.22.0"
  }
}
```

Note: tree-sitter uses native bindings and requires Node/Bun native module support.

## Testing Strategy

1. **Unit tests** (`tests/symbols-cpp.test.ts`):
   - Test each symbol kind extraction
   - Test nested structures (namespace > class > method)
   - Test signature extraction accuracy
   - Test edge cases (templates, macros, anonymous)

2. **Integration tests** (`tests/cpp-integration.test.ts`):
   - Create temp C++ project
   - Run full `generateSourceMap()`
   - Verify output structure
   - Smoke test parser init in Node and Bun

3. **Manual testing**:
   - Run against real C++ projects (e.g., a small open source lib)
   - Compare output readability

## Future Enhancements (Out of Scope)

1. **Reference extraction** - Track function calls, type usage across files
2. **Compile commands integration** - Read `compile_commands.json` for accurate include paths
3. **Semantic analysis** - Use clangd for type resolution, go-to-definition
4. **C support** - Separate `"c"` language type with C-specific handling
