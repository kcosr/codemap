import type {
  SourceMapResult,
  FileEntry,
  SourceMapOptions,
  SymbolEntry,
  DetailLevel,
  SymbolKind,
  ReferenceKind,
  ReferenceList,
  ReferenceItem,
} from "./types.js";

const GROUP_ORDER: SymbolKind[] = [
  "type",
  "interface",
  "enum",
  "class",
  "function",
  "variable",
];

const STRUCTURAL_REF_KINDS = new Set<ReferenceKind>([
  "import",
  "reexport",
  "call",
  "instantiate",
  "type",
  "extends",
  "implements",
]);

function organizeSymbols(symbols: SymbolEntry[]): SymbolEntry[] {
  const topLevel: SymbolEntry[] = [];
  const byParent = new Map<string, SymbolEntry[]>();

  for (const sym of symbols) {
    if (sym.parentName) {
      const siblings = byParent.get(sym.parentName) ?? [];
      siblings.push(sym);
      byParent.set(sym.parentName, siblings);
    } else {
      topLevel.push({ ...sym });
    }
  }

  for (const sym of topLevel) {
    if (sym.kind === "class" || sym.kind === "enum") {
      const children = byParent.get(sym.name);
      if (children) {
        sym.children = [...children].sort((a, b) => a.startLine - b.startLine);
      }
    }
  }

  return topLevel.sort((a, b) => a.startLine - b.startLine);
}

function groupSymbolsByKind(
  symbols: SymbolEntry[],
): Array<[SymbolKind | string, SymbolEntry[]]> {
  const groups = new Map<SymbolKind | string, SymbolEntry[]>();

  for (const sym of symbols) {
    if (sym.parentName) continue;
    const list = groups.get(sym.kind) ?? [];
    list.push(sym);
    groups.set(sym.kind, list);
  }

  const ordered: Array<[SymbolKind | string, SymbolEntry[]]> = [];
  for (const kind of GROUP_ORDER) {
    const list = groups.get(kind);
    if (list) {
      list.sort((a, b) => a.startLine - b.startLine);
      ordered.push([kind, list]);
      groups.delete(kind);
    }
  }

  for (const [kind, list] of [...groups.entries()].sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])),
  )) {
    list.sort((a, b) => a.startLine - b.startLine);
    ordered.push([kind, list]);
  }

  return ordered;
}

function formatSymbolLabel(sym: SymbolEntry, level: DetailLevel): string {
  if (level === "minimal") return sym.name;

  if (sym.kind === "class" || sym.kind === "interface" || sym.kind === "enum") {
    return `${sym.kind} ${sym.signature || sym.name}`;
  }

  return sym.signature || sym.name;
}

