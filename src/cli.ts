#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { generateSourceMap, refreshCache } from "./sourceMap.js";
import { renderText, renderJson } from "./render.js";
import { openCache } from "./cache/db.js";
import type { CacheStats } from "./cache/db.js";
import type { SymbolKind, ReferenceList, TagEntry, TagMap } from "./types.js";
import type { SymbolRowWithId } from "./cache/db.js";
import { discoverFiles } from "./fileDiscovery.js";
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
import { buildAnnotationIndex, renderAnnotationIndexMarkdown } from "./export.js";
import {
  TAG_KEY_RE,
  formatTag,
  hasTags,
  matchesTags,
  parseTag,
  summarizeTags,
} from "./tags.js";

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

const SYMBOL_KIND_LIST = [...SYMBOL_KINDS].join(", ");

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

function toArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" ? [item] : []));
  }
  return typeof value === "string" ? [value] : [];
}

function dedupeTags(tags: TagEntry[]): TagEntry[] {
  const seen = new Set<string>();
  const deduped: TagEntry[] = [];
  for (const tag of tags) {
    const key = `${tag.key}\u0000${tag.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tag);
  }
  return deduped;
}

function parseTagList(input: unknown): TagEntry[] {
  const values = toArray(input);
  if (values.length === 0) return [];
  return dedupeTags(values.map((value) => parseTag(value)));
}

function parseKindsArg(input: unknown): SymbolKind[] {
  const values = toArray(input);
  const kinds = new Set<SymbolKind>();
  for (const value of values) {
    const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      if (!SYMBOL_KINDS.has(part as SymbolKind)) {
        throw new Error(
          `Unknown symbol kind "${part}". Expected one of: ${[...SYMBOL_KINDS].join(", ")}.`,
        );
      }
      kinds.add(part as SymbolKind);
    }
  }
  return [...kinds];
}

function parseGroupByTag(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value !== "string") {
    throw new Error("Invalid --group-by value.");
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("tag:")) {
    throw new Error("Invalid --group-by value. Expected tag:<key>.");
  }
  const key = trimmed.slice(4).trim().toLowerCase();
  if (!TAG_KEY_RE.test(key)) {
    throw new Error(`Invalid tag key "${key}" for --group-by.`);
  }
  return key;
}

function addTagToMap(map: TagMap | undefined, tag: TagEntry): TagMap {
  const target = map ?? {};
  const list = target[tag.key] ?? [];
  if (!list.includes(tag.value)) {
    list.push(tag.value);
  }
  target[tag.key] = list;
  return target;
}

function parseAnnotateRawNotes(rawArgs: string[]): {
  notePositional?: string;
  noteFlag?: string;
} {
  const annotateIndex = rawArgs.indexOf("annotate");
  if (annotateIndex === -1) return {};
  const valueOptions = new Set([
    "--note",
    "--tag",
    "--remove-tag",
    "--glob",
    "--auto",
    "--dir",
    "-C",
    "--ignore",
  ]);

  let notePositional: string | undefined;
  let noteFlag: string | undefined;
  let sawTarget = false;

  for (let i = annotateIndex + 1; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--") {
      for (let j = i + 1; j < rawArgs.length; j += 1) {
        if (!sawTarget) {
          sawTarget = true;
          continue;
        }
        if (!notePositional) {
          notePositional = rawArgs[j];
        }
      }
      break;
    }

    if (arg.startsWith("--note=")) {
      noteFlag = arg.slice("--note=".length);
      continue;
    }
    if (arg === "--note") {
      noteFlag = rawArgs[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--tag=") || arg.startsWith("--remove-tag=")) {
      continue;
    }
    if (arg.startsWith("--glob=") || arg.startsWith("--auto=")) {
      continue;
    }
    if (arg.startsWith("--ignore=") || arg.startsWith("--dir=")) {
      continue;
    }

    if (arg.startsWith("-") && arg !== "-") {
      if (valueOptions.has(arg)) {
        i += 1;
      }
      continue;
    }

    if (!sawTarget) {
      sawTarget = true;
      continue;
    }
    if (!notePositional) {
      notePositional = arg;
    }
  }

  return { notePositional, noteFlag };
}

function resolveIncludeIgnored(
  argv: Record<string, unknown>,
  fallbackPatterns: string[],
): string[] {
  const includeIgnored = toArray(argv["include-ignored-path"]);
  if (argv["include-ignored"] === true) {
    if (fallbackPatterns.length > 0) {
      includeIgnored.push(...fallbackPatterns);
    } else {
      includeIgnored.push("**/*");
    }
  }
  return [...new Set(includeIgnored)];
}

function openCacheForQuery(
  argv: Record<string, unknown>,
  opts: Parameters<typeof refreshCache>[0],
) {
  const db = openCache(opts.repoRoot);
  const stats = db.getCacheStats();
  if (argv.refresh === true || stats.files.total === 0) {
    db.close();
    return refreshCache(opts).db;
  }
  return db;
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
  .option("include-ignored", {
    type: "boolean",
    default: false,
    describe: "Include ignored files that match the provided patterns",
    global: true,
  })
  .option("include-ignored-path", {
    type: "string",
    array: true,
    describe: "Include ignored paths (repeatable, git repos only)",
    global: true,
  })
  .option("refresh", {
    type: "boolean",
    default: false,
    describe: "Refresh the cache before running the command",
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
      const includeIgnored = resolveIncludeIgnored(
        argv as Record<string, unknown>,
        [],
      );

      const db = openCacheForQuery(argv as Record<string, unknown>, {
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeIgnored,
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
            "Extract references (default structural). Values: structural, full (includes read/write).",
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
      const includeIgnored = resolveIncludeIgnored(
        argv as Record<string, unknown>,
        (argv.patterns as string[]) ?? [],
      );
      const refresh = refreshCache({
        repoRoot,
        patterns: (argv.patterns as string[]) ?? [],
        ignore: argv.ignore as string[] | undefined,
        includeIgnored,
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
        .option("stats-only", {
          type: "boolean",
          default: false,
          describe: "Show summary statistics only (no file entries)",
        })
        .option("annotations", {
          type: "boolean",
          default: true,
          describe: "Include annotations",
        })
        .option("annotated", {
          type: "boolean",
          default: false,
          describe: "Only include annotated files and symbols",
        })
        .option("annotations-only", {
          type: "boolean",
          default: false,
          describe: "Only show annotations (notes/tags)",
        })
        .option("filter-tag", {
          type: "string",
          array: true,
          describe: "Filter by tag (repeatable, key=value, AND semantics)",
        })
        .option("filter-tag-any", {
          type: "string",
          array: true,
          describe: "Filter by tag (repeatable, key=value, OR semantics)",
        })
        .option("kinds", {
          type: "string",
          describe: `Filter symbol kinds (comma-separated). Values: ${SYMBOL_KIND_LIST}`,
        })
        .option("group-by", {
          type: "string",
          describe: "Group output by tag:<key>",
        })
        .option("refs", {
          type: "string",
          describe:
            "Include references (default incoming). Values: structural, full (includes read/write).",
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
      const includeIgnored = resolveIncludeIgnored(
        argv as Record<string, unknown>,
        (argv.patterns as string[]) ?? [],
      );
      const statsOnly = argv["stats-only"] === true;
      const includeStats = statsOnly ? true : argv.stats !== false;
      const annotationsOnly = argv["annotations-only"] === true;
      const annotatedOnly = argv.annotated === true || annotationsOnly;
      const filterTagsAll = parseTagList(argv["filter-tag"]);
      const filterTagsAny = parseTagList(argv["filter-tag-any"]);
      const filterKinds = parseKindsArg(argv.kinds);
      const groupByTag = parseGroupByTag(argv["group-by"]);
      const includeAnnotations =
        argv.annotations !== false ||
        annotatedOnly ||
        filterTagsAll.length > 0 ||
        filterTagsAny.length > 0;

      const opts = {
        repoRoot: repoRoot,
        patterns: (argv.patterns as string[]) ?? [],
        ignore: argv.ignore as string[] | undefined,
        includeIgnored,
        includeComments: argv.comments !== false,
        includeImports: argv.imports !== false,
        includeHeadings: argv.headings !== false,
        includeCodeBlocks: argv["code-blocks"] !== false,
        includeStats,
        includeAnnotations,
        exportedOnly: argv["exported-only"],
        annotatedOnly,
        annotationsOnly,
        refresh: argv.refresh === true,
        filterKinds: filterKinds.length > 0 ? filterKinds : undefined,
        filterTagsAll: filterTagsAll.length > 0 ? filterTagsAll : undefined,
        filterTagsAny: filterTagsAny.length > 0 ? filterTagsAny : undefined,
        groupByTag,
        tokenBudget: argv.budget,
        output,
        summaryOnly: statsOnly,
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
        console.log(renderJson(result, opts));
      } else {
        console.log(renderText(result, opts));
      }
    },
  )
  .command(
    "annotate [target] [note]",
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
        .option("note", {
          type: "string",
          describe: "Annotation text (explicit)",
        })
        .option("tag", {
          type: "string",
          array: true,
          describe: "Add tag (repeatable, key=value)",
        })
        .option("remove-tag", {
          type: "string",
          array: true,
          describe: "Remove tag (repeatable, key=value)",
        })
        .option("clear-tags", {
          type: "boolean",
          default: false,
          describe: "Remove all tags on the target",
        })
        .option("glob", {
          type: "string",
          array: true,
          describe: "Annotate files matching glob patterns",
        })
        .option("auto", {
          type: "string",
          describe: "Auto-annotate using a heuristic. Values: command.",
        })
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "Show planned changes without writing to the cache",
        })
        .option("remove", {
          type: "boolean",
          default: false,
          describe: "Remove the annotation",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const rawTarget = argv.target as string | undefined;
      const rawNotes = parseAnnotateRawNotes(hideBin(process.argv));
      const noteFlag = rawNotes.noteFlag;
      const notePositional = rawNotes.notePositional;
      const note =
        noteFlag ?? notePositional ?? (argv.note as string | undefined);
      const tagsToAdd = parseTagList(argv.tag);
      const tagsToRemove = parseTagList(argv["remove-tag"]);
      const clearTags = argv["clear-tags"] === true;
      const globPatterns = toArray(argv.glob);
      const autoMode = typeof argv.auto === "string" ? argv.auto.trim() : undefined;
      const dryRun = argv["dry-run"] === true;
      const includeIgnored = resolveIncludeIgnored(
        argv as Record<string, unknown>,
        globPatterns,
      );

      if (noteFlag && notePositional && noteFlag !== notePositional) {
        throw new Error("Conflicting notes provided via positional and --note.");
      }

      if (argv.remove && note) {
        throw new Error("Cannot provide a note when using --remove.");
      }

      if (!rawTarget && globPatterns.length === 0 && !autoMode) {
        throw new Error("Annotation target is required.");
      }

      const db = openCache(repoRoot);
      const targets: ParsedTarget[] = [];

      if (rawTarget) {
        targets.push(parseAnnotationTarget(rawTarget));
      }

      if (globPatterns.length > 0) {
        const files = discoverFiles({
          repoRoot,
          patterns: globPatterns,
          ignore: argv.ignore as string[] | undefined,
          includeIgnored,
        });
        for (const file of files) {
          targets.push({ path: file });
        }
      }

      if (autoMode) {
        if (autoMode !== "command") {
          db.close();
          throw new Error(`Unknown auto mode "${autoMode}".`);
        }
        for (const filePath of db.listFiles()) {
          for (const sym of db.getSymbols(filePath)) {
            if (sym.kind === "class" && sym.name.endsWith("Command")) {
              targets.push({
                path: filePath,
                symbol: {
                  name: sym.name,
                  kind: sym.kind,
                  parentName: sym.parent_name ?? null,
                  signature: sym.signature ?? null,
                },
              });
            }
          }
        }
      }

      const deduped = new Map<string, ParsedTarget>();
      for (const target of targets) {
        const normalizedPath = normalizeAnnotationPath(repoRoot, target.path);
        const key = target.symbol
          ? `symbol:${normalizedPath}:${target.symbol.name}:${target.symbol.kind}:${
              target.symbol.parentName ?? ""
            }:${target.symbol.signature ?? ""}`
          : `file:${normalizedPath}`;
        if (!deduped.has(key)) {
          deduped.set(key, { ...target, path: normalizedPath });
        }
      }

      if (deduped.size === 0) {
        db.close();
        throw new Error("No annotation targets matched.");
      }

      const summaries: Array<{ label: string; actions: string[] }> = [];

      for (const target of deduped.values()) {
        const actions: string[] = [];
        if (argv.remove) actions.push("remove note");
        if (note) actions.push(`set note "${note}"`);
        if (clearTags) actions.push("clear tags");
        if (tagsToRemove.length > 0) {
          actions.push(
            `remove tags: ${tagsToRemove.map(formatTag).join(", ")}`,
          );
        }
        if (tagsToAdd.length > 0) {
          actions.push(`add tags: ${tagsToAdd.map(formatTag).join(", ")}`);
        }
        if (actions.length === 0) {
          db.close();
          throw new Error("No note or tags provided to update.");
        }

        if (!target.symbol) {
          const fileRow = db.getFile(target.path);
          if (!fileRow) {
            db.close();
            throw new Error(
              `File not found in cache: ${target.path}. Run 'codemap' first to index files.`,
            );
          }

          if (!dryRun) {
            if (argv.remove) {
              db.removeFileAnnotation(target.path);
            }
            if (note) {
              db.setFileAnnotation(target.path, note);
            }
            if (clearTags) {
              db.clearFileAnnotationTags(target.path);
            }
            if (tagsToRemove.length > 0) {
              db.removeFileAnnotationTags(target.path, tagsToRemove);
            }
            if (tagsToAdd.length > 0) {
              db.addFileAnnotationTags(target.path, tagsToAdd);
            }
          }

          summaries.push({ label: target.path, actions });
          continue;
        }

        const symbolKey = {
          path: target.path,
          symbolName: target.symbol.name,
          symbolKind: target.symbol.kind,
          parentName: target.symbol.parentName ?? null,
          signature: target.symbol.signature ?? null,
        };

        if (!SYMBOL_KINDS.has(symbolKey.symbolKind as SymbolKind)) {
          db.close();
          throw new Error(
            `Unknown symbol kind "${symbolKey.symbolKind}". Expected one of: ${[...SYMBOL_KINDS].join(", ")}.`,
          );
        }

        const symbols = db.findSymbols(
          target.path,
          symbolKey.symbolName,
          symbolKey.symbolKind,
          symbolKey.parentName,
        );
        if (symbols.length === 0) {
          db.close();
          throw new Error(
            `Symbol not found: ${symbolKey.symbolKind} ${symbolKey.symbolName} in ${target.path}. Run 'codemap' first to index files.`,
          );
        }

        if (!dryRun) {
          if (argv.remove) {
            db.removeSymbolAnnotation(symbolKey);
          }
          if (note) {
            db.setSymbolAnnotation(symbolKey, note);
          }
          if (clearTags) {
            db.clearSymbolAnnotationTags(symbolKey);
          }
          if (tagsToRemove.length > 0) {
            db.removeSymbolAnnotationTags(symbolKey, tagsToRemove);
          }
          if (tagsToAdd.length > 0) {
            db.addSymbolAnnotationTags(symbolKey, tagsToAdd);
          }
        }

        const label = formatSymbolLabel(symbols[0]);
        summaries.push({ label, actions });
      }

      db.close();

      if (dryRun) {
        console.log("Dry run:");
      }
      for (const summary of summaries) {
        console.log(`- ${summary.label}: ${summary.actions.join("; ")}`);
      }
    },
  )
  .command(
    "annotations [path]",
    "List annotations",
    (y) =>
      y
        .positional("path", {
          describe: "Optional file path to filter",
          type: "string",
        })
        .option("tag", {
          type: "string",
          array: true,
          describe: "Filter by tag (repeatable, key=value)",
        })
        .option("kinds", {
          type: "string",
          describe: `Filter symbol kinds (comma-separated). Values: ${SYMBOL_KIND_LIST}`,
        })
        .option("scope", {
          type: "string",
          choices: ["files", "symbols", "all"] as const,
          default: "all",
          describe: "Scope to list",
        })
        .option("unannotated", {
          type: "boolean",
          default: false,
          describe: "List files without notes or tags",
        })
        .option("orphans", {
          type: "boolean",
          default: false,
          describe: "List orphaned annotations and tags",
        })
        .option("summary", {
          type: "boolean",
          default: false,
          describe: "Show annotation summary",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const filterPath = argv.path
        ? normalizeAnnotationPath(repoRoot, argv.path as string)
        : undefined;
      const scope = argv.scope as "files" | "symbols" | "all";
      const tagFilters = parseTagList(argv.tag);
      const kindsFilter = parseKindsArg(argv.kinds);
      const kindSet = kindsFilter.length > 0 ? new Set(kindsFilter) : null;

      const db = openCache(repoRoot);

      if (argv.unannotated) {
        const unannotated = db.listUnannotatedFiles();
        db.close();
        const filtered = filterPath
          ? unannotated.filter((path) => path === filterPath)
          : unannotated;
        if (filtered.length === 0) {
          console.log("No unannotated files found.");
          return;
        }
        console.log("Unannotated files:");
        for (const path of filtered) {
          console.log(`- ${path}`);
        }
        return;
      }

      if (argv.orphans) {
        const orphanedFiles = db.listOrphanedFileAnnotations();
        const orphanedFileTags = db.listOrphanedFileAnnotationTags();
        const orphanedSymbols = db.listOrphanedSymbolAnnotations();
        const orphanedSymbolTags = db.listOrphanedSymbolAnnotationTags();
        db.close();

        if (
          orphanedFiles.length === 0 &&
          orphanedFileTags.length === 0 &&
          orphanedSymbols.length === 0 &&
          orphanedSymbolTags.length === 0
        ) {
          console.log("No orphaned annotations found.");
          return;
        }

        if (orphanedFiles.length > 0) {
          console.log("Orphaned file annotations:");
          for (const row of orphanedFiles) {
            console.log(`- ${row.path}: ${row.note}`);
          }
        }

        if (orphanedFileTags.length > 0) {
          console.log("Orphaned file tags:");
          for (const row of orphanedFileTags) {
            console.log(`- ${row.path}: ${row.tag_key}=${row.tag_value}`);
          }
        }

        if (orphanedSymbols.length > 0) {
          console.log("Orphaned symbol annotations:");
          for (const row of orphanedSymbols) {
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

        if (orphanedSymbolTags.length > 0) {
          console.log("Orphaned symbol tags:");
          for (const row of orphanedSymbolTags) {
            let target = `${row.path}:${row.symbol_name}:${row.symbol_kind}`;
            if (row.parent_name && row.signature) {
              target += `:${row.parent_name}(${row.signature})`;
            } else if (row.parent_name) {
              target += `:${row.parent_name}`;
            } else if (row.signature) {
              target += `:${row.signature}`;
            }
            console.log(`- ${target}: ${row.tag_key}=${row.tag_value}`);
          }
        }
        return;
      }

      if (argv.summary) {
        const fileNotes = db.listFileAnnotations(filterPath);
        const symbolNotes = db.listSymbolAnnotations(filterPath);
        const fileTags = db.listFileAnnotationTags(filterPath);
        const symbolTags = db.listSymbolAnnotationTags(filterPath);
        const tagCounts = filterPath
          ? (() => {
              const counts = new Map<
                string,
                { key: string; value: string; fileCount: number; symbolCount: number }
              >();
              for (const row of fileTags) {
                const key = `${row.tag_key}\u0000${row.tag_value}`;
                const entry =
                  counts.get(key) ??
                  {
                    key: row.tag_key,
                    value: row.tag_value,
                    fileCount: 0,
                    symbolCount: 0,
                  };
                entry.fileCount += 1;
                counts.set(key, entry);
              }
              for (const row of symbolTags) {
                const key = `${row.tag_key}\u0000${row.tag_value}`;
                const entry =
                  counts.get(key) ??
                  {
                    key: row.tag_key,
                    value: row.tag_value,
                    fileCount: 0,
                    symbolCount: 0,
                  };
                entry.symbolCount += 1;
                counts.set(key, entry);
              }
              return Array.from(counts.values()).sort((a, b) => {
                if (a.key !== b.key) return a.key.localeCompare(b.key);
                return a.value.localeCompare(b.value);
              });
            })()
          : db.listTagCounts();

        const filteredCounts =
          tagFilters.length > 0
            ? tagCounts.filter((row) =>
                tagFilters.some(
                  (tag) => tag.key === row.key && tag.value === row.value,
                ),
              )
            : tagCounts;

        db.close();
        console.log("Annotation summary:");
        console.log(`- file notes: ${fileNotes.length}`);
        console.log(`- symbol notes: ${symbolNotes.length}`);
        console.log(`- file tags: ${fileTags.length}`);
        console.log(`- symbol tags: ${symbolTags.length}`);

        if (filteredCounts.length > 0) {
          console.log("Tags:");
          for (const row of filteredCounts) {
            console.log(
              `- ${row.key}=${row.value} (${row.fileCount} files, ${row.symbolCount} symbols)`,
            );
          }
        }
        return;
      }

      const fileNotes = db.listFileAnnotations(filterPath);
      const symbolNotes = db.listSymbolAnnotations(filterPath);
      const fileTagRows = db.listFileAnnotationTags(filterPath);
      const symbolTagRows = db.listSymbolAnnotationTags(filterPath);

      const fileItems = new Map<string, { path: string; note?: string; tags?: TagMap }>();
      for (const row of fileNotes) {
        fileItems.set(row.path, { path: row.path, note: row.note });
      }
      for (const row of fileTagRows) {
        const item = fileItems.get(row.path) ?? { path: row.path };
        item.tags = addTagToMap(item.tags, {
          key: row.tag_key,
          value: row.tag_value,
        });
        fileItems.set(row.path, item);
      }

      const symbolItems = new Map<
        string,
        {
          path: string;
          name: string;
          kind: string;
          parentName: string | null;
          signature: string;
          note?: string;
          tags?: TagMap;
        }
      >();
      for (const row of symbolNotes) {
        const key = `${row.path}\u0000${row.symbol_name}\u0000${row.symbol_kind}\u0000${
          row.parent_name ?? ""
        }\u0000${row.signature}`;
        symbolItems.set(key, {
          path: row.path,
          name: row.symbol_name,
          kind: row.symbol_kind,
          parentName: row.parent_name ?? null,
          signature: row.signature,
          note: row.note,
        });
      }
      for (const row of symbolTagRows) {
        const key = `${row.path}\u0000${row.symbol_name}\u0000${row.symbol_kind}\u0000${
          row.parent_name ?? ""
        }\u0000${row.signature}`;
        const item =
          symbolItems.get(key) ??
          {
            path: row.path,
            name: row.symbol_name,
            kind: row.symbol_kind,
            parentName: row.parent_name ?? null,
            signature: row.signature,
          };
        item.tags = addTagToMap(item.tags, {
          key: row.tag_key,
          value: row.tag_value,
        });
        symbolItems.set(key, item);
      }

      db.close();

      const fileList = Array.from(fileItems.values()).sort((a, b) =>
        a.path.localeCompare(b.path),
      );
      const symbolList = Array.from(symbolItems.values()).sort((a, b) => {
        if (a.path !== b.path) return a.path.localeCompare(b.path);
        return a.name.localeCompare(b.name);
      });

      const tagFilteredFiles =
        tagFilters.length > 0
          ? fileList.filter((item) =>
              matchesTags(item.tags, tagFilters, undefined),
            )
          : fileList;
      const tagFilteredSymbols =
        tagFilters.length > 0
          ? symbolList.filter((item) =>
              matchesTags(item.tags, tagFilters, undefined),
            )
          : symbolList;

      const kindFilteredSymbols = kindSet
        ? tagFilteredSymbols.filter((item) =>
            kindSet.has(item.kind as SymbolKind),
          )
        : tagFilteredSymbols;

      const showFiles = scope === "files" || scope === "all";
      const showSymbols = scope === "symbols" || scope === "all";

      if (tagFilteredFiles.length === 0 && kindFilteredSymbols.length === 0) {
        console.log("No annotations found.");
        return;
      }

      if (showFiles && tagFilteredFiles.length > 0) {
        console.log("File annotations:");
        for (const item of tagFilteredFiles) {
          let line = `- ${item.path}`;
          if (item.note) {
            line += `: ${item.note}`;
          }
          if (hasTags(item.tags)) {
            line += ` [tags: ${summarizeTags(item.tags)}]`;
          }
          console.log(line);
        }
      }

      if (showSymbols && kindFilteredSymbols.length > 0) {
        console.log("Symbol annotations:");
        for (const item of kindFilteredSymbols) {
          let target = `${item.path}:${item.name}:${item.kind}`;
          if (item.parentName && item.signature) {
            target += `:${item.parentName}(${item.signature})`;
          } else if (item.parentName) {
            target += `:${item.parentName}`;
          } else if (item.signature) {
            target += `:${item.signature}`;
          }
          let line = `- ${target}`;
          if (item.note) {
            line += `: ${item.note}`;
          }
          if (hasTags(item.tags)) {
            line += ` [tags: ${summarizeTags(item.tags)}]`;
          }
          console.log(line);
        }
      }
    },
  )
  .command(
    "tags",
    "List tags",
    (y) =>
      y
        .option("filter", {
          type: "string",
          describe: "Filter by tag key",
        })
        .option("scope", {
          type: "string",
          choices: ["files", "symbols", "all"] as const,
          default: "all",
          describe: "Scope to list",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const scope = argv.scope as "files" | "symbols" | "all";
      const filterKey =
        typeof argv.filter === "string" ? argv.filter.trim().toLowerCase() : undefined;
      if (filterKey && !TAG_KEY_RE.test(filterKey)) {
        throw new Error(`Invalid tag key "${filterKey}".`);
      }

      const db = openCache(repoRoot);
      const counts = db.listTagCounts({
        key: filterKey,
        scope,
      });
      db.close();

      if (counts.length === 0) {
        console.log("No tags found.");
        return;
      }

      for (const row of counts) {
        if (scope === "files") {
          console.log(`${row.key}=${row.value} (${row.fileCount} files)`);
        } else if (scope === "symbols") {
          console.log(`${row.key}=${row.value} (${row.symbolCount} symbols)`);
        } else {
          console.log(
            `${row.key}=${row.value} (${row.fileCount} files, ${row.symbolCount} symbols)`,
          );
        }
      }
    },
  )
  .command(
    "export",
    "Export annotation index",
    (y) =>
      y
        .option("format", {
          type: "string",
          choices: ["json", "markdown"] as const,
          default: "json",
          describe: "Export format",
        })
        .option("output", {
          type: "string",
          describe: "Output file path (defaults to stdout)",
        })
        .option("all", {
          type: "boolean",
          default: false,
          describe: "Include unannotated files and symbols",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;
      const format = argv.format === "markdown" ? "markdown" : "json";
      const outputPath = argv.output as string | undefined;

      const db = openCache(repoRoot);
      const index = buildAnnotationIndex(db, { includeAll: argv.all === true });
      db.close();

      const rendered =
        format === "json"
          ? JSON.stringify(index, null, 2)
          : renderAnnotationIndexMarkdown(index);

      if (outputPath) {
        fs.writeFileSync(outputPath, rendered);
        console.log(`Wrote ${format} export to ${outputPath}`);
      } else {
        console.log(rendered);
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
      const includeIgnored = resolveIncludeIgnored(
        argv as Record<string, unknown>,
        [],
      );
      const db = openCacheForQuery(argv as Record<string, unknown>, {
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeIgnored,
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
      const includeIgnored = resolveIncludeIgnored(
        argv as Record<string, unknown>,
        [],
      );
      const db = openCacheForQuery(argv as Record<string, unknown>, {
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeIgnored,
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
      const includeIgnored = resolveIncludeIgnored(
        argv as Record<string, unknown>,
        [],
      );
      const db = openCacheForQuery(argv as Record<string, unknown>, {
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeIgnored,
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
      const includeIgnored = resolveIncludeIgnored(
        argv as Record<string, unknown>,
        [],
      );
      const db = openCacheForQuery(argv as Record<string, unknown>, {
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeIgnored,
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
      const includeIgnored = resolveIncludeIgnored(
        argv as Record<string, unknown>,
        [],
      );
      const db = openCacheForQuery(argv as Record<string, unknown>, {
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeIgnored,
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
      const includeIgnored = resolveIncludeIgnored(
        argv as Record<string, unknown>,
        [],
      );
      const db = openCacheForQuery(argv as Record<string, unknown>, {
        repoRoot,
        patterns: [],
        ignore: argv.ignore as string[] | undefined,
        includeIgnored,
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
