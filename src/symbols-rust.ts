import { createRequire } from "node:module";
import type Parser from "tree-sitter";
import type { SymbolEntry } from "./types.js";

export type UseStatement = {
  source: string;
  kind: "use";
  isGlob: boolean;
  aliases: string[];
  line: number;
};

type ScopeKind = "mod" | "struct" | "enum" | "trait" | "impl";

type Scope = {
  kind: ScopeKind;
  name: string;
  key: string;
  implTarget?: string;
};

const isBun = typeof (globalThis as any).Bun !== "undefined";
const disableRust = process.env.CODEMAP_DISABLE_RUST === "1";

function ensureWritableTypeProperty(parserCtor: unknown): void {
  const syntaxNode = (parserCtor as { SyntaxNode?: { prototype?: object } })
    .SyntaxNode;
  const proto = syntaxNode?.prototype;
  if (!proto) return;
  const desc = Object.getOwnPropertyDescriptor(proto, "type");
  if (!desc || desc.set) return;
  Object.defineProperty(proto, "type", { ...desc, set: () => {} });
}

let parser: Parser | null = null;

if (!isBun && !disableRust) {
  try {
    const require = createRequire(import.meta.url);
    const ParserCtor = require("tree-sitter") as typeof import("tree-sitter");
    const Rust = require("tree-sitter-rust") as unknown;
    ensureWritableTypeProperty(ParserCtor);
    parser = new ParserCtor();
    parser.setLanguage(Rust);
  } catch {
    parser = null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getNodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function formatSignature(
  node: Parser.SyntaxNode,
  source: string,
  opts?: { cutAtParen?: boolean },
): string {
  let text = getNodeText(node, source);
  const braceIndex = text.indexOf("{");
  if (braceIndex !== -1) {
    text = text.slice(0, braceIndex);
  } else if (opts?.cutAtParen) {
    const parenIndex = text.indexOf("(");
    if (parenIndex !== -1) {
      text = text.slice(0, parenIndex);
    }
  }
  text = text.replace(/;\s*$/, "");
  return normalizeWhitespace(text);
}

function getLineRange(node: Parser.SyntaxNode): { startLine: number; endLine: number } {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function findFirstDescendant(
  node: Parser.SyntaxNode,
  types: string[],
): Parser.SyntaxNode | null {
  const stack = [...node.namedChildren];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (types.includes(current.type)) return current;
    for (const child of current.namedChildren) {
      stack.push(child);
    }
  }
  return null;
}

function hasVisibilityModifier(node: Parser.SyntaxNode): boolean {
  return node.namedChildren.some((child) => child.type === "visibility_modifier");
}

function extractNameFromField(
  node: Parser.SyntaxNode,
  field: string,
  source: string,
): string | null {
  const nameNode = node.childForFieldName(field);
  if (!nameNode) return null;
  return normalizeWhitespace(getNodeText(nameNode, source));
}

function extractTypeName(
  node: Parser.SyntaxNode,
  source: string,
): string | null {
  switch (node.type) {
    case "type_identifier":
    case "identifier":
    case "self":
    case "super":
    case "crate":
    case "metavariable":
      return normalizeWhitespace(getNodeText(node, source));
    case "scoped_type_identifier":
    case "scoped_identifier": {
      const pathNode = node.childForFieldName("path");
      const nameNode = node.childForFieldName("name");
      const pathText = pathNode ? extractTypeName(pathNode, source) : null;
      const nameText = nameNode ? extractTypeName(nameNode, source) : null;
      if (!nameText) return pathText;
      return pathText ? `${pathText}::${nameText}` : nameText;
    }
    case "generic_type":
    case "generic_type_with_turbofish": {
      const typeNode = node.childForFieldName("type");
      return typeNode ? extractTypeName(typeNode, source) : null;
    }
    case "reference_type":
    case "pointer_type": {
      const inner = node.childForFieldName("type");
      return inner ? extractTypeName(inner, source) : null;
    }
    default: {
      const candidate = findFirstDescendant(node, [
        "scoped_type_identifier",
        "scoped_identifier",
        "type_identifier",
        "identifier",
      ]);
      return candidate ? extractTypeName(candidate, source) : null;
    }
  }
}

function splitPathParts(text: string): string[] {
  return text
    .split("::")
    .map((part) => part.trim())
    .filter(Boolean);
}

function combinePath(prefix: string[], parts: string[]): string[] {
  if (parts.length === 0) return prefix;
  if (parts[0] === "self") {
    if (parts.length === 1) return prefix.length > 0 ? prefix : parts;
    if (prefix.length === 0) return parts;
    return prefix.concat(parts.slice(1));
  }
  return prefix.concat(parts);
}

type ExpandedUse = {
  pathParts: string[];
  alias?: string;
  isGlob: boolean;
};

function expandUseClause(
  node: Parser.SyntaxNode,
  source: string,
  prefix: string[],
): ExpandedUse[] {
  switch (node.type) {
    case "use_as_clause": {
      const pathNode = node.childForFieldName("path");
      const aliasNode = node.childForFieldName("alias");
      const pathParts = pathNode
        ? combinePath(prefix, splitPathParts(getNodeText(pathNode, source)))
        : prefix;
      const alias = aliasNode
        ? normalizeWhitespace(getNodeText(aliasNode, source))
        : undefined;
      return [{ pathParts, alias, isGlob: false }];
    }
    case "use_list": {
      const results: ExpandedUse[] = [];
      for (const child of node.namedChildren) {
        results.push(...expandUseClause(child, source, prefix));
      }
      return results;
    }
    case "scoped_use_list": {
      const pathNode = node.childForFieldName("path");
      const listNode = node.childForFieldName("list");
      const nextPrefix = pathNode
        ? combinePath(prefix, splitPathParts(getNodeText(pathNode, source)))
        : prefix;
      if (!listNode) return [];
      return expandUseClause(listNode, source, nextPrefix);
    }
    case "use_wildcard": {
      const pathNode = node.namedChildren.at(0);
      const pathParts = pathNode
        ? combinePath(prefix, splitPathParts(getNodeText(pathNode, source)))
        : prefix;
      return [{ pathParts, isGlob: true }];
    }
    default: {
      const parts = splitPathParts(getNodeText(node, source));
      return [{ pathParts: combinePath(prefix, parts), isGlob: false }];
    }
  }
}

function extractUseStatements(
  root: Parser.SyntaxNode,
  source: string,
): UseStatement[] {
  const statements: UseStatement[] = [];

  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === "use_declaration") {
      const arg = node.childForFieldName("argument");
      if (arg) {
        const line = node.startPosition.row + 1;
        const expanded = expandUseClause(arg, source, []);
        for (const entry of expanded) {
          if (entry.pathParts.length === 0) continue;
          statements.push({
            source: entry.pathParts.join("::"),
            kind: "use",
            isGlob: entry.isGlob,
            aliases: entry.alias ? [entry.alias] : [],
            line,
          });
        }
      }
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };

  visit(root);
  return statements;
}

function getModuleKey(scopeStack: Scope[]): string | null {
  for (let i = scopeStack.length - 1; i >= 0; i -= 1) {
    const scope = scopeStack[i];
    if (scope.kind === "mod") return scope.key;
  }
  return null;
}

function normalizeTypePath(path: string, moduleKey: string | null): string {
  const parts = splitPathParts(path);
  const moduleParts = moduleKey ? splitPathParts(moduleKey) : [];

  if (parts.length === 0) return moduleParts.join("::");

  if (parts[0] === "crate") {
    return parts.slice(1).join("::");
  }

  if (parts[0] === "self") {
    return moduleParts.concat(parts.slice(1)).join("::");
  }

  let superCount = 0;
  while (parts[superCount] === "super") {
    superCount += 1;
  }
  if (superCount > 0) {
    const trimmed = moduleParts.slice(
      0,
      Math.max(0, moduleParts.length - superCount),
    );
    return trimmed.concat(parts.slice(superCount)).join("::");
  }

  if (moduleParts.length === 0) return parts.join("::");
  return moduleParts.concat(parts).join("::");
}

export function extractRustSymbols(
  filePath: string,
  content: string,
  opts?: { includeComments?: boolean },
): { symbols: SymbolEntry[]; useStatements: UseStatement[] } {
  void filePath;
  void opts;
  const symbols: SymbolEntry[] = [];
  const useStatements: UseStatement[] = [];

  if (!parser) {
    return { symbols, useStatements };
  }

  let tree: Parser.Tree;
  try {
    tree = parser.parse(content);
  } catch {
    return { symbols, useStatements };
  }

  useStatements.push(...extractUseStatements(tree.rootNode, content));

  const scopeStack: Scope[] = [];

  const currentScope = (kind: ScopeKind): Scope | undefined => {
    for (let i = scopeStack.length - 1; i >= 0; i -= 1) {
      const scope = scopeStack[i];
      if (scope.kind === kind) return scope;
    }
    return undefined;
  };

  const addSymbol = (entry: SymbolEntry): void => {
    symbols.push(entry);
  };

  const handleMod = (node: Parser.SyntaxNode): void => {
    const name = extractNameFromField(node, "name", content);
    if (!name) return;
    const signature = formatSignature(node, content);
    const moduleKey = getModuleKey(scopeStack);
    const parentKey = moduleKey ?? undefined;
    const key = parentKey ? `${parentKey}::${name}` : name;
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name,
      kind: "namespace",
      signature,
      startLine,
      endLine,
      exported: hasVisibilityModifier(node),
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName: parentKey,
    });

    const body = node.childForFieldName("body");
    if (!body) return;
    scopeStack.push({ kind: "mod", name, key });
    for (const child of body.namedChildren) {
      visit(child);
    }
    scopeStack.pop();
  };

  const handleStruct = (node: Parser.SyntaxNode): void => {
    const name = extractNameFromField(node, "name", content);
    if (!name) return;
    const signature = formatSignature(node, content, { cutAtParen: true });
    const moduleKey = getModuleKey(scopeStack);
    const parentKey = moduleKey ?? undefined;
    const key = parentKey ? `${parentKey}::${name}` : name;
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name,
      kind: "struct",
      signature,
      startLine,
      endLine,
      exported: hasVisibilityModifier(node),
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName: parentKey,
    });

    const body = node.childForFieldName("body");
    if (!body) return;
    scopeStack.push({ kind: "struct", name, key });
    for (const child of body.namedChildren) {
      visit(child);
    }
    scopeStack.pop();
  };

  const handleEnum = (node: Parser.SyntaxNode): void => {
    const name = extractNameFromField(node, "name", content);
    if (!name) return;
    const signature = formatSignature(node, content, { cutAtParen: true });
    const moduleKey = getModuleKey(scopeStack);
    const parentKey = moduleKey ?? undefined;
    const key = parentKey ? `${parentKey}::${name}` : name;
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name,
      kind: "enum",
      signature,
      startLine,
      endLine,
      exported: hasVisibilityModifier(node),
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName: parentKey,
    });

    const body = node.childForFieldName("body");
    if (!body) return;
    scopeStack.push({ kind: "enum", name, key });
    for (const child of body.namedChildren) {
      visit(child);
    }
    scopeStack.pop();
  };

  const handleTrait = (node: Parser.SyntaxNode): void => {
    const name = extractNameFromField(node, "name", content);
    if (!name) return;
    const signature = formatSignature(node, content);
    const moduleKey = getModuleKey(scopeStack);
    const parentKey = moduleKey ?? undefined;
    const key = parentKey ? `${parentKey}::${name}` : name;
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name,
      kind: "trait",
      signature,
      startLine,
      endLine,
      exported: hasVisibilityModifier(node),
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName: parentKey,
    });

    const body = node.childForFieldName("body");
    if (!body) return;
    scopeStack.push({ kind: "trait", name, key });
    for (const child of body.namedChildren) {
      visit(child);
    }
    scopeStack.pop();
  };

  const handleImpl = (node: Parser.SyntaxNode): void => {
    const typeNode = node.childForFieldName("type");
    if (!typeNode) return;
    const typeName = extractTypeName(typeNode, content);
    if (!typeName) return;
    const moduleKey = getModuleKey(scopeStack);
    const implTarget = normalizeTypePath(typeName, moduleKey);
    const body = node.childForFieldName("body");
    if (!body) return;

    scopeStack.push({
      kind: "impl",
      name: typeName,
      key: implTarget,
      implTarget,
    });
    for (const child of body.namedChildren) {
      visit(child);
    }
    scopeStack.pop();
  };

  const handleFunction = (node: Parser.SyntaxNode): void => {
    const name = extractNameFromField(node, "name", content);
    if (!name) return;
    const signature = formatSignature(node, content);
    const implScope = currentScope("impl");
    const traitScope = currentScope("trait");
    const moduleKey = getModuleKey(scopeStack);
    const parentName =
      implScope?.implTarget ?? traitScope?.key ?? moduleKey ?? undefined;
    const kind: SymbolEntry["kind"] =
      implScope || traitScope ? "method" : "function";
    const { startLine, endLine } = getLineRange(node);
    const isAsync = /\basync\b/.test(signature);

    addSymbol({
      name,
      kind,
      signature,
      startLine,
      endLine,
      exported: hasVisibilityModifier(node),
      isDefault: false,
      isAsync,
      isStatic: false,
      isAbstract: false,
      parentName,
    });
  };

  const handleConst = (node: Parser.SyntaxNode): void => {
    const name = extractNameFromField(node, "name", content);
    if (!name) return;
    const signature = formatSignature(node, content);
    const implScope = currentScope("impl");
    const traitScope = currentScope("trait");
    const moduleKey = getModuleKey(scopeStack);
    const parentName =
      implScope?.implTarget ?? traitScope?.key ?? moduleKey ?? undefined;
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name,
      kind: "variable",
      signature,
      startLine,
      endLine,
      exported: hasVisibilityModifier(node),
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName,
    });
  };

  const handleStatic = (node: Parser.SyntaxNode): void => {
    const name = extractNameFromField(node, "name", content);
    if (!name) return;
    const signature = formatSignature(node, content);
    const moduleKey = getModuleKey(scopeStack);
    const parentName = moduleKey ?? undefined;
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name,
      kind: "variable",
      signature,
      startLine,
      endLine,
      exported: hasVisibilityModifier(node),
      isDefault: false,
      isAsync: false,
      isStatic: true,
      isAbstract: false,
      parentName,
    });
  };

  const handleType = (node: Parser.SyntaxNode): void => {
    const name = extractNameFromField(node, "name", content);
    if (!name) return;
    const signature = formatSignature(node, content);
    const implScope = currentScope("impl");
    const traitScope = currentScope("trait");
    const moduleKey = getModuleKey(scopeStack);
    const parentName =
      implScope?.implTarget ?? traitScope?.key ?? moduleKey ?? undefined;
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name,
      kind: "type",
      signature,
      startLine,
      endLine,
      exported: hasVisibilityModifier(node),
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName,
    });
  };

  const handleMacro = (node: Parser.SyntaxNode): void => {
    const name = extractNameFromField(node, "name", content);
    if (!name) return;
    const signature = formatSignature(node, content, { cutAtParen: true });
    const moduleKey = getModuleKey(scopeStack);
    const parentName = moduleKey ?? undefined;
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name,
      kind: "macro",
      signature,
      startLine,
      endLine,
      exported: false,
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName,
    });
  };

  const handleField = (node: Parser.SyntaxNode): void => {
    const structScope = currentScope("struct");
    if (!structScope) return;
    const name = extractNameFromField(node, "name", content);
    if (!name) return;
    const signature = formatSignature(node, content);
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name,
      kind: "property",
      signature,
      startLine,
      endLine,
      exported: hasVisibilityModifier(node),
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName: structScope.key,
    });
  };

  const handleEnumVariant = (node: Parser.SyntaxNode): void => {
    const enumScope = currentScope("enum");
    if (!enumScope) return;
    const name = extractNameFromField(node, "name", content);
    if (!name) return;
    let signature = normalizeWhitespace(getNodeText(node, content));
    signature = signature.replace(/,\s*$/, "");
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name,
      kind: "enum_member",
      signature,
      startLine,
      endLine,
      exported: hasVisibilityModifier(node),
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName: enumScope.key,
    });
  };

  const visit = (node: Parser.SyntaxNode): void => {
    switch (node.type) {
      case "use_declaration":
        return;
      case "mod_item":
        handleMod(node);
        return;
      case "struct_item":
        handleStruct(node);
        return;
      case "enum_item":
        handleEnum(node);
        return;
      case "trait_item":
        handleTrait(node);
        return;
      case "impl_item":
        handleImpl(node);
        return;
      case "function_item":
      case "function_signature_item":
        handleFunction(node);
        return;
      case "const_item":
        handleConst(node);
        return;
      case "static_item":
        handleStatic(node);
        return;
      case "type_item":
        handleType(node);
        return;
      case "macro_definition":
        handleMacro(node);
        return;
      case "field_declaration":
        handleField(node);
        return;
      case "enum_variant":
        handleEnumVariant(node);
        return;
      default:
        break;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  };

  visit(tree.rootNode);

  return { symbols, useStatements };
}
