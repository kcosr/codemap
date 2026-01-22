#!/usr/bin/env node
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { generateSourceMap, refreshCache } from "./sourceMap.js";
import { renderText, renderJson } from "./render.js";
import { openCache } from "./cache/db.js";
import type { CacheStats } from "./cache/db.js";
import type { SymbolKind, ReferenceList } from "./types.js";
import type { SymbolRowWithId } from "./cache/db.js";
import {
  buildDependencyTree,
  buildReverseDependencyTree,
  findCircularDependencies,
  renderDependencyTree,
} from "./deps/tree.js";
import { STRUCTURAL_REF_KINDS } from "./cache/references.js";
import {
  buildCallGraph,
  buildCallersGraph,
  renderCallGraph,
} from "./refs/call-graph.js";
import {
  buildSubtypeHierarchy,
  buildSupertypeHierarchy,
  renderTypeHierarchy,
} from "./refs/type-hierarchy.js";

const SYMBOL_KINDS = new Set<SymbolKind>([
  "function",
  "class",
  "interface",
  "type",
  "variable",
  "enum",
  "enum_member",
  "method",
  "property",
  "constructor",
  "getter",
  "setter",
  "namespace",
  "struct",
  "destructor",
]);

type ParsedTarget = {
  path: string;
  symbol?: {
    name: string;
    kind: string;
    parentName?: string | null;
    signature?: string | null;
  };
};

function toPosixPath(inputPath: string): string {
  return inputPath.split(path.sep).join("/");
}

function normalizeRepoPath(repoRoot: string, inputPath: string): string {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, inputPath);
  const relative = path.relative(root, resolved);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return toPosixPath(relative || ".");
  }
  return toPosixPath(inputPath);
}

function normalizeAnnotationPath(repoRoot: string, inputPath: string): string {
  return normalizeRepoPath(repoRoot, inputPath);
}

function parseAnnotationTarget(raw: string): ParsedTarget {
  const trimmed = raw.trim();
  const parts = trimmed.split(":");
  if (parts.length < 3) {
    return { path: trimmed };
  }

  const [filePath, name, kind, ...rest] = parts;
  if (!name || !kind) {
    return { path: trimmed };
  }

  let parentName: string | null = null;
  let signature: string | null = null;

  if (rest.length > 0) {
    const remainder = rest.join(":");
    const match = remainder.match(/^([^()]+)\((.*)\)$/);
    if (match) {
      parentName = match[1];
      signature = match[2];
    } else if (remainder.length > 0) {
      if (remainder.includes("(")) {
        signature = remainder;
      } else {
        parentName = remainder;
      }
    }
  }

  return {
    path: filePath,
    symbol: {
      name,
      kind,
      parentName,
      signature,
    },
  };
}

type SymbolTarget = {
  path?: string | null;
  name: string;
  kind?: string | null;
  parent?: string | null;
};

function parseSymbolTarget(raw: string): SymbolTarget {
  const trimmed = raw.trim();
  const parts = trimmed.split(":");
  if (parts.length === 1) {
    return { name: trimmed };
  }
  if (parts.length === 2) {
    return { path: parts[0], name: parts[1] };
  }
  if (parts.length === 3) {
    return { path: parts[0], name: parts[1], kind: parts[2] };
  }
  const [pathPart, parent, kind, ...rest] = parts;
  return {
    path: pathPart,
    parent,
    kind,
    name: rest.join(":"),
  };
}

function resolveSymbolTarget(
  db: ReturnType<typeof openCache>,
  repoRoot: string,
  raw: string,
): SymbolRowWithId {
  const parsed = parseSymbolTarget(raw);
  const path = parsed.path
    ? normalizeRepoPath(repoRoot, parsed.path)
    : null;
  const matches = db.findSymbols(
    path,
    parsed.name,
    parsed.kind ?? null,
    parsed.parent ?? null,
  );
  if (matches.length === 0) {
    throw new Error(`Symbol not found: ${raw}`);
  }
  if (matches.length > 1) {
    const preview = matches
      .slice(0, 5)
      .map((sym) => formatSymbolLabel(sym))
      .join(", ");
    throw new Error(
      `Multiple symbols matched "${raw}". Be more specific. Matches: ${preview}`,
    );
  }
  return matches[0];
}

