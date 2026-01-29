import type { CacheDB } from "./cache/db.js";
import { buildSymbolAnnotationKey } from "./cache/annotations.js";
import type { TagMap } from "./types.js";
import { hasTags, normalizeTagMap, summarizeTags } from "./tags.js";

export type ExportSymbol = {
  name: string;
  kind: string;
  note?: string;
  tags?: TagMap;
};

export type ExportFile = {
  path: string;
  note?: string;
  tags?: TagMap;
  symbols: ExportSymbol[];
};

export type ExportIndex = {
  files: ExportFile[];
};

export function buildAnnotationIndex(
  db: CacheDB,
  opts: { includeAll?: boolean } = {},
): ExportIndex {
  const includeAll = opts.includeAll ?? false;
  const files: ExportFile[] = [];

  for (const path of db.listFiles()) {
    const note = db.getFileAnnotation(path) ?? undefined;
    const fileTags = normalizeTagMap(db.getFileAnnotationTags(path));
    const symbolNotes = db.getSymbolAnnotationMap(path);
    const symbolTags = db.getSymbolAnnotationTagsMap(path);

    const symbols: ExportSymbol[] = [];
    for (const sym of db.getSymbols(path)) {
      const key = buildSymbolAnnotationKey(
        sym.name,
        sym.kind,
        sym.parent_name,
        sym.signature ?? "",
      );
      let symNote = symbolNotes.get(key);
      if (!symNote && sym.signature) {
        const fallbackKey = buildSymbolAnnotationKey(
          sym.name,
          sym.kind,
          sym.parent_name,
          "",
        );
        symNote = symbolNotes.get(fallbackKey);
      }

      let symTags = symbolTags.get(key);
      if (!symTags && sym.signature) {
        const fallbackKey = buildSymbolAnnotationKey(
          sym.name,
          sym.kind,
          sym.parent_name,
          "",
        );
        symTags = symbolTags.get(fallbackKey);
      }

      const normalizedTags = normalizeTagMap(symTags);
      const annotated = Boolean(symNote) || hasTags(normalizedTags);
      if (!includeAll && !annotated) {
        continue;
      }

      symbols.push({
        name: sym.name,
        kind: sym.kind,
        note: symNote ?? undefined,
        tags: normalizedTags,
      });
    }

    const fileAnnotated = Boolean(note) || hasTags(fileTags);
    if (!includeAll && !fileAnnotated && symbols.length === 0) {
      continue;
    }

    symbols.sort((a, b) => a.name.localeCompare(b.name));

    files.push({
      path,
      note,
      tags: fileTags,
      symbols,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return { files };
}

export function renderAnnotationIndexMarkdown(index: ExportIndex): string {
  const lines: string[] = ["# Codemap Annotation Index", ""]; 

  for (const file of index.files) {
    lines.push(`## ${file.path}`);
    if (file.note) {
      lines.push(`- Note: ${file.note}`);
    }
    if (file.tags && hasTags(file.tags)) {
      lines.push(`- Tags: ${summarizeTags(file.tags)}`);
    }
    if (file.symbols.length > 0) {
      lines.push("- Symbols:");
      for (const sym of file.symbols) {
        const label = `${sym.kind} ${sym.name}`;
        lines.push(`  - ${label}`);
        if (sym.note) {
          lines.push(`    - Note: ${sym.note}`);
        }
        if (sym.tags && hasTags(sym.tags)) {
          lines.push(`    - Tags: ${summarizeTags(sym.tags)}`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
