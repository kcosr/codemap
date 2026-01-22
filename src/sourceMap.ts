import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import micromatch from "micromatch";
import type {
  SourceMapOptions,
  SourceMapResult,
  FileEntry,
  DetailLevel,
  SymbolEntry,
  MarkdownHeading,
  MarkdownCodeBlock,
  ResolvedImport,
} from "./types.js";
import { discoverFiles } from "./fileDiscovery.js";
import {
  detectLanguage,
  canExtractSymbols,
  canExtractStructure,
} from "./languages.js";
import { extractFileSymbols, extractFileSymbolsDetailed } from "./symbols.js";
import { extractCppSymbols } from "./symbols-cpp.js";
import { extractRustSymbols } from "./symbols-rust.js";
import { applyHeadingRanges, extractMarkdownStructure } from "./markdown.js";
import { computeStats } from "./stats.js";
import { renderFileEntry } from "./render.js";
import {
  openCache,
  EXTRACTOR_VERSION,
  CacheDB,
  type FileRow,
  type SymbolRow,
  type ImportRow,
  type HeadingRow,
  type CodeBlockRow,
  type CachedFile,
} from "./cache/db.js";
import { updateReferences } from "./refs/update.js";
import {
  createResolverContext,
  resolveImports,
  type ResolverContext,
} from "./deps/resolver.js";
import {
  createCppResolverContext,
  resolveIncludes,
  type CppResolverContext,
} from "./deps/cpp-resolver.js";
import {
  createRustResolverContext,
  resolveUseStatements,
  type RustResolverContext,
} from "./deps/rust-resolver.js";
import type { IncludeSpec } from "./deps/extract-includes.js";
import {
  detectChanges,
  statDiscoveredFiles,
  type DiscoveredFile,
  type FileChange,
  type FileTouch,
} from "./cache/changes.js";
import { buildSymbolAnnotationKey } from "./cache/annotations.js";
import { STRUCTURAL_REF_KINDS } from "./cache/references.js";

const DEFAULT_OPTIONS: Partial<SourceMapOptions> = {
  includeComments: true,
  includeImports: true,
  includeHeadings: true,
  includeCodeBlocks: true,
  includeStats: true,
  includeAnnotations: true,
  exportedOnly: false,
  output: "text",
  useCache: true,
  forceRefresh: false,
  useTsconfig: true,
  includeRefs: false,
  refsDirection: "in",
  refsMode: undefined,
  maxRefs: undefined,
  forceRefs: false,
};

const DETAIL_LEVELS: DetailLevel[] = [
  "full",
  "standard",
  "compact",
  "minimal",
  "outline",
];

const MM_OPTS = { dot: true } as const;

function formatIncludeSource(include: IncludeSpec): string {
  return include.kind === "system"
    ? `<${include.source}>`
    : `"${include.source}"`;
}

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

function normalizeScopePatterns(
  patterns: string[] | undefined,
  ignore: string[] | undefined,
): { patterns: string[]; ignore: string[] } {
  return {
    patterns: patterns ?? [],
    ignore: ignore ?? [],
  };
}

function isInScope(
  relPath: string,
  patterns: string[],
  ignore: string[],
): boolean {
  if (patterns.length > 0) {
    const matched = patterns.some((p) => micromatch.isMatch(relPath, p, MM_OPTS));
    if (!matched) return false;
  }
  if (ignore.length > 0) {
    const ignored = ignore.some((p) => micromatch.isMatch(relPath, p, MM_OPTS));
    if (ignored) return false;
  }
  return true;
}

function filterCachedByScope(
  cached: Map<string, CachedFile>,
  patterns: string[],
  ignore: string[],
): Map<string, CachedFile> {
  if (patterns.length === 0 && ignore.length === 0) return cached;
  const scoped = new Map<string, CachedFile>();
  for (const [relPath, entry] of cached) {
    if (isInScope(relPath, patterns, ignore)) {
      scoped.set(relPath, entry);
    }
  }
  return scoped;
}

function hashBuffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

