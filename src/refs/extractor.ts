import path from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  type SourceFile,
  type Symbol as MorphSymbol,
  ts,
} from "ts-morph";
import type { CacheDB, SymbolRowWithId } from "../cache/db.js";
import type { ReferenceKind } from "../types.js";
import type { ReferenceRow } from "../cache/references.js";

export type ReferenceMode = "structural" | "full";

type SymbolInfo = {
  id: number | null;
  name: string;
  kind: string | null;
  parent: string | null;
  path: string | null;
};

const ASSIGNMENT_OPERATOR_KINDS = new Set<SyntaxKind>([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
]);

export class SymbolIndex {
  private db: CacheDB;
  private repoRoot: string;
  private cache = new Map<string, Map<string, SymbolRowWithId>>();

  constructor(db: CacheDB, repoRoot: string) {
    this.db = db;
    this.repoRoot = repoRoot;
  }

  getSymbolInfoFromDeclaration(decl: Node, relPath?: string | null): SymbolInfo | null {
    const name = getDeclarationName(decl);
    const kind = getDeclarationKind(decl);
    if (!name || !kind) return null;

    const parent = getDeclarationParentName(decl);
    const startLine = decl.getStartLineNumber();
    const pathForLookup = relPath ?? toRepoPath(this.repoRoot, decl.getSourceFile().getFilePath());
    const symbolRow =
      pathForLookup && startLine
        ? this.getSymbolByKey(pathForLookup, kind, name, parent, startLine)
        : null;

    return {
      id: symbolRow?.id ?? null,
      name,
      kind,
      parent,
      path: pathForLookup ?? null,
    };
  }

  private getSymbolByKey(
    relPath: string,
    kind: string,
    name: string,
    parent: string | null,
    startLine: number,
  ): SymbolRowWithId | null {
    const map = this.getFileMap(relPath);
    const key = buildSymbolKey(kind, name, parent, startLine);
    return map.get(key) ?? null;
  }

  private getFileMap(relPath: string): Map<string, SymbolRowWithId> {
    const cached = this.cache.get(relPath);
    if (cached) return cached;
    const rows = this.db.getSymbols(relPath);
    const map = new Map<string, SymbolRowWithId>();
    for (const row of rows) {
      const key = buildSymbolKey(
        row.kind,
        row.name,
        row.parent_name ?? null,
        row.start_line,
      );
      map.set(key, row);
    }
    this.cache.set(relPath, map);
    return map;
  }
}

export function loadProject(
  repoRoot: string,
  filePaths: string[],
  tsconfigPath: string | null,
): Project {
  if (tsconfigPath) {
    return new Project({ tsConfigFilePath: tsconfigPath });
  }

  const project = new Project({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      strict: false,
      skipLibCheck: true,
      noEmit: true,
    },
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipLoadingLibFiles: true,
  });

  const absPaths = filePaths.map((rel) => path.join(repoRoot, rel));
  project.addSourceFilesAtPaths(absPaths);
  return project;
}

export function extractFileReferences(
  sourceFile: SourceFile,
  relPath: string,
  repoRoot: string,
  symbolIndex: SymbolIndex,
  refsMode: ReferenceMode,
): ReferenceRow[] {
  const refs: ReferenceRow[] = [];

  sourceFile.forEachDescendant((node) => {
    const extracted = resolveReferenceSite(
      node,
      relPath,
      repoRoot,
      symbolIndex,
      refsMode,
    );
    if (!extracted || extracted.length === 0) return;
    refs.push(...extracted);
  });

  return refs;
}

function resolveReferenceSite(
  node: Node,
  relPath: string,
  repoRoot: string,
  symbolIndex: SymbolIndex,
  refsMode: ReferenceMode,
): ReferenceRow[] | null {
  if (Node.isImportDeclaration(node)) {
    return resolveImportRef(node, relPath, repoRoot, symbolIndex);
  }

  if (Node.isExportDeclaration(node)) {
    return resolveReexportRef(node, relPath, repoRoot, symbolIndex);
  }

  if (Node.isCallExpression(node)) {
    const ref = resolveCallRef(node, relPath, repoRoot, symbolIndex);
    return ref ? [ref] : null;
  }

  if (Node.isNewExpression(node)) {
    const ref = resolveNewRef(node, relPath, repoRoot, symbolIndex);
    return ref ? [ref] : null;
  }

  if (Node.isHeritageClause(node)) {
    return resolveHeritageRef(node, relPath, repoRoot, symbolIndex);
  }

  if (Node.isTypeReference(node)) {
    const inHeritage = node.getFirstAncestorByKind(SyntaxKind.HeritageClause);
    if (inHeritage) return null;
    const ref = resolveTypeRef(node, relPath, repoRoot, symbolIndex);
    return ref ? [ref] : null;
  }

  if (refsMode === "full" && Node.isIdentifier(node)) {
    const ref = resolveReadWriteRefIfSafe(node, relPath, repoRoot, symbolIndex);
    return ref ? [ref] : null;
  }

  return null;
}

