import fs from "node:fs";
import path from "node:path";
import type {
  SourceMapOptions,
  SourceMapResult,
  FileEntry,
  DetailLevel,
  SymbolEntry,
  MarkdownHeading,
  MarkdownCodeBlock,
} from "./types.js";
import { discoverFiles } from "./fileDiscovery.js";
import {
  detectLanguage,
  canExtractSymbols,
  canExtractStructure,
} from "./languages.js";
import { extractFileSymbols } from "./symbols.js";
import { extractMarkdownStructure } from "./markdown.js";
import { computeStats } from "./stats.js";
import { renderFileEntry } from "./render.js";

const DEFAULT_OPTIONS: Partial<SourceMapOptions> = {
  includeComments: true,
  includeImports: true,
  includeHeadings: true,
  includeCodeBlocks: true,
  includeStats: true,
  exportedOnly: false,
  output: "text",
};

const DETAIL_LEVELS: DetailLevel[] = [
  "full",
  "standard",
  "compact",
  "minimal",
  "outline",
];

function reduceDetailLevel(level: DetailLevel): DetailLevel {
  const idx = DETAIL_LEVELS.indexOf(level);
  return idx < DETAIL_LEVELS.length - 1 ? DETAIL_LEVELS[idx + 1] : level;
}

function estimateFileTokens(entry: FileEntry, opts: SourceMapOptions): number {
  const rendered = renderFileEntry(entry, opts);
  return Math.ceil(rendered.length / 4);
}

function fitToBudget(
  entries: FileEntry[],
  opts: SourceMapOptions,
  budget: number,
): FileEntry[] {
  for (const entry of entries) {
    entry.tokenEstimate = estimateFileTokens(entry, opts);
  }

  let total = entries.reduce((sum, e) => sum + e.tokenEstimate, 0);

  while (total > budget) {
    let largest: FileEntry | null = null;
    for (const entry of entries) {
      if (entry.detailLevel === "outline") continue;
      if (!largest || entry.tokenEstimate > largest.tokenEstimate) {
        largest = entry;
      }
    }

    if (!largest) break;

    largest.detailLevel = reduceDetailLevel(largest.detailLevel);
    const oldEstimate = largest.tokenEstimate;
    largest.tokenEstimate = estimateFileTokens(largest, opts);
    total -= oldEstimate - largest.tokenEstimate;
  }

  return entries;
}

export function generateSourceMap(options: SourceMapOptions): SourceMapResult {
  const opts = { ...DEFAULT_OPTIONS, ...options } as SourceMapOptions;
  const { repoRoot } = opts;

  const filePaths = discoverFiles({
    repoRoot,
    patterns: opts.patterns,
    ignore: opts.ignore,
  });

  const entries: FileEntry[] = [];

  for (const relPath of filePaths) {
    const fullPath = path.join(repoRoot, relPath);

    let content: string;
    let lineCount: number;
    try {
      const buf = fs.readFileSync(fullPath);
      if (buf.includes(0)) continue;
      content = buf.toString("utf-8");
      lineCount = content.split(/\r?\n/).length;
    } catch {
      continue;
    }

    const language = detectLanguage(relPath);

    let symbols: SymbolEntry[] = [];
    let imports: string[] = [];
    let headings: MarkdownHeading[] | undefined;
    let codeBlocks: MarkdownCodeBlock[] | undefined;

    if (canExtractSymbols(language)) {
      const extracted = extractFileSymbols(relPath, content, {
        includeComments: opts.includeComments,
      });
      symbols = opts.exportedOnly
        ? extracted.symbols.filter((s) => s.exported)
        : extracted.symbols;
      imports = opts.includeImports ? extracted.imports : [];
    } else if (canExtractStructure(language)) {
      const structure = extractMarkdownStructure(content);
      headings = opts.includeHeadings ? structure.headings : undefined;
      codeBlocks = opts.includeCodeBlocks ? structure.codeBlocks : undefined;
    }

    entries.push({
      path: relPath,
      language,
      startLine: 1,
      endLine: lineCount,
      detailLevel: "full",
      symbols,
      headings,
      codeBlocks,
      imports,
      tokenEstimate: 0,
    });
  }

  let finalEntries = entries;
  if (opts.tokenBudget) {
    finalEntries = fitToBudget(entries, opts, opts.tokenBudget);
  } else {
    for (const entry of finalEntries) {
      entry.tokenEstimate = estimateFileTokens(entry, opts);
    }
  }

  const totalTokens = finalEntries.reduce((sum, e) => sum + e.tokenEstimate, 0);
  const stats = opts.includeStats ? computeStats(finalEntries) : null;

  return {
    repoRoot,
    stats,
    files: finalEntries,
    totalTokens,
  };
}
