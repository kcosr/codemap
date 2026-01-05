import type {
  SourceMapResult,
  FileEntry,
  SourceMapOptions,
  SymbolEntry,
  DetailLevel,
  SymbolKind,
} from "./types.js";

const GROUP_ORDER: SymbolKind[] = [
  "type",
  "interface",
  "enum",
  "class",
  "function",
  "variable",
];

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

  if (sym.annotation) {
    lines.push(`${indent}  [note: ${sym.annotation}]`);
  }

  if (level === "full" || level === "standard") {
    if (opts.includeComments && sym.comment) {
      const maxLen = level === "standard" ? 160 : undefined;
      lines.push(`${indent}  /** ${compactComment(sym.comment, maxLen)} */`);
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

export function renderFileEntry(
  file: FileEntry,
  opts: SourceMapOptions,
): string {
  const lines: string[] = [];

  lines.push(`${file.path} [${file.startLine}-${file.endLine}]`);

  if (file.detailLevel === "outline") {
    return lines.join("\n");
  }

  if (file.annotation) {
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
