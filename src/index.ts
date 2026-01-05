export { generateSourceMap } from "./sourceMap.js";
export { renderText, renderJson } from "./render.js";

export { extractFileSymbols } from "./symbols.js";
export { extractMarkdownStructure } from "./markdown.js";
export { discoverFiles } from "./fileDiscovery.js";
export {
  detectLanguage,
  canExtractSymbols,
  canExtractStructure,
} from "./languages.js";
export { computeStats } from "./stats.js";

// Cache and dependency graph
export { openCache } from "./cache/db.js";
export type { CacheDB, CacheStats } from "./cache/db.js";
export {
  buildDependencyTree,
  buildReverseDependencyTree,
  findCircularDependencies,
  renderDependencyTree,
} from "./deps/tree.js";
export type { DependencyTreeNode } from "./deps/tree.js";

export type {
  Language,
  SymbolKind,
  SymbolEntry,
  MarkdownHeading,
  MarkdownCodeBlock,
  DetailLevel,
  FileEntry,
  ProjectStats,
  SourceMapResult,
  SourceMapOptions,
  ImportKind,
  ResolvedImport,
} from "./types.js";
