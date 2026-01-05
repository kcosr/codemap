import type { FileEntry, ProjectStats } from "./types.js";

export function computeStats(files: FileEntry[]): ProjectStats {
  const byLanguage: Record<string, number> = {};
  const bySymbolKind: Record<string, number> = {};
  let totalSymbols = 0;

  for (const file of files) {
    byLanguage[file.language] = (byLanguage[file.language] ?? 0) + 1;

    for (const sym of file.symbols) {
      bySymbolKind[sym.kind] = (bySymbolKind[sym.kind] ?? 0) + 1;
      totalSymbols++;

      if (sym.children) {
        for (const child of sym.children) {
          bySymbolKind[child.kind] = (bySymbolKind[child.kind] ?? 0) + 1;
          totalSymbols++;
        }
      }
    }
  }

  return {
    totalFiles: files.length,
    totalSymbols,
    byLanguage,
    bySymbolKind,
  };
}
