import type { FileEntry, ProjectStats } from "./types.js";

export function computeStats(files: FileEntry[]): ProjectStats {
  const byLanguage: Record<string, number> = Object.create(null);
  const bySymbolKind: Record<string, number> = Object.create(null);
  let totalSymbols = 0;

  const countSymbol = (sym: FileEntry["symbols"][number]): void => {
    bySymbolKind[sym.kind] = (bySymbolKind[sym.kind] ?? 0) + 1;
    totalSymbols++;
    if (!sym.children) return;
    for (const child of sym.children) {
      countSymbol(child);
    }
  };

  for (const file of files) {
    byLanguage[file.language] = (byLanguage[file.language] ?? 0) + 1;

    for (const sym of file.symbols) {
      countSymbol(sym);
    }
  }

  return {
    totalFiles: files.length,
    totalSymbols,
    byLanguage,
    bySymbolKind,
  };
}
