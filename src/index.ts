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
} from "./types.js";