function resolveImportRef(
  node: Node,
  relPath: string,
  repoRoot: string,
  symbolIndex: SymbolIndex,
): ReferenceRow[] {
  const decl = node.asKindOrThrow(SyntaxKind.ImportDeclaration);
  const refs: ReferenceRow[] = [];
  const moduleSpecifier = decl.getModuleSpecifierValue();
  const moduleSourceFile = decl.getModuleSpecifierSourceFile();
  const modulePath = moduleSourceFile
    ? toRepoPath(repoRoot, moduleSourceFile.getFilePath())
    : null;

  const fromInfo = resolveFromSymbolInfo(node, relPath, symbolIndex);

  const defaultImport = decl.getDefaultImport();
  if (defaultImport) {
    const ref = buildReferenceFromNode(
      defaultImport,
      relPath,
      fromInfo,
      resolveSymbolInfo(defaultImport, repoRoot, symbolIndex),
      "import",
      moduleSpecifier,
      modulePath,
    );
    if (ref) refs.push(ref);
  }

  const namespaceImport = decl.getNamespaceImport();
  if (namespaceImport) {
    const ref = buildReferenceFromNode(
      namespaceImport,
      relPath,
      fromInfo,
      resolveSymbolInfo(namespaceImport, repoRoot, symbolIndex),
      "import",
      moduleSpecifier,
      modulePath,
      namespaceImport.getText(),
      "namespace",
    );
    if (ref) refs.push(ref);
  }

  const namedImports = decl.getNamedImports();
  for (const spec of namedImports) {
    const nameNode = spec.getNameNode();
    const ref = buildReferenceFromNode(
      nameNode,
      relPath,
      fromInfo,
      resolveSymbolInfo(nameNode, repoRoot, symbolIndex),
      "import",
      moduleSpecifier,
      modulePath,
    );
    if (ref) refs.push(ref);
  }

  if (!defaultImport && !namespaceImport && namedImports.length === 0) {
    const moduleNode = decl.getModuleSpecifier();
    if (!moduleNode) return refs;
    const ref = buildReferenceFromNode(
      moduleNode,
      relPath,
      fromInfo,
      null,
      "import",
      moduleSpecifier,
      modulePath,
      "*",
      "module",
    );
    if (ref) refs.push(ref);
  }

  return refs;
}

function resolveReexportRef(
  node: Node,
  relPath: string,
  repoRoot: string,
  symbolIndex: SymbolIndex,
): ReferenceRow[] | null {
  const decl = node.asKindOrThrow(SyntaxKind.ExportDeclaration);
  const moduleSpecifier = decl.getModuleSpecifierValue();
  if (!moduleSpecifier) return null;

  const moduleSourceFile = decl.getModuleSpecifierSourceFile();
  const modulePath = moduleSourceFile
    ? toRepoPath(repoRoot, moduleSourceFile.getFilePath())
    : null;

  const fromInfo = resolveFromSymbolInfo(node, relPath, symbolIndex);
  const refs: ReferenceRow[] = [];

  const namedExports = decl.getNamedExports();
  if (namedExports.length > 0) {
    for (const spec of namedExports) {
      const nameNode = spec.getNameNode();
      const ref = buildReferenceFromNode(
        nameNode,
        relPath,
        fromInfo,
        resolveSymbolInfo(nameNode, repoRoot, symbolIndex),
        "reexport",
        moduleSpecifier,
        modulePath,
      );
      if (ref) refs.push(ref);
    }
    return refs;
  }

  const namespaceExport = decl.getNamespaceExport();
  if (namespaceExport) {
    const ref = buildReferenceFromNode(
      namespaceExport.getNameNode(),
      relPath,
      fromInfo,
      null,
      "reexport",
      moduleSpecifier,
      modulePath,
      namespaceExport.getName(),
      "namespace",
    );
    if (ref) refs.push(ref);
    return refs;
  }

  const ref = buildReferenceFromNode(
    decl.getModuleSpecifier() ?? decl,
    relPath,
    fromInfo,
    null,
    "reexport",
    moduleSpecifier,
    modulePath,
    "*",
    "module",
  );
  return ref ? [ref] : null;
}