function formatSymbolLabel(symbol: SymbolRowWithId): string {
  const parent = symbol.parent_name ? `${symbol.parent_name}.` : "";
  return `${symbol.path}:${symbol.kind} ${parent}${symbol.name}`;
}

function normalizeRefsMode(
  value: unknown,
): "structural" | "full" | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true || value === "" || value === "structural") {
    return "structural";
  }
  if (value === "full") return "full";
  return undefined;
}

function resolveRefsOptions(argv: Record<string, unknown>): {
  includeRefs: boolean;
  refsMode?: "structural" | "full";
  refsDirection?: "in" | "out" | "both";
  maxRefs?: number;
  forceRefs?: boolean;
} {
  const refsMode = normalizeRefsMode(argv.refs);
  const refsIn = Boolean(argv["refs-in"]);
  const refsOut = Boolean(argv["refs-out"]);
  const includeRefs = Boolean(refsMode || refsIn || refsOut);
  const direction = refsIn && refsOut ? "both" : refsOut ? "out" : "in";
  const maxRefs =
    typeof argv["max-refs"] === "number" && argv["max-refs"] > 0
      ? (argv["max-refs"] as number)
      : undefined;

  return {
    includeRefs,
    refsMode: refsMode ?? (includeRefs ? "structural" : undefined),
    refsDirection: direction,
    maxRefs,
    forceRefs: Boolean(argv["force-refs"]),
  };
}

function formatReferenceList(
  refs: ReferenceList,
  label: string,
  direction: "in" | "out",
): string[] {
  const lines: string[] = [];
  const kinds = Object.entries(refs.byKind)
    .filter(([, count]) => count && count > 0)
    .map(([kind, count]) => `${kind}: ${count}`)
    .join(", ");
  let header = `${label}: ${refs.total}`;
  if (refs.sampled < refs.total) {
    header += ` (sampled ${refs.sampled})`;
  }
  if (kinds) {
    header += ` [${kinds}]`;
  }
  lines.push(header);

  for (const item of refs.items) {
    lines.push(`- ${formatReferenceItem(item, direction)}`);
  }

  const hidden = refs.total - refs.items.length;
  if (hidden > 0) {
    lines.push(`... (${hidden} more)`);
  }

  return lines;
}