type Extracted = {
  file: FileRow;
  symbols: SymbolRow[];
  imports: ImportRow[];
  resolvedImports: ResolvedImport[];
  headings: HeadingRow[];
  codeBlocks: CodeBlockRow[];
};

function extractFileForCache(
  file: DiscoveredFile,
  resolverContext: ResolverContext,
  cppResolverContext: CppResolverContext,
  rustResolverContext: RustResolverContext,
): Extracted | null {
  let buf: Buffer;
  let content: string;
  let lineCount: number;

  try {
    buf = fs.readFileSync(file.fullPath);
    if (buf.includes(0)) return null;
    content = buf.toString("utf-8");
    lineCount = content.split(/\r?\n/).length;
  } catch {
    return null;
  }

  const language = detectLanguage(file.path);
  const now = new Date().toISOString();
  const fileRow: FileRow = {
    path: file.path,
    mtime: file.mtime,
    size: file.size,
    hash: hashBuffer(buf),
    language,
    line_count: lineCount,
    extractor_version: EXTRACTOR_VERSION,
    updated_at: now,
  };

  let symbols: SymbolRow[] = [];
  let imports: ImportRow[] = [];
  let resolvedImports: ResolvedImport[] = [];
  let headings: HeadingRow[] = [];
  let codeBlocks: CodeBlockRow[] = [];

  if (canExtractSymbols(language)) {
    if (language === "cpp") {
      const extracted = extractCppSymbols(file.path, content, {
        includeComments: true,
      });
      symbols = extracted.symbols.map((sym) => ({
        path: file.path,
        name: sym.name,
        kind: sym.kind,
        signature: sym.signature,
        start_line: sym.startLine,
        end_line: sym.endLine,
        exported: sym.exported ? 1 : 0,
        is_default: sym.isDefault ? 1 : 0,
        is_async: sym.isAsync ? 1 : 0,
        is_static: sym.isStatic ? 1 : 0,
        is_abstract: sym.isAbstract ? 1 : 0,
        parent_name: sym.parentName ?? null,
        jsdoc: sym.comment ?? null,
      }));
      imports = extracted.includes.map((inc) => ({
        path: file.path,
        source: formatIncludeSource(inc),
      }));
      resolvedImports = resolveIncludes(
        file.path,
        extracted.includes,
        cppResolverContext,
      );
    } else if (language === "rust") {
      const extracted = extractRustSymbols(file.path, content, {
        includeComments: true,
      });
      symbols = extracted.symbols.map((sym) => ({
        path: file.path,
        name: sym.name,
        kind: sym.kind,
        signature: sym.signature,
        start_line: sym.startLine,
        end_line: sym.endLine,
        exported: sym.exported ? 1 : 0,
        is_default: sym.isDefault ? 1 : 0,
        is_async: sym.isAsync ? 1 : 0,
        is_static: sym.isStatic ? 1 : 0,
        is_abstract: sym.isAbstract ? 1 : 0,
        parent_name: sym.parentName ?? null,
        jsdoc: sym.comment ?? null,
      }));
      imports = extracted.useStatements.map((use) => ({
        path: file.path,
        source: use.isGlob ? `${use.source}::*` : use.source,
      }));
      resolvedImports = resolveUseStatements(
        file.path,
        extracted.useStatements,
        rustResolverContext,
      );
    } else {
      const extracted = extractFileSymbolsDetailed(file.path, content, {
        includeComments: true,
      });
      symbols = extracted.symbols.map((sym) => ({
        path: file.path,
        name: sym.name,
        kind: sym.kind,
        signature: sym.signature,
        start_line: sym.startLine,
        end_line: sym.endLine,
        exported: sym.exported ? 1 : 0,
        is_default: sym.isDefault ? 1 : 0,
        is_async: sym.isAsync ? 1 : 0,
        is_static: sym.isStatic ? 1 : 0,
        is_abstract: sym.isAbstract ? 1 : 0,
        parent_name: sym.parentName ?? null,
        jsdoc: sym.comment ?? null,
      }));
      imports = extracted.imports.map((source) => ({
        path: file.path,
        source,
      }));
      resolvedImports = resolveImports(
        file.path,
        extracted.importSpecs,
        resolverContext,
      );
    }
  } else if (canExtractStructure(language)) {
    const structure = extractMarkdownStructure(content);
    headings = structure.headings.map((h) => ({
      path: file.path,
      level: h.level,
      text: h.text,
      line: h.line,
    }));
    codeBlocks = structure.codeBlocks.map((cb) => ({
      path: file.path,
      language: cb.language,
      start_line: cb.startLine,
      end_line: cb.endLine,
    }));
  }

  return {
    file: fileRow,
    symbols,
    imports,
    resolvedImports,
    headings,
    codeBlocks,
  };
}