function resolveCallRef(
  node: Node,
  relPath: string,
  repoRoot: string,
  symbolIndex: SymbolIndex,
): ReferenceRow | null {
  const callExpr = node.asKindOrThrow(SyntaxKind.CallExpression);
  const expr = callExpr.getExpression();
  const symbolInfo = resolveSymbolInfo(expr, repoRoot, symbolIndex);
  if (!symbolInfo) return null;
  const fromInfo = resolveFromSymbolInfo(node, relPath, symbolIndex);
  return buildReferenceFromNode(
    expr,
    relPath,
    fromInfo,
    symbolInfo,
    "call",
    null,
    symbolInfo.path,
  );
}

function resolveNewRef(
  node: Node,
  relPath: string,
  repoRoot: string,
  symbolIndex: SymbolIndex,
): ReferenceRow | null {
  const newExpr = node.asKindOrThrow(SyntaxKind.NewExpression);
  const expr = newExpr.getExpression();
  const symbolInfo = resolveSymbolInfo(expr, repoRoot, symbolIndex);
  if (!symbolInfo) return null;
  const fromInfo = resolveFromSymbolInfo(node, relPath, symbolIndex);
  return buildReferenceFromNode(
    expr,
    relPath,
    fromInfo,
    symbolInfo,
    "instantiate",
    null,
    symbolInfo.path,
  );
}

function resolveTypeRef(
  node: Node,
  relPath: string,
  repoRoot: string,
  symbolIndex: SymbolIndex,
): ReferenceRow | null {
  const typeRef = node.asKindOrThrow(SyntaxKind.TypeReference);
  const nameNode = typeRef.getTypeName();
  const symbolInfo = resolveSymbolInfo(nameNode, repoRoot, symbolIndex);
  if (!symbolInfo) return null;
  const fromInfo = resolveFromSymbolInfo(node, relPath, symbolIndex);
  return buildReferenceFromNode(
    nameNode,
    relPath,
    fromInfo,
    symbolInfo,
    "type",
    null,
    symbolInfo.path,
  );
}

function resolveHeritageRef(
  node: Node,
  relPath: string,
  repoRoot: string,
  symbolIndex: SymbolIndex,
): ReferenceRow[] {
  const clause = node.asKindOrThrow(SyntaxKind.HeritageClause);
  const token = clause.getToken();
  const refKind: ReferenceKind =
    token === SyntaxKind.ExtendsKeyword ? "extends" : "implements";
  const fromInfo = resolveFromSymbolInfo(node, relPath, symbolIndex);
  const refs: ReferenceRow[] = [];

  for (const typeNode of clause.getTypeNodes()) {
    const expr = typeNode.getExpression();
    const symbolInfo = resolveSymbolInfo(expr, repoRoot, symbolIndex);
    if (!symbolInfo) continue;
    const ref = buildReferenceFromNode(
      expr,
      relPath,
      fromInfo,
      symbolInfo,
      refKind,
      null,
      symbolInfo.path,
    );
    if (ref) refs.push(ref);
  }

  return refs;
}

function resolveReadWriteRefIfSafe(
  node: Node,
  relPath: string,
  repoRoot: string,
  symbolIndex: SymbolIndex,
): ReferenceRow | null {
  const ident = node.asKindOrThrow(SyntaxKind.Identifier);
  const access = classifyIdentifierAccess(ident);
  if (!access) return null;

  const symbolInfo = resolveSymbolInfo(ident, repoRoot, symbolIndex);
  if (!symbolInfo) return null;
  const fromInfo = resolveFromSymbolInfo(node, relPath, symbolIndex);

  return buildReferenceFromNode(
    ident,
    relPath,
    fromInfo,
    symbolInfo,
    access,
    null,
    symbolInfo.path,
  );
}