function formatReferenceItem(
  item: ReferenceList["items"][number],
  direction: "in" | "out",
): string {
  const symbolLabel = item.symbolParent
    ? `${item.symbolParent}.${item.symbolName}`
    : item.symbolName;
  const location = `${item.refPath}:${item.refLine}`;
  if (direction === "in") {
    return `${location}: ${item.refKind} ${symbolLabel}`;
  }
  const target = item.symbolPath ?? "external";
  return `${location}: ${item.refKind} ${symbolLabel} -> ${target}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function renderCacheStats(stats: CacheStats): string {
  const lines: string[] = [];
  lines.push(
    `Cache: ${stats.cachePath} (${formatBytes(stats.sizeBytes)})`,
  );
  lines.push(
    `Last updated: ${stats.meta.lastUpdatedAt ?? "never"}`,
  );
  lines.push(`Extractor: ${stats.meta.extractorVersion ?? "unknown"}`);
  lines.push("");

  lines.push(`Files: ${stats.files.total} cached`);
  for (const [lang, count] of Object.entries(stats.files.byLanguage).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`  - ${lang}: ${count}`);
  }
  lines.push("");

  lines.push(`Symbols: ${stats.symbols.total} total`);
  for (const [kind, count] of Object.entries(stats.symbols.byKind).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`  - ${kind}: ${count}`);
  }
  lines.push("");

  lines.push("Annotations:");
  lines.push(`  - file: ${stats.annotations.file}`);
  lines.push(`  - symbol: ${stats.annotations.symbol}`);
  lines.push(
    `  - orphaned: ${stats.annotations.orphaned}`,
  );

  return lines.join("\n");
}

const cli = yargs(hideBin(process.argv))
  .scriptName("codemap")
  .usage("$0 [patterns...] [options]")
  .option("dir", {
    alias: "C",
    type: "string",
    describe: "Target directory",
    default: process.cwd(),
    global: true,
  })
  .option("ignore", {
    type: "string",
    array: true,
    describe: "Ignore patterns (can be repeated)",
    global: true,
  })
  .command(
    "deps [target]",
    "Show dependency tree",
    (y) =>
      y
        .positional("target", {
          describe: "File path",
          type: "string",
        })
        .option("reverse", {
          type: "boolean",
          default: false,
          describe: "Show reverse dependencies",
        })
        .option("depth", {
          type: "number",
          default: 10,
          describe: "Max depth",
        })
        .option("external", {
          type: "boolean",
          default: false,
          describe: "List external package dependencies",
        })
        .option("circular", {
          type: "boolean",
          default: false,
          describe: "Find circular dependencies",
        })
        .option("output", {
          alias: "o",
          type: "string",
          choices: ["text", "json"] as const,
          default: "text",
          describe: "Output format",
        })
        .option("tsconfig", {
          type: "string",
          describe: "Path to tsconfig.json or jsconfig.json",
        })
        .option("no-tsconfig", {
          type: "boolean",
          default: false,
          describe: "Disable tsconfig-based resolution",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const output = argv.output === "json" ? "json" : "text";

      const refresh = refreshCache({
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeComments: true,
        includeImports: true,
        includeHeadings: false,
        includeCodeBlocks: false,
        includeStats: false,
        includeAnnotations: true,
        exportedOnly: false,
        output: "text",
        useCache: true,
        tsconfigPath: argv.tsconfig
          ? path.resolve(repoRoot, argv.tsconfig as string)
          : undefined,
        useTsconfig: !argv["no-tsconfig"],
      });

      const { db } = refresh;

      const wantsExternal = argv.external;
      const wantsCircular = argv.circular;

      if (wantsExternal || wantsCircular) {
        const externalPackages = wantsExternal ? db.listExternalPackages() : [];
        const cycles = wantsCircular ? findCircularDependencies(db) : [];
        db.close();

        if (output === "json") {
          console.log(
            JSON.stringify(
              {
                externalPackages: wantsExternal ? externalPackages : undefined,
                cycles: wantsCircular ? cycles : undefined,
              },
              null,
              2,
            ),
          );
          return;
        }

        if (wantsExternal) {
          if (externalPackages.length === 0) {
            console.log("No external dependencies found.");
          } else {
            console.log("External packages:");
            for (const pkg of externalPackages) {
              console.log(`- ${pkg}`);
            }
          }
        }

        if (wantsCircular) {
          if (cycles.length === 0) {
            console.log("No circular dependencies found.");
          } else {
            console.log("Circular dependencies:");
            for (const cycle of cycles) {
              console.log(`- ${cycle.join(" -> ")}`);
            }
          }
        }

        return;
      }

      const target = argv.target as string | undefined;
      if (!target) {
        db.close();
        throw new Error("Target path is required unless --external or --circular is set.");
      }

      const normalizedPath = normalizeRepoPath(repoRoot, target);
      const fileRow = db.getFile(normalizedPath);
      if (!fileRow) {
        db.close();
        throw new Error(`File not found in cache: ${normalizedPath}`);
      }

      const maxDepth = Number.isFinite(argv.depth)
        ? (argv.depth as number)
        : 10;
      const tree = argv.reverse
        ? buildReverseDependencyTree(db, normalizedPath, maxDepth)
        : buildDependencyTree(db, normalizedPath, maxDepth);

      db.close();

      if (output === "json") {
        console.log(
          JSON.stringify(
            {
              root: normalizedPath,
              reverse: argv.reverse,
              depth: maxDepth,
              tree,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(renderDependencyTree(tree));
      }
    },
  )
  .command(
    "index [patterns...]",
    "Refresh cache (and optionally references)",
    (y) =>
      y
        .positional("patterns", {
          describe: "File glob patterns to include",
          type: "string",
          array: true,
        })
        .option("ignore", {
          type: "string",
          array: true,
          describe: "Ignore patterns (can be repeated)",
        })
        .option("no-cache", {
          type: "boolean",
          default: false,
          describe: "Force full re-extraction (ignore cache)",
        })
        .option("refs", {
          type: "string",
          describe:
            "Extract references (default structural). Use --refs=full for read/write refs.",
        })
        .option("force-refs", {
          type: "boolean",
          default: false,
          describe: "Force re-extraction of references",
        })
        .option("tsconfig", {
          type: "string",
          describe: "Path to tsconfig.json or jsconfig.json",
        })
        .option("no-tsconfig", {
          type: "boolean",
          default: false,
          describe: "Disable tsconfig-based resolution",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const refsOptions = resolveRefsOptions(argv as Record<string, unknown>);
      const refresh = refreshCache({
        repoRoot,
        patterns: (argv.patterns as string[]) ?? [],
        ignore: argv.ignore as string[] | undefined,
        includeComments: true,
        includeImports: true,
        includeHeadings: true,
        includeCodeBlocks: true,
        includeStats: false,
        includeAnnotations: true,
        exportedOnly: false,
        output: "text",
        forceRefresh: argv["no-cache"],
        useCache: true,
        tsconfigPath: argv.tsconfig
          ? path.resolve(repoRoot, argv.tsconfig as string)
          : undefined,
        useTsconfig: !argv["no-tsconfig"],
        includeRefs: refsOptions.includeRefs,
        refsMode: refsOptions.refsMode,
        refsDirection: refsOptions.refsDirection,
        maxRefs: refsOptions.maxRefs,
        forceRefs: refsOptions.forceRefs,
      });

      refresh.db.close();
      console.log("Cache updated.");
    },
  )
  .command(
    "$0 [patterns...]",
    "Generate code map",
    (y) =>
      y
        .positional("patterns", {
          describe: "File glob patterns to include",
          type: "string",
          array: true,
        })
        .option("output", {
          alias: "o",
          type: "string",
          choices: ["text", "json"] as const,
          default: "text",
          describe: "Output format",
        })
        .option("budget", {
          alias: "b",
          type: "number",
          describe: "Token budget (auto-reduces detail to fit)",
        })
        .option("exported-only", {
          type: "boolean",
          default: false,
          describe: "Only include exported symbols",
        })
        .option("comments", {
          type: "boolean",
          default: true,
          describe: "Include JSDoc comments",
        })
        .option("imports", {
          type: "boolean",
          default: true,
          describe: "Include import lists",
        })
        .option("headings", {
          type: "boolean",
          default: true,
          describe: "Include markdown headings",
        })
        .option("code-blocks", {
          type: "boolean",
          default: true,
          describe: "Include markdown code blocks",
        })
        .option("stats", {
          type: "boolean",
          default: true,
          describe: "Include project statistics",
        })
        .option("annotations", {
          type: "boolean",
          default: true,
          describe: "Include annotations",
        })
        .option("refs", {
          type: "string",
          describe:
            "Include references (default incoming). Use --refs=full for read/write refs.",
        })
        .option("refs-in", {
          type: "boolean",
          default: false,
          describe: "Include incoming references",
        })
        .option("refs-out", {
          type: "boolean",
          default: false,
          describe: "Include outgoing references",
        })
        .option("max-refs", {
          type: "number",
          describe: "Max references per symbol in output",
        })
        .option("force-refs", {
          type: "boolean",
          default: false,
          describe: "Force re-extraction of references",
        })
        .option("no-cache", {
          type: "boolean",
          default: false,
          describe: "Force full re-extraction (ignore cache)",
        })
        .option("tsconfig", {
          type: "string",
          describe: "Path to tsconfig.json or jsconfig.json",
        })
        .option("no-tsconfig", {
          type: "boolean",
          default: false,
          describe: "Disable tsconfig-based resolution",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;

      const output = argv.output === "json" ? "json" : "text";
      const refsOptions = resolveRefsOptions(argv as Record<string, unknown>);

      const opts = {
        repoRoot: repoRoot,
        patterns: (argv.patterns as string[]) ?? [],
        ignore: argv.ignore as string[] | undefined,
        includeComments: argv.comments !== false,
        includeImports: argv.imports !== false,
        includeHeadings: argv.headings !== false,
        includeCodeBlocks: argv["code-blocks"] !== false,
        includeStats: argv.stats !== false,
        includeAnnotations: argv.annotations !== false,
        exportedOnly: argv["exported-only"],
        tokenBudget: argv.budget,
        output,
        forceRefresh: argv["no-cache"],
        useCache: true,
        tsconfigPath: argv.tsconfig
          ? path.resolve(repoRoot, argv.tsconfig as string)
          : undefined,
        useTsconfig: !argv["no-tsconfig"],
        includeRefs: refsOptions.includeRefs,
        refsMode: refsOptions.refsMode,
        refsDirection: refsOptions.refsDirection,
        maxRefs: refsOptions.maxRefs,
        forceRefs: refsOptions.forceRefs,
      } as const;

      const result = generateSourceMap(opts);

      if (output === "json") {
        console.log(renderJson(result));
      } else {
        console.log(renderText(result, opts));
      }
    },
  )
  .command(
    "annotate <target> [note]",
    "Add, update, or remove annotations",
    (y) =>
      y
        .positional("target", {
          describe: "File or symbol target",
          type: "string",
        })
        .positional("note", {
          describe: "Annotation text",
          type: "string",
        })
        .option("remove", {
          type: "boolean",
          default: false,
          describe: "Remove the annotation",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const target = parseAnnotationTarget(argv.target as string);
      const normalizedPath = normalizeAnnotationPath(repoRoot, target.path);
      const note = argv.note as string | undefined;

      const db = openCache(repoRoot);

      if (!target.symbol) {
        if (argv.remove) {
          const removed = db.removeFileAnnotation(normalizedPath);
          db.close();
          console.log(
            removed > 0
              ? `Removed annotation for ${normalizedPath}`
              : `No annotation found for ${normalizedPath}`,
          );
          return;
        }

        if (!note) {
          db.close();
          throw new Error("Annotation text is required.");
        }

        const fileRow = db.getFile(normalizedPath);
        if (!fileRow) {
          db.close();
          throw new Error(
            `File not found in cache: ${normalizedPath}. Run 'codemap' first to index files.`,
          );
        }

        db.setFileAnnotation(normalizedPath, note);
        db.close();
        console.log(`Saved annotation for ${normalizedPath}`);
        return;
      }

      const symbolKey = {
        path: normalizedPath,
        symbolName: target.symbol.name,
        symbolKind: target.symbol.kind,
        parentName: target.symbol.parentName ?? null,
        signature: target.symbol.signature ?? null,
      };

      if (argv.remove) {
        const removed = db.removeSymbolAnnotation(symbolKey);
        db.close();
        console.log(
          removed > 0
            ? `Removed annotation for ${normalizedPath}`
            : `No annotation found for ${normalizedPath}`,
        );
        return;
      }

      if (!note) {
        db.close();
        throw new Error("Annotation text is required.");
      }

      if (!SYMBOL_KINDS.has(symbolKey.symbolKind as SymbolKind)) {
        db.close();
        throw new Error(
          `Unknown symbol kind "${symbolKey.symbolKind}". Expected one of: ${[...SYMBOL_KINDS].join(", ")}.`,
        );
      }

      const symbols = db.findSymbols(
        normalizedPath,
        symbolKey.symbolName,
        symbolKey.symbolKind,
        symbolKey.parentName,
      );
      if (symbols.length === 0) {
        db.close();
        throw new Error(
          `Symbol not found: ${symbolKey.symbolKind} ${symbolKey.symbolName} in ${normalizedPath}. Run 'codemap' first to index files.`,
        );
      }

      db.setSymbolAnnotation(symbolKey, note);
      db.close();
      console.log(`Saved annotation for ${normalizedPath}`);
    },
  )
  .command(
    "annotations [path]",
    "List annotations",
    (y) =>
      y.positional("path", {
        describe: "Optional file path to filter",
        type: "string",
      }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const filterPath = argv.path
        ? normalizeAnnotationPath(repoRoot, argv.path as string)
        : undefined;

      const db = openCache(repoRoot);
      const fileRows = db.listFileAnnotations(filterPath);
      const symbolRows = db.listSymbolAnnotations(filterPath);
      db.close();

      if (fileRows.length === 0 && symbolRows.length === 0) {
        console.log("No annotations found.");
        return;
      }

      if (fileRows.length > 0) {
        console.log("File annotations:");
        for (const row of fileRows) {
          console.log(`- ${row.path}: ${row.note}`);
        }
      }

      if (symbolRows.length > 0) {
        console.log("Symbol annotations:");
        for (const row of symbolRows) {
          let target = `${row.path}:${row.symbol_name}:${row.symbol_kind}`;
          if (row.parent_name && row.signature) {
            target += `:${row.parent_name}(${row.signature})`;
          } else if (row.parent_name) {
            target += `:${row.parent_name}`;
          } else if (row.signature) {
            target += `:${row.signature}`;
          }
          console.log(`- ${target}: ${row.note}`);
        }
      }
    },
  )
  .command(
    "cache [action]",
    "Manage cache (stats, clear)",
    (y) =>
      y
        .positional("action", {
          describe: "Action: stats (default), clear",
          type: "string",
          choices: ["stats", "clear"],
          default: "stats",
        })
        .option("all", {
          type: "boolean",
          default: false,
          describe: "Clear everything including annotations",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const action = argv.action as string;
      const db = openCache(repoRoot);

      if (action === "stats") {
        const stats = db.getCacheStats();
        db.close();
        console.log(renderCacheStats(stats));
        return;
      }

      if (action === "clear") {
        db.clearFiles();
        if (argv.all) {
          db.clearAnnotations();
          console.log("Cache cleared (including annotations).");
        } else {
          console.log("Cache cleared (annotations preserved).");
        }
        db.close();
        return;
      }
    },
  )
  .command(
    "find-refs <target>",
    "Find references to a symbol",
    (y) =>
      y
        .positional("target", {
          describe: "Symbol target (name or path:name[:kind] or path:Parent:kind:member)",
          type: "string",
        })
        .option("output", {
          alias: "o",
          type: "string",
          choices: ["text", "json"] as const,
          default: "text",
          describe: "Output format",
        })
        .option("refs", {
          type: "string",
          describe:
            "Reference mode: structural (default) or full (includes read/write).",
        })
        .option("max-refs", {
          type: "number",
          describe: "Max references to include in output",
        })
        .option("force-refs", {
          type: "boolean",
          default: false,
          describe: "Force re-extraction of references",
        })
        .option("tsconfig", {
          type: "string",
          describe: "Path to tsconfig.json or jsconfig.json",
        })
        .option("no-tsconfig", {
          type: "boolean",
          default: false,
          describe: "Disable tsconfig-based resolution",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const refsOptions = resolveRefsOptions(argv as Record<string, unknown>);
      const refsMode = refsOptions.refsMode ?? "structural";
      const refresh = refreshCache({
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeComments: true,
        includeImports: true,
        includeHeadings: true,
        includeCodeBlocks: true,
        includeStats: false,
        includeAnnotations: true,
        exportedOnly: false,
        output: "text",
        useCache: true,
        forceRefresh: false,
        tsconfigPath: argv.tsconfig
          ? path.resolve(repoRoot, argv.tsconfig as string)
          : undefined,
        useTsconfig: !argv["no-tsconfig"],
        refsMode,
        forceRefs: refsOptions.forceRefs,
      });

      const db = refresh.db;
      const symbol = resolveSymbolTarget(db, repoRoot, argv.target as string);
      const refKinds =
        refsMode === "full" ? undefined : STRUCTURAL_REF_KINDS;
      const refs = db.getReferenceList(
        "in",
        { symbolId: symbol.id },
        refKinds,
        refsOptions.maxRefs,
      );
      db.close();

      if (argv.output === "json") {
        console.log(
          JSON.stringify(
            {
              symbol: formatSymbolLabel(symbol),
              refs,
            },
            null,
            2,
          ),
        );
        return;
      }

      const lines = formatReferenceList(
        refs,
        `incoming refs for ${formatSymbolLabel(symbol)}`,
        "in",
      );
      console.log(lines.join("\n"));
    },
  )
  .command(
    "calls <target>",
    "Show outgoing call references",
    (y) =>
      y
        .positional("target", {
          describe: "Symbol target (name or path:name[:kind])",
          type: "string",
        })
        .option("output", {
          alias: "o",
          type: "string",
          choices: ["text", "json"] as const,
          default: "text",
          describe: "Output format",
        })
        .option("max-refs", {
          type: "number",
          describe: "Max references to include in output",
        })
        .option("force-refs", {
          type: "boolean",
          default: false,
          describe: "Force re-extraction of references",
        })
        .option("tsconfig", {
          type: "string",
          describe: "Path to tsconfig.json or jsconfig.json",
        })
        .option("no-tsconfig", {
          type: "boolean",
          default: false,
          describe: "Disable tsconfig-based resolution",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const refresh = refreshCache({
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeComments: true,
        includeImports: true,
        includeHeadings: true,
        includeCodeBlocks: true,
        includeStats: false,
        includeAnnotations: true,
        exportedOnly: false,
        output: "text",
        useCache: true,
        forceRefresh: false,
        tsconfigPath: argv.tsconfig
          ? path.resolve(repoRoot, argv.tsconfig as string)
          : undefined,
        useTsconfig: !argv["no-tsconfig"],
        refsMode: "structural",
        forceRefs: argv["force-refs"] as boolean,
      });

      const db = refresh.db;
      const symbol = resolveSymbolTarget(db, repoRoot, argv.target as string);
      const refs = db.getReferenceList(
        "out",
        { symbolId: symbol.id },
        ["call", "instantiate"],
        argv["max-refs"] as number | undefined,
      );
      db.close();

      if (argv.output === "json") {
        console.log(
          JSON.stringify(
            {
              symbol: formatSymbolLabel(symbol),
              refs,
            },
            null,
            2,
          ),
        );
        return;
      }

      const lines = formatReferenceList(
        refs,
        `calls from ${formatSymbolLabel(symbol)}`,
        "out",
      );
      console.log(lines.join("\n"));
    },
  )
  .command(
    "callers <target>",
    "Show incoming call references",
    (y) =>
      y
        .positional("target", {
          describe: "Symbol target (name or path:name[:kind])",
          type: "string",
        })
        .option("output", {
          alias: "o",
          type: "string",
          choices: ["text", "json"] as const,
          default: "text",
          describe: "Output format",
        })
        .option("max-refs", {
          type: "number",
          describe: "Max references to include in output",
        })
        .option("force-refs", {
          type: "boolean",
          default: false,
          describe: "Force re-extraction of references",
        })
        .option("tsconfig", {
          type: "string",
          describe: "Path to tsconfig.json or jsconfig.json",
        })
        .option("no-tsconfig", {
          type: "boolean",
          default: false,
          describe: "Disable tsconfig-based resolution",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const refresh = refreshCache({
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeComments: true,
        includeImports: true,
        includeHeadings: true,
        includeCodeBlocks: true,
        includeStats: false,
        includeAnnotations: true,
        exportedOnly: false,
        output: "text",
        useCache: true,
        forceRefresh: false,
        tsconfigPath: argv.tsconfig
          ? path.resolve(repoRoot, argv.tsconfig as string)
          : undefined,
        useTsconfig: !argv["no-tsconfig"],
        refsMode: "structural",
        forceRefs: argv["force-refs"] as boolean,
      });

      const db = refresh.db;
      const symbol = resolveSymbolTarget(db, repoRoot, argv.target as string);
      const refs = db.getReferenceList(
        "in",
        { symbolId: symbol.id },
        ["call", "instantiate"],
        argv["max-refs"] as number | undefined,
      );
      db.close();

      if (argv.output === "json") {
        console.log(
          JSON.stringify(
            {
              symbol: formatSymbolLabel(symbol),
              refs,
            },
            null,
            2,
          ),
        );
        return;
      }

      const lines = formatReferenceList(
        refs,
        `callers of ${formatSymbolLabel(symbol)}`,
        "in",
      );
      console.log(lines.join("\n"));
    },
  )
  .command(
    "call-graph <target>",
    "Show call graph for a symbol",
    (y) =>
      y
        .positional("target", {
          describe: "Symbol target (name or path:name[:kind])",
          type: "string",
        })
        .option("output", {
          alias: "o",
          type: "string",
          choices: ["text", "json"] as const,
          default: "text",
          describe: "Output format",
        })
        .option("depth", {
          type: "number",
          default: 3,
          describe: "Max depth",
        })
        .option("reverse", {
          type: "boolean",
          default: false,
          describe: "Show callers instead of callees",
        })
        .option("force-refs", {
          type: "boolean",
          default: false,
          describe: "Force re-extraction of references",
        })
        .option("tsconfig", {
          type: "string",
          describe: "Path to tsconfig.json or jsconfig.json",
        })
        .option("no-tsconfig", {
          type: "boolean",
          default: false,
          describe: "Disable tsconfig-based resolution",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const refresh = refreshCache({
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeComments: true,
        includeImports: true,
        includeHeadings: true,
        includeCodeBlocks: true,
        includeStats: false,
        includeAnnotations: true,
        exportedOnly: false,
        output: "text",
        useCache: true,
        forceRefresh: false,
        tsconfigPath: argv.tsconfig
          ? path.resolve(repoRoot, argv.tsconfig as string)
          : undefined,
        useTsconfig: !argv["no-tsconfig"],
        refsMode: "structural",
        forceRefs: argv["force-refs"] as boolean,
      });

      const db = refresh.db;
      const symbol = resolveSymbolTarget(db, repoRoot, argv.target as string);
      const depth = Number.isFinite(argv.depth)
        ? (argv.depth as number)
        : 3;
      const graph = argv.reverse
        ? buildCallersGraph(db, symbol.id, depth)
        : buildCallGraph(db, symbol.id, depth);
      db.close();

      if (argv.output === "json") {
        console.log(JSON.stringify(graph, null, 2));
        return;
      }

      console.log(renderCallGraph(graph));
    },
  )
  .command(
    "subtypes <target>",
    "Show subtype hierarchy for a symbol",
    (y) =>
      y
        .positional("target", {
          describe: "Symbol target (name or path:name[:kind])",
          type: "string",
        })
        .option("output", {
          alias: "o",
          type: "string",
          choices: ["text", "json"] as const,
          default: "text",
          describe: "Output format",
        })
        .option("depth", {
          type: "number",
          default: 3,
          describe: "Max depth",
        })
        .option("force-refs", {
          type: "boolean",
          default: false,
          describe: "Force re-extraction of references",
        })
        .option("tsconfig", {
          type: "string",
          describe: "Path to tsconfig.json or jsconfig.json",
        })
        .option("no-tsconfig", {
          type: "boolean",
          default: false,
          describe: "Disable tsconfig-based resolution",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const refresh = refreshCache({
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeComments: true,
        includeImports: true,
        includeHeadings: true,
        includeCodeBlocks: true,
        includeStats: false,
        includeAnnotations: true,
        exportedOnly: false,
        output: "text",
        useCache: true,
        forceRefresh: false,
        tsconfigPath: argv.tsconfig
          ? path.resolve(repoRoot, argv.tsconfig as string)
          : undefined,
        useTsconfig: !argv["no-tsconfig"],
        refsMode: "structural",
        forceRefs: argv["force-refs"] as boolean,
      });

      const db = refresh.db;
      const symbol = resolveSymbolTarget(db, repoRoot, argv.target as string);
      const depth = Number.isFinite(argv.depth)
        ? (argv.depth as number)
        : 3;
      const graph = buildSubtypeHierarchy(db, symbol.id, depth);
      db.close();

      if (argv.output === "json") {
        console.log(JSON.stringify(graph, null, 2));
        return;
      }

      console.log(renderTypeHierarchy(graph));
    },
  )
  .command(
    "supertypes <target>",
    "Show supertype hierarchy for a symbol",
    (y) =>
      y
        .positional("target", {
          describe: "Symbol target (name or path:name[:kind])",
          type: "string",
        })
        .option("output", {
          alias: "o",
          type: "string",
          choices: ["text", "json"] as const,
          default: "text",
          describe: "Output format",
        })
        .option("depth", {
          type: "number",
          default: 3,
          describe: "Max depth",
        })
        .option("force-refs", {
          type: "boolean",
          default: false,
          describe: "Force re-extraction of references",
        })
        .option("tsconfig", {
          type: "string",
          describe: "Path to tsconfig.json or jsconfig.json",
        })
        .option("no-tsconfig", {
          type: "boolean",
          default: false,
          describe: "Disable tsconfig-based resolution",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const refresh = refreshCache({
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeComments: true,
        includeImports: true,
        includeHeadings: true,
        includeCodeBlocks: true,
        includeStats: false,
        includeAnnotations: true,
        exportedOnly: false,
        output: "text",
        useCache: true,
        forceRefresh: false,
        tsconfigPath: argv.tsconfig
          ? path.resolve(repoRoot, argv.tsconfig as string)
          : undefined,
        useTsconfig: !argv["no-tsconfig"],
        refsMode: "structural",
        forceRefs: argv["force-refs"] as boolean,
      });

      const db = refresh.db;
      const symbol = resolveSymbolTarget(db, repoRoot, argv.target as string);
      const depth = Number.isFinite(argv.depth)
        ? (argv.depth as number)
        : 3;
      const graph = buildSupertypeHierarchy(db, symbol.id, depth);
      db.close();

      if (argv.output === "json") {
        console.log(JSON.stringify(graph, null, 2));
        return;
      }

      console.log(renderTypeHierarchy(graph));
    },
  )
  .help()
  .version();

async function main() {
  await cli.parse();
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