function compactComment(comment: string, maxLen?: number): string {
  const singleLine = comment.replace(/\s+/g, " ").trim();
  if (!maxLen || singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen)}...`;
}

function renderSymbol(
  sym: SymbolEntry,
  level: DetailLevel,
  opts: SourceMapOptions,
  indent: string,
): string[] {
  const lines: string[] = [];
  const lineRange = `${sym.startLine}-${sym.endLine}: `;
  let line = `${indent}${lineRange}${formatSymbolLabel(sym, level)}`;
  if (sym.exported) line += " [exported]";
  lines.push(line);

  if (opts.includeAnnotations && sym.annotation) {
    lines.push(`${indent}  [note: ${sym.annotation}]`);
  }

  if (level === "full" || level === "standard") {
    if (opts.includeComments && sym.comment) {
      const maxLen = level === "standard" ? 160 : undefined;
      lines.push(`${indent}  /** ${compactComment(sym.comment, maxLen)} */`);
    }
  }

  if (opts.includeRefs) {
    const refLines = renderReferenceSections(sym, level, opts, indent);
    if (refLines.length > 0) {
      lines.push(...refLines);
    }
  }

  if (sym.children && sym.children.length > 0) {
    if (level !== "minimal" && level !== "outline") {
      for (const child of sym.children) {
        lines.push(...renderSymbol(child, level, opts, `${indent}  `));
      }
    }
  }

  return lines;
}

function renderReferenceSections(
  sym: SymbolEntry,
  level: DetailLevel,
  opts: SourceMapOptions,
  indent: string,
): string[] {
  if (level === "minimal" || level === "outline") return [];

  const direction = opts.refsDirection ?? "in";
  const showOutgoing = direction === "out" || (direction === "both" && level === "full");
  const showIncoming = direction === "in" || direction === "both";

  const filterKinds =
    opts.refsMode === "full" && level !== "full" ? STRUCTURAL_REF_KINDS : null;

  const lines: string[] = [];

  if (showIncoming && sym.incomingRefs) {
    lines.push(
      ...renderReferenceBlock(
        "refs in",
        sym.incomingRefs,
        filterKinds,
        level,
        indent,
        "in",
      ),
    );
  }

  if (showOutgoing && sym.outgoingRefs) {
    lines.push(
      ...renderReferenceBlock(
        "refs out",
        sym.outgoingRefs,
        filterKinds,
        level,
        indent,
        "out",
      ),
    );
  }

  return lines;
}

function renderReferenceBlock(
  label: string,
  refs: ReferenceList,
  filterKinds: Set<ReferenceKind> | null,
  level: DetailLevel,
  indent: string,
  direction: "in" | "out",
): string[] {
  const filtered = filterKinds ? filterReferenceList(refs, filterKinds) : refs;
  if (filtered.total === 0) return [];

  const lines: string[] = [];
  const kindSummary = formatReferenceKinds(filtered.byKind);
  let header = `${indent}  ${label}: ${filtered.total}`;
  if (filtered.sampled < filtered.total) {
    header += ` (sampled ${filtered.sampled})`;
  }
  if (kindSummary) {
    header += ` [${kindSummary}]`;
  }
  lines.push(header);

  if (level === "compact") return lines;

  const maxItems = level === "full" ? filtered.items.length : 5;
  const items = filtered.items.slice(0, maxItems);
  const itemIndent = `${indent}    `;
  for (const item of items) {
    lines.push(`${itemIndent}- ${formatReferenceItem(item, direction)}`);
  }

  if (filtered.items.length > items.length) {
    lines.push(`${itemIndent}... (${filtered.items.length - items.length} more)`);
  }

  return lines;
}

function filterReferenceList(
  refs: ReferenceList,
  allowed: Set<ReferenceKind>,
): ReferenceList {
  const byKind: Partial<Record<ReferenceKind, number>> = {};
  let total = 0;
  for (const kind of Object.keys(refs.byKind) as ReferenceKind[]) {
    if (!allowed.has(kind)) continue;
    const count = refs.byKind[kind] ?? 0;
    if (count > 0) {
      byKind[kind] = count;
      total += count;
    }
  }

  const items = refs.items.filter((item) => allowed.has(item.refKind));
  const sampled = Math.min(refs.sampled, total);
  return {
    total,
    sampled,
    byKind,
    items,
  };
}

function formatReferenceKinds(
  byKind: Partial<Record<ReferenceKind, number>>,
): string {
  const parts: string[] = [];
  for (const [kind, count] of Object.entries(byKind).sort()) {
    if (!count) continue;
    parts.push(`${kind}: ${count}`);
  }
  return parts.join(", ");
}

function formatReferenceItem(item: ReferenceItem, direction: "in" | "out"): string {
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

export function renderFileEntry(
  file: FileEntry,
  opts: SourceMapOptions,
): string {
  const lines: string[] = [];

  lines.push(`${file.path} [${file.startLine}-${file.endLine}]`);

  if (file.detailLevel === "outline") {
    return lines.join("\n");
  }

  if (opts.includeAnnotations && file.annotation) {
    lines.push(`  [note: ${file.annotation}]`);
  }

  if (file.symbols.length > 0) {
    const organized = organizeSymbols(file.symbols);
    const grouped = groupSymbolsByKind(organized);
    for (const [kind, symbols] of grouped) {
      lines.push(`  ${kind}:`);
      for (const sym of symbols) {
        lines.push(...renderSymbol(sym, file.detailLevel, opts, "    "));
      }
    }
  }

  if (file.headings && file.headings.length > 0) {
    lines.push("  headings:");
    for (const h of file.headings) {
      const prefix = "#".repeat(h.level);
      lines.push(`    ${h.line}: ${prefix} ${h.text}`);
    }
  }

  if (file.codeBlocks && file.codeBlocks.length > 0) {
    const byLang: Record<string, number> = {};
    for (const cb of file.codeBlocks) {
      const lang = cb.language ?? "unknown";
      byLang[lang] = (byLang[lang] ?? 0) + 1;
    }
    const summary = Object.entries(byLang)
      .map(([lang, count]) => `${lang}: ${count}`)
      .join(", ");
    lines.push(`  code blocks: ${file.codeBlocks.length} (${summary})`);
  }

  if (opts.includeImports && file.imports.length > 0) {
    lines.push("  imports:");
    for (const imp of file.imports) {
      lines.push(`    - ${imp}`);
    }
  }

  return lines.join("\n");
}

export function renderText(
  result: SourceMapResult,
  opts: SourceMapOptions,
): string {
  const lines: string[] = [];

  if (result.stats && opts.includeStats) {
    lines.push("# Project Overview");
    lines.push("");
    lines.push("## Languages");
    for (const [lang, count] of Object.entries(result.stats.byLanguage).sort(
      (a, b) => b[1] - a[1],
    )) {
      lines.push(`- ${lang}: ${count} files`);
    }
    lines.push("");
    lines.push("## Statistics");
    lines.push(`- Total files: ${result.stats.totalFiles}`);
    lines.push(`- Total symbols: ${result.stats.totalSymbols}`);
    for (const [kind, count] of Object.entries(result.stats.bySymbolKind).sort(
      (a, b) => b[1] - a[1],
    )) {
      lines.push(`  - ${kind}: ${count}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  for (const file of result.files) {
    lines.push(renderFileEntry(file, opts));
    lines.push("");
  }

  lines.push("---");
  lines.push(`Files: ${result.files.length}`);
  let tokenLine = `Estimated tokens: ${result.totalTokens.toLocaleString()}`;
  if (result.codebaseTokens) {
    tokenLine += ` (codebase: ~${result.codebaseTokens.toLocaleString()})`;
  }
  lines.push(tokenLine);

  return lines.join("\n");
}