function buildEntriesFromCache(
  db: CacheDB,
  filePaths: string[],
  opts: SourceMapOptions,
): FileEntry[] {
  const entries: FileEntry[] = [];

  for (const relPath of filePaths) {
    const fileRow = db.getFile(relPath);
    if (!fileRow) continue;

    const fileAnnotation = opts.includeAnnotations
      ? db.getFileAnnotation(relPath) ?? undefined
      : undefined;
    const symbolAnnotations = opts.includeAnnotations
      ? db.getSymbolAnnotationMap(relPath)
      : new Map<string, string>();

    const refsMode = opts.refsMode ?? (opts.includeRefs ? "structural" : undefined);
    const refKinds =
      refsMode === "full" ? undefined : STRUCTURAL_REF_KINDS;
    const refsDirection = opts.refsDirection ?? "in";
    const maxRefs = opts.maxRefs;

    const symbols = db.getSymbols(relPath).map((sym) => {
      const key = buildSymbolAnnotationKey(
        sym.name,
        sym.kind,
        sym.parent_name,
        sym.signature ?? "",
      );
      let annotation = symbolAnnotations.get(key);
      if (!annotation && sym.signature) {
        const fallbackKey = buildSymbolAnnotationKey(
          sym.name,
          sym.kind,
          sym.parent_name,
          "",
        );
        annotation = symbolAnnotations.get(fallbackKey);
      }
      const signature = sym.signature ?? sym.name;
      const entry: SymbolEntry = {
        id: sym.id,
        name: sym.name,
        kind: sym.kind,
        signature,
        startLine: sym.start_line,
        endLine: sym.end_line,
        exported: sym.exported === 1,
        isDefault: sym.is_default === 1,
        isAsync: sym.is_async === 1,
        isStatic: sym.is_static === 1,
        isAbstract: sym.is_abstract === 1,
        parentName: sym.parent_name ?? undefined,
        comment: sym.jsdoc ?? undefined,
        annotation,
      };

      if (opts.includeRefs) {
        const refKey = sym.id
          ? { symbolId: sym.id }
          : {
              path: relPath,
              name: sym.name,
              kind: sym.kind,
              parent: sym.parent_name ?? null,
            };
        if (refsDirection === "in" || refsDirection === "both") {
          entry.incomingRefs = db.getReferenceList(
            "in",
            refKey,
            refKinds,
            maxRefs,
          );
        }
        if (refsDirection === "out" || refsDirection === "both") {
          entry.outgoingRefs = db.getReferenceList(
            "out",
            refKey,
            refKinds,
            maxRefs,
          );
        }
      }

      return entry;
    });

    const filteredSymbols = opts.exportedOnly
      ? symbols.filter((s) => s.exported)
      : symbols;

    const headingsRaw = opts.includeHeadings
      ? db.getHeadings(relPath).map((h) => ({
          level: h.level,
          text: h.text,
          line: h.line,
        }))
      : undefined;

    const headingsWithRanges = headingsRaw
      ? applyHeadingRanges(headingsRaw, fileRow.line_count)
      : undefined;

    const codeBlocksRaw = opts.includeCodeBlocks
      ? db.getCodeBlocks(relPath).map((cb) => ({
          language: cb.language,
          startLine: cb.start_line,
          endLine: cb.end_line,
        }))
      : undefined;

    const headings =
      headingsWithRanges &&
      (headingsWithRanges.length > 0 || fileRow.language === "markdown")
        ? headingsWithRanges
        : undefined;
    const codeBlocks =
      codeBlocksRaw &&
      (codeBlocksRaw.length > 0 || fileRow.language === "markdown")
        ? codeBlocksRaw
        : undefined;

    const imports = opts.includeImports ? db.getImports(relPath) : [];

    entries.push({
      path: relPath,
      language: fileRow.language,
      startLine: 1,
      endLine: fileRow.line_count,
      annotation: fileAnnotation,
      detailLevel: "full",
      symbols: filteredSymbols,
      headings,
      codeBlocks,
      imports,
      tokenEstimate: 0,
    });
  }

  return entries;
}

