export { generateSourceMap } from "./sourceMap.js";
export { renderText, renderJson } from "./render.js";
export { buildAnnotationIndex, renderAnnotationIndexMarkdown } from "./export.js";

export { extractFileSymbols } from "./symbols.js";
export { extractMarkdownStructure } from "./markdown.js";
export { discoverFiles } from "./fileDiscovery.js";
export {
  detectLanguage,
  canExtractSymbols,
  canExtractStructure,
  canExtractReferences,
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
export {
  buildCallGraph,
  buildCallersGraph,
  renderCallGraph,
} from "./refs/call-graph.js";
export type { CallGraphNode } from "./refs/call-graph.js";
export {
  buildSubtypeHierarchy,
  buildSupertypeHierarchy,
  renderTypeHierarchy,
} from "./refs/type-hierarchy.js";
export type { TypeHierarchyNode } from "./refs/type-hierarchy.js";

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
  ReferenceKind,
  ReferenceItem,
  ReferenceList,
  TagEntry,
  TagMap,
} from "./types.js";
