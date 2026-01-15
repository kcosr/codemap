export type Language =
  | "typescript"
  | "javascript"
  | "markdown"
  | "cpp"
  | "other";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "enum"
  | "enum_member"
  | "method"
  | "property"
  | "constructor"
  | "getter"
  | "setter"
  | "namespace"
  | "struct"
  | "destructor";

export type ReferenceKind =
  | "import"
  | "reexport"
  | "call"
  | "instantiate"
  | "type"
  | "extends"
  | "implements"
  | "read"
  | "write";

export type ReferenceItem = {
  refPath: string;
  refLine: number;
  refCol?: number | null;
  symbolPath: string | null;
  symbolName: string;
  symbolKind: string | null;
  symbolParent: string | null;
  refKind: ReferenceKind;
  moduleSpecifier?: string | null;
};

export type ReferenceList = {
  total: number;
  sampled: number;
  byKind: Partial<Record<ReferenceKind, number>>;
  items: ReferenceItem[];
};

export type SymbolEntry = {
  id?: number;
  name: string;
  kind: SymbolKind;
  signature: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  isDefault: boolean;
  isAsync: boolean;
  isStatic: boolean;
  isAbstract: boolean;
  parentName?: string;
  comment?: string;
  annotation?: string;
  incomingRefs?: ReferenceList;
  outgoingRefs?: ReferenceList;
  children?: SymbolEntry[];
};

export type MarkdownHeading = {
  level: number;
  text: string;
  line: number;
};

export type MarkdownCodeBlock = {
  language: string | null;
  startLine: number;
  endLine: number;
};

export type ImportKind =
  | "import"
  | "export_from"
  | "dynamic_import"
  | "require"
  | "side_effect"
  | "include";

export type ResolutionMethod =
  | "relative"
  | "paths"
  | "baseUrl"
  | "ts"
  | "node"
  | "include";

export type ImportSpec = {
  source: string;
  importedNames: string[];
  kind: ImportKind;
  isTypeOnly: boolean;
  span?: { start: number; end: number };
  isLiteral?: boolean;
};

export type ResolvedImport = {
  source: string;
  resolvedPath: string | null;
  importedNames: string[];
  kind: ImportKind;
  isTypeOnly: boolean;
  isExternal: boolean;
  isBuiltin: boolean;
  packageName?: string;
  resolutionMethod?: ResolutionMethod;
  unresolvedReason?: string;
  span?: { start: number; end: number };
};

export type DetailLevel =
  | "full"
  | "standard"
  | "compact"
  | "minimal"
  | "outline";

export type FileEntry = {
  path: string;
  language: Language;
  startLine: number;
  endLine: number;
  annotation?: string;
  detailLevel: DetailLevel;
  symbols: SymbolEntry[];
  headings?: MarkdownHeading[];
  codeBlocks?: MarkdownCodeBlock[];
  imports: string[];
  tokenEstimate: number;
};

export type ProjectStats = {
  totalFiles: number;
  totalSymbols: number;
  byLanguage: Record<string, number>;
  bySymbolKind: Record<string, number>;
};

export type SourceMapResult = {
  repoRoot: string;
  stats: ProjectStats | null;
  files: FileEntry[];
  totalTokens: number;
  codebaseTokens?: number;
};

export type SourceMapOptions = {
  // Target
  repoRoot: string;
  patterns?: string[];
  ignore?: string[];

  // Content control
  includeComments: boolean;
  includeImports: boolean;
  includeHeadings: boolean;
  includeCodeBlocks: boolean;
  includeStats: boolean;
  includeAnnotations: boolean;
  exportedOnly: boolean;

  // Budget
  tokenBudget?: number;

  // Cache
  useCache?: boolean;
  forceRefresh?: boolean;
  tsconfigPath?: string;
  useTsconfig?: boolean;

  // References
  includeRefs?: boolean;
  refsMode?: "structural" | "full";
  refsDirection?: "in" | "out" | "both";
  maxRefs?: number;
  forceRefs?: boolean;

  // Output
  output: "text" | "json";
};