function updateCache(
  db: CacheDB,
  discovered: DiscoveredFile[],
  changes: FileChange[],
  touches: FileTouch[],
  resolverContext: ResolverContext,
  cppResolverContext: CppResolverContext,
  rustResolverContext: RustResolverContext,
): void {
  if (touches.length > 0) {
    const applyTouches = db.transaction(() => {
      for (const t of touches) {
        db.touchFile(t.path, t.mtime, t.size);
      }
    });
    applyTouches();
  }

  if (changes.length === 0) {
    if (touches.length > 0) db.updateLastUpdated();
    return;
  }

  const discoveredByPath = new Map<string, DiscoveredFile>();
  for (const file of discovered) {
    discoveredByPath.set(file.path, file);
  }

  const extractedByPath = new Map<string, Extracted | null>();
  for (const change of changes) {
    if (change.status === "added" || change.status === "modified") {
      const file = discoveredByPath.get(change.path);
      if (!file) {
        extractedByPath.set(change.path, null);
        continue;
      }
      extractedByPath.set(
        change.path,
        extractFileForCache(
          file,
          resolverContext,
          cppResolverContext,
          rustResolverContext,
        ),
      );
    }
  }

  const applyOne = db.transaction((change: FileChange) => {
    if (change.status === "deleted") {
      db.deleteFile(change.path);
      return;
    }

    const extracted = extractedByPath.get(change.path);
    if (!extracted) {
      db.deleteFile(change.path);
      return;
    }

    db.deleteFile(change.path);
    db.insertFile(extracted.file);
    db.insertSymbols(change.path, extracted.symbols);
    db.insertImports(change.path, extracted.imports);
    db.insertResolvedImports(change.path, extracted.resolvedImports);
    db.insertHeadings(change.path, extracted.headings);
    db.insertCodeBlocks(change.path, extracted.codeBlocks);
  });

  for (const change of changes) {
    applyOne(change);
  }

  db.updateLastUpdated();
}

function extractFileEntryNoCache(
  repoRoot: string,
  relPath: string,
  opts: SourceMapOptions,
): FileEntry | null {
  const fullPath = path.join(repoRoot, relPath);

  let content: string;
  let lineCount: number;
  try {
    const buf = fs.readFileSync(fullPath);
    if (buf.includes(0)) return null;
    content = buf.toString("utf-8");
    lineCount = content.split(/\r?\n/).length;
  } catch {
    return null;
  }

  const language = detectLanguage(relPath);

  let symbols: SymbolEntry[] = [];
  let imports: string[] = [];
  let headings: MarkdownHeading[] | undefined;
  let codeBlocks: MarkdownCodeBlock[] | undefined;

  if (canExtractSymbols(language)) {
    if (language === "cpp") {
      const extracted = extractCppSymbols(relPath, content, {
        includeComments: opts.includeComments,
      });
      symbols = opts.exportedOnly
        ? extracted.symbols.filter((s) => s.exported)
        : extracted.symbols;
      imports = opts.includeImports
        ? extracted.includes.map(formatIncludeSource)
        : [];
    } else {
      const extracted = extractFileSymbols(relPath, content, {
        includeComments: opts.includeComments,
      });
      symbols = opts.exportedOnly
        ? extracted.symbols.filter((s) => s.exported)
        : extracted.symbols;
      imports = opts.includeImports ? extracted.imports : [];
    }
  } else if (canExtractStructure(language)) {
    const structure = extractMarkdownStructure(content);
    headings = opts.includeHeadings ? structure.headings : undefined;
    codeBlocks = opts.includeCodeBlocks ? structure.codeBlocks : undefined;
  }

  return {
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
  };
}