export function renderJson(result: SourceMapResult): string {
  return JSON.stringify(
    {
      stats: result.stats,
      total_tokens: result.totalTokens,
      codebase_tokens: result.codebaseTokens ?? null,
      files: result.files.map((f) => ({
        path: f.path,
        language: f.language,
        lines: [f.startLine, f.endLine],
        detail_level: f.detailLevel,
        token_estimate: f.tokenEstimate,
        symbols: f.symbols.map((s) => ({
          name: s.name,
          kind: s.kind,
          signature: s.signature,
          lines: [s.startLine, s.endLine],
          exported: s.exported,
          is_default: s.isDefault,
          is_async: s.isAsync,
          is_static: s.isStatic,
          is_abstract: s.isAbstract,
          parent_name: s.parentName ?? null,
          annotation: s.annotation ?? null,
          comment: s.comment ?? null,
          incoming_refs: s.incomingRefs
            ? {
                total: s.incomingRefs.total,
                sampled: s.incomingRefs.sampled,
                by_kind: s.incomingRefs.byKind,
                items: s.incomingRefs.items.map((item) => ({
                  ref_path: item.refPath,
                  ref_line: item.refLine,
                  ref_col: item.refCol ?? null,
                  symbol_path: item.symbolPath,
                  symbol_name: item.symbolName,
                  symbol_kind: item.symbolKind,
                  symbol_parent: item.symbolParent ?? null,
                  ref_kind: item.refKind,
                  module_specifier: item.moduleSpecifier ?? null,
                })),
              }
            : null,
          outgoing_refs: s.outgoingRefs
            ? {
                total: s.outgoingRefs.total,
                sampled: s.outgoingRefs.sampled,
                by_kind: s.outgoingRefs.byKind,
                items: s.outgoingRefs.items.map((item) => ({
                  ref_path: item.refPath,
                  ref_line: item.refLine,
                  ref_col: item.refCol ?? null,
                  symbol_path: item.symbolPath,
                  symbol_name: item.symbolName,
                  symbol_kind: item.symbolKind,
                  symbol_parent: item.symbolParent ?? null,
                  ref_kind: item.refKind,
                  module_specifier: item.moduleSpecifier ?? null,
                })),
              }
            : null,
        })),
        annotation: f.annotation ?? null,
        headings: f.headings ?? null,
        code_blocks: f.codeBlocks ?? null,
        imports: f.imports,
      })),
    },
    null,
    2,
  );
}
