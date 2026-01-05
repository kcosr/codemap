#!/usr/bin/env node
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { generateSourceMap } from "./sourceMap.js";
import { renderText, renderJson } from "./render.js";
import { openCache } from "./cache/db.js";
import type { CacheStats } from "./cache/db.js";
import type { SymbolKind } from "./types.js";

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

function normalizeAnnotationPath(repoRoot: string, inputPath: string): string {
  const resolved = path.resolve(repoRoot, inputPath);
  if (resolved.startsWith(repoRoot + path.sep)) {
    return path.relative(repoRoot, resolved);
  }
  return inputPath;
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
    `  - orphaned: ${stats.annotations.orphaned} (run --prune-annotations to clean)`,
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
          type: "number",
          describe: "Token budget (auto-reduces detail to fit)",
        })
        .option("exported-only", {
          type: "boolean",
          default: false,
          describe: "Only include exported symbols",
        })
        .option("no-comments", {
          type: "boolean",
          default: false,
          describe: "Exclude JSDoc comments",
        })
        .option("no-imports", {
          type: "boolean",
          default: false,
          describe: "Exclude import lists",
        })
        .option("no-headings", {
          type: "boolean",
          default: false,
          describe: "Exclude markdown headings",
        })
        .option("no-code-blocks", {
          type: "boolean",
          default: false,
          describe: "Exclude markdown code block ranges",
        })
        .option("no-stats", {
          type: "boolean",
          default: false,
          describe: "Exclude project statistics header",
        })
        .option("no-cache", {
          type: "boolean",
          default: false,
          describe: "Force full re-extraction (ignore cache)",
        })
        .option("cache-stats", {
          type: "boolean",
          default: false,
          describe: "Show cache statistics",
        })
        .option("prune-annotations", {
          type: "boolean",
          default: false,
          describe: "Remove orphaned annotations",
        }),
    (argv) => {
      const repoRoot = argv.dir as string;

      if (argv["cache-stats"]) {
        const db = openCache(repoRoot);
        const stats = db.getCacheStats();
        db.close();
        console.log(renderCacheStats(stats));
        return;
      }

      if (argv["prune-annotations"]) {
        const db = openCache(repoRoot);
        const result = db.pruneOrphanedAnnotations();
        db.close();
        console.log(
          `Pruned annotations: file ${result.file}, symbol ${result.symbol}`,
        );
        return;
      }

      const output = argv.output === "json" ? "json" : "text";

      const opts = {
        repoRoot: repoRoot,
        patterns: (argv.patterns as string[]) ?? [],
        ignore: argv.ignore as string[] | undefined,
        includeComments: !argv["no-comments"],
        includeImports: !argv["no-imports"],
        includeHeadings: !argv["no-headings"],
        includeCodeBlocks: !argv["no-code-blocks"],
        includeStats: !argv["no-stats"],
        exportedOnly: argv["exported-only"],
        tokenBudget: argv.budget,
        output,
        forceRefresh: argv["no-cache"],
        useCache: true,
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
  .help()
  .version();

async function main() {
  await cli.parse();
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