function generateSourceMapNoCache(opts: SourceMapOptions): SourceMapResult {
  const filePaths = discoverFiles({
    repoRoot: opts.repoRoot,
    patterns: opts.patterns,
    ignore: opts.ignore,
  });

  const entries: FileEntry[] = [];

  for (const relPath of filePaths) {
    const entry = extractFileEntryNoCache(opts.repoRoot, relPath, opts);
    if (entry) entries.push(entry);
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
    repoRoot: opts.repoRoot,
    stats,
    files: finalEntries,
    totalTokens,
    codebaseTokens: undefined, // not available without cache
  };
}

export function refreshCache(
  options: SourceMapOptions,
): {
  db: CacheDB;
  filePaths: string[];
  opts: SourceMapOptions;
  changes: FileChange[];
  touches: FileTouch[];
} {
  const opts = { ...DEFAULT_OPTIONS, ...options } as SourceMapOptions;
  if (!opts.refsMode && opts.includeRefs) {
    opts.refsMode = "structural";
  }
  const { repoRoot } = opts;
  const { patterns, ignore } = normalizeScopePatterns(opts.patterns, opts.ignore);

  const db = openCache(repoRoot);
  db.ensureExtractorVersion(EXTRACTOR_VERSION);

  const filePaths = discoverFiles({
    repoRoot,
    patterns,
    ignore,
  });

  const discovered = statDiscoveredFiles(repoRoot, filePaths);
  const cached = filterCachedByScope(db.getCachedFiles(), patterns, ignore);

  let changes: FileChange[] = [];
  let touches: FileTouch[] = [];

  if (opts.forceRefresh) {
    const discoveredSet = new Set(discovered.map((f) => f.path));
    for (const file of discovered) {
      changes.push({
        path: file.path,
        status: cached.has(file.path) ? "modified" : "added",
      });
    }
    for (const cachedPath of cached.keys()) {
      if (!discoveredSet.has(cachedPath)) {
        changes.push({ path: cachedPath, status: "deleted" });
      }
    }
  } else {
    const result = detectChanges(discovered, cached);
    changes = result.changes;
    touches = result.touches;
  }

  const fileIndex = new Set(discovered.map((f) => f.path));
  const resolverContext = createResolverContext(repoRoot, fileIndex, {
    tsconfigPath: opts.tsconfigPath ?? null,
    useTsconfig: opts.useTsconfig,
  });
  const cppResolverContext = createCppResolverContext(repoRoot, fileIndex);
  const rustResolverContext = createRustResolverContext(repoRoot, fileIndex);

  updateCache(
    db,
    discovered,
    changes,
    touches,
    resolverContext,
    cppResolverContext,
    rustResolverContext,
  );

  if (opts.refsMode) {
    updateReferences(db, {
      repoRoot,
      filePaths,
      changes,
      refsMode: opts.refsMode,
      forceRefs: opts.forceRefs,
      tsconfigPath: opts.tsconfigPath,
      useTsconfig: opts.useTsconfig,
    });
  }

  return { db, filePaths, opts, changes, touches };
}

export function generateSourceMap(options: SourceMapOptions): SourceMapResult {
  const opts = { ...DEFAULT_OPTIONS, ...options } as SourceMapOptions;

  if (opts.useCache === false) {
    if (opts.includeRefs) {
      opts.includeRefs = false;
    }
    return generateSourceMapNoCache(opts);
  }

  const { db, filePaths } = refreshCache(opts);

  const entries = buildEntriesFromCache(db, filePaths, opts);

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
  const codebaseTokens = Math.ceil(db.getTotalCodebaseBytes() / 4);

  db.close();

  return {
    repoRoot: opts.repoRoot,
    stats,
    files: finalEntries,
    totalTokens,
    codebaseTokens,
  };
}