function classifyIdentifierAccess(
  ident: Node,
): ReferenceKind | null {
  const parent = ident.getParent();
  if (!parent) return null;

  if (Node.isVariableDeclaration(parent) && parent.getNameNode() === ident) {
    return null;
  }
  if (Node.isFunctionDeclaration(parent) && parent.getNameNode() === ident) {
    return null;
  }
  if (Node.isClassDeclaration(parent) && parent.getNameNode() === ident) {
    return null;
  }
  if (Node.isInterfaceDeclaration(parent) && parent.getNameNode() === ident) {
    return null;
  }
  if (Node.isEnumDeclaration(parent) && parent.getNameNode() === ident) {
    return null;
  }
  if (Node.isTypeAliasDeclaration(parent) && parent.getNameNode() === ident) {
    return null;
  }
  if (Node.isParameterDeclaration(parent) && parent.getNameNode() === ident) {
    return null;
  }

  if (
    Node.isImportSpecifier(parent) ||
    Node.isImportClause(parent) ||
    Node.isNamespaceImport(parent) ||
    Node.isExportSpecifier(parent)
  ) {
    return null;
  }

  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ident) {
    return null;
  }

  if (Node.isCallExpression(parent) && parent.getExpression() === ident) {
    return null;
  }
  if (Node.isNewExpression(parent) && parent.getExpression() === ident) {
    return null;
  }

  if (Node.isTypeReference(parent)) {
    return null;
  }
  if (Node.isHeritageClause(parent)) {
    return null;
  }

  if (Node.isBinaryExpression(parent)) {
    const operatorKind = parent.getOperatorToken().getKind();
    if (ASSIGNMENT_OPERATOR_KINDS.has(operatorKind) && parent.getLeft() === ident) {
      return "write";
    }
  }

  if (
    (Node.isPrefixUnaryExpression(parent) ||
      Node.isPostfixUnaryExpression(parent)) &&
    (parent.getOperatorToken() === SyntaxKind.PlusPlusToken ||
      parent.getOperatorToken() === SyntaxKind.MinusMinusToken)
  ) {
    return "write";
  }

  return "read";
}

function resolveFromSymbolInfo(
  node: Node,
  relPath: string,
  symbolIndex: SymbolIndex,
): SymbolInfo {
  const container = findContainingDeclaration(node);
  if (!container) {
    return { id: null, name: "", kind: null, parent: null, path: relPath };
  }

  const info = symbolIndex.getSymbolInfoFromDeclaration(container, relPath);
  if (info) return info;

  const name = getDeclarationName(container) ?? "";
  const kind = getDeclarationKind(container);
  const parent = getDeclarationParentName(container);
  return {
    id: null,
    name,
    kind,
    parent,
    path: relPath,
  };
}

function resolveSymbolInfo(
  node: Node,
  repoRoot: string,
  symbolIndex: SymbolIndex,
): SymbolInfo | null {
  let symbol = node.getSymbol();
  if (!symbol) {
    try {
      symbol = node.getType().getSymbol();
    } catch {
      symbol = undefined;
    }
  }
  if (!symbol) return null;
  if (symbol.isAlias()) {
    symbol = symbol.getAliasedSymbol() ?? symbol;
  }

  const decl = pickDeclaration(symbol, repoRoot);
  if (!decl) {
    return {
      id: null,
      name: symbol.getName(),
      kind: null,
      parent: null,
      path: null,
    };
  }

  const relPath = toRepoPath(repoRoot, decl.getSourceFile().getFilePath());
  if (!relPath) {
    return {
      id: null,
      name: getDeclarationName(decl) ?? symbol.getName(),
      kind: getDeclarationKind(decl),
      parent: getDeclarationParentName(decl),
      path: null,
    };
  }

  const info = symbolIndex.getSymbolInfoFromDeclaration(decl, relPath);
  if (info) return info;

  return {
    id: null,
    name: getDeclarationName(decl) ?? symbol.getName(),
    kind: getDeclarationKind(decl),
    parent: getDeclarationParentName(decl),
    path: relPath,
  };
}

function pickDeclaration(
  symbol: MorphSymbol,
  repoRoot: string,
): Node | null {
  const declarations = symbol.getDeclarations();
  if (declarations.length === 0) return null;

  for (const decl of declarations) {
    const relPath = toRepoPath(repoRoot, decl.getSourceFile().getFilePath());
    if (relPath) return decl;
  }

  return declarations[0] ?? null;
}

function buildReferenceFromNode(
  node: Node,
  relPath: string,
  fromInfo: SymbolInfo,
  toInfo: SymbolInfo | null,
  refKind: ReferenceKind,
  moduleSpecifier: string | null,
  fallbackPath: string | null,
  fallbackName?: string,
  fallbackKind?: string | null,
): ReferenceRow | null {
  const sourceFile = node.getSourceFile();
  const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());
  const fromLine = line;
  const fromCol = column;
  const fromLen = node.getWidth();

  const toName = toInfo?.name ?? fallbackName;
  if (!toName) return null;

  return {
    from_path: relPath,
    from_symbol_id: fromInfo.id,
    from_symbol_name: fromInfo.name || null,
    from_symbol_kind: fromInfo.kind,
    from_symbol_parent: fromInfo.parent,
    from_line: fromLine,
    from_col: fromCol,
    from_len: fromLen,
    to_path: toInfo?.path ?? fallbackPath ?? null,
    to_symbol_id: toInfo?.id ?? null,
    to_symbol_name: toName,
    to_symbol_kind: toInfo?.kind ?? fallbackKind ?? null,
    to_symbol_parent: toInfo?.parent ?? null,
    ref_kind: refKind,
    is_definition: 0,
    module_specifier: moduleSpecifier ?? null,
  };
}

function findContainingDeclaration(node: Node): Node | null {
  return node.getFirstAncestor((ancestor) => isSymbolContainer(ancestor)) ?? null;
}

function isSymbolContainer(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isVariableDeclaration(node) ||
    Node.isPropertyDeclaration(node)
  );
}

function getDeclarationName(decl: Node): string | null {
  if (Node.isConstructorDeclaration(decl)) return "constructor";
  if (Node.isFunctionDeclaration(decl)) return decl.getName() ?? "default";
  if (Node.isMethodDeclaration(decl)) return decl.getName();
  if (Node.isGetAccessorDeclaration(decl)) return decl.getName();
  if (Node.isSetAccessorDeclaration(decl)) return decl.getName();
  if (Node.isClassDeclaration(decl)) return decl.getName() ?? "default";
  if (Node.isInterfaceDeclaration(decl)) return decl.getName();
  if (Node.isEnumDeclaration(decl)) return decl.getName();
  if (Node.isEnumMember(decl)) return decl.getName();
  if (Node.isTypeAliasDeclaration(decl)) return decl.getName();
  if (Node.isVariableDeclaration(decl)) return decl.getName();
  if (Node.isPropertyDeclaration(decl)) return decl.getName();
  return null;
}

function getDeclarationKind(decl: Node): string | null {
  if (Node.isFunctionDeclaration(decl)) return "function";
  if (Node.isMethodDeclaration(decl)) return "method";
  if (Node.isConstructorDeclaration(decl)) return "constructor";
  if (Node.isGetAccessorDeclaration(decl)) return "getter";
  if (Node.isSetAccessorDeclaration(decl)) return "setter";
  if (Node.isClassDeclaration(decl)) return "class";
  if (Node.isInterfaceDeclaration(decl)) return "interface";
  if (Node.isTypeAliasDeclaration(decl)) return "type";
  if (Node.isEnumDeclaration(decl)) return "enum";
  if (Node.isEnumMember(decl)) return "enum_member";
  if (Node.isVariableDeclaration(decl)) return "variable";
  if (Node.isPropertyDeclaration(decl)) return "property";
  return null;
}

function getDeclarationParentName(decl: Node): string | null {
  const parent = decl.getFirstAncestor((ancestor) =>
    Node.isClassDeclaration(ancestor) || Node.isEnumDeclaration(ancestor),
  );
  if (parent && "getName" in parent) {
    return (parent as { getName(): string | undefined }).getName() ?? null;
  }
  return null;
}

function buildSymbolKey(
  kind: string,
  name: string,
  parent: string | null,
  startLine: number,
): string {
  return `${kind}|${name}|${parent ?? ""}|${startLine}`;
}

function toRepoPath(repoRoot: string, filePath: string): string | null {
  const relative = path.relative(repoRoot, filePath);
  if (relative.startsWith("..")) return null;
  return relative.split(path.sep).join("/");
}
