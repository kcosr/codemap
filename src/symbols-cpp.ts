import Parser from "tree-sitter";
import CPP from "tree-sitter-cpp";
import type { SymbolEntry } from "./types.js";
import { extractIncludes, type IncludeSpec } from "./deps/extract-includes.js";

type ScopeKind = "namespace" | "class" | "struct" | "enum";
type AccessLevel = "public" | "protected" | "private";

type Scope = {
  kind: ScopeKind;
  name: string;
  key: string;
  access?: AccessLevel;
};

function ensureWritableTypeProperty(): void {
  const syntaxNode = (Parser as unknown as { SyntaxNode?: { prototype?: object } })
    .SyntaxNode;
  const proto = syntaxNode?.prototype;
  if (!proto) return;
  const desc = Object.getOwnPropertyDescriptor(proto, "type");
  if (!desc || desc.set) return;
  Object.defineProperty(proto, "type", { ...desc, set: () => {} });
}

// Bun may run modules in strict mode, so make SyntaxNode.type writable to
// avoid tree-sitter's prototype assignment error.
ensureWritableTypeProperty();

const parser = new Parser();
parser.setLanguage(CPP);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getNodeText(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function formatSignature(
  node: Parser.SyntaxNode,
  source: string,
  templatePrefix?: string,
): string {
  let text = getNodeText(node, source);
  const bodyIndex = text.indexOf("{");
  if (bodyIndex !== -1) {
    text = text.slice(0, bodyIndex);
  }
  text = text.replace(/;\s*$/, "");
  text = normalizeWhitespace(text);
  if (templatePrefix) {
    text = normalizeWhitespace(`${templatePrefix} ${text}`);
  }
  return text;
}

function findDescendantOfType(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child.type === type) return child;
    const nested = findDescendantOfType(child, type);
    if (nested) return nested;
  }
  return null;
}

function findFirstDescendant(
  node: Parser.SyntaxNode,
  types: string[],
): Parser.SyntaxNode | null {
  for (const type of types) {
    const found = findDescendantOfType(node, type);
    if (found) return found;
  }
  return null;
}

function collectDescendants(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode[] {
  const results: Parser.SyntaxNode[] = [];
  const stack = [...node.namedChildren];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.type === type) {
      results.push(current);
    }
    for (const child of current.namedChildren) {
      stack.push(child);
    }
  }
  return results;
}

function extractNameFromSignature(signature: string, pattern: RegExp): string | null {
  const match = signature.match(pattern);
  return match?.[1] ?? null;
}

function extractQualifiedName(
  rawName: string,
): { name: string; parentName?: string } {
  const parts = rawName.split("::").map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return { name: rawName.trim() };
  }
  const name = parts.pop() ?? rawName.trim();
  const parentName = parts.join("::");
  return { name, parentName };
}

function buildScopeKey(parent: string | null, name: string): string {
  return parent ? `${parent}::${name}` : name;
}

function makeAnonymousName(kind: string, line: number): string {
  return `<anonymous@${kind}:${line}>`;
}

function getLineRange(node: Parser.SyntaxNode): { startLine: number; endLine: number } {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function isStaticSignature(signature: string): boolean {
  return /\bstatic\b/.test(signature);
}

function extractTypedefName(node: Parser.SyntaxNode, source: string): string | null {
  const identifiers = collectDescendants(node, "identifier").sort(
    (a, b) => a.endIndex - b.endIndex,
  );
  const last = identifiers.at(-1);
  if (!last) return null;
  return normalizeWhitespace(getNodeText(last, source));
}

function extractAliasName(node: Parser.SyntaxNode, source: string): string | null {
  const nameNode =
    node.childForFieldName("name") ??
    findFirstDescendant(node, ["type_identifier", "identifier"]);
  return nameNode ? normalizeWhitespace(getNodeText(nameNode, source)) : null;
}

function extractSpecifierName(
  node: Parser.SyntaxNode,
  source: string,
  pattern: RegExp,
): string | null {
  const nameNode =
    node.childForFieldName("name") ??
    findFirstDescendant(node, ["type_identifier", "identifier"]);
  if (nameNode) return normalizeWhitespace(getNodeText(nameNode, source));
  const signature = formatSignature(node, source);
  return extractNameFromSignature(signature, pattern);
}

function extractFunctionName(
  node: Parser.SyntaxNode,
  source: string,
): string | null {
  const declarator = node.childForFieldName("declarator") ?? node;
  const nameTarget = declarator.childForFieldName("declarator") ?? declarator;
  const directTypes = new Set([
    "qualified_identifier",
    "scoped_identifier",
    "destructor_name",
    "operator_name",
    "field_identifier",
    "identifier",
  ]);
  if (directTypes.has(nameTarget.type)) {
    return normalizeWhitespace(getNodeText(nameTarget, source));
  }
  const nameNode = findFirstDescendant(nameTarget, [
    "qualified_identifier",
    "scoped_identifier",
    "destructor_name",
    "operator_name",
    "field_identifier",
    "identifier",
  ]);
  if (!nameNode) return null;
  return normalizeWhitespace(getNodeText(nameNode, source));
}

function collectFieldNames(
  node: Parser.SyntaxNode,
  source: string,
): string[] {
  const names = collectDescendants(node, "field_identifier").map((child) =>
    normalizeWhitespace(getNodeText(child, source)),
  );
  if (names.length > 0) return names;

  const fallback: string[] = [];
  const identifiers = collectDescendants(node, "identifier");
  for (const ident of identifiers) {
    const parent = ident.parent;
    if (parent && parent.type.includes("declarator")) {
      fallback.push(normalizeWhitespace(getNodeText(ident, source)));
    }
  }
  return fallback;
}

export function extractCppSymbols(
  filePath: string,
  content: string,
  opts?: { includeComments?: boolean },
): { symbols: SymbolEntry[]; includes: IncludeSpec[] } {
  const tree = parser.parse(content);
  const symbols: SymbolEntry[] = [];
  const includes = extractIncludes(content);
  const scopeStack: Scope[] = [];
  const classKeys = new Set<string>();

  const currentScope = (): Scope | undefined => scopeStack.at(-1);
  const currentClassScope = (): Scope | undefined => {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      const scope = scopeStack[i];
      if (scope.kind === "class" || scope.kind === "struct") return scope;
    }
    return undefined;
  };

  const pushScope = (scope: Scope): void => {
    scopeStack.push(scope);
  };

  const popScope = (): void => {
    scopeStack.pop();
  };

  const addSymbol = (entry: SymbolEntry): void => {
    symbols.push(entry);
  };

  const handleNamespace = (node: Parser.SyntaxNode, templatePrefix?: string): void => {
    const signature = formatSignature(node, content, templatePrefix);
    const name =
      extractSpecifierName(
        node,
        content,
        /\bnamespace\s+([A-Za-z_][\w:]*)/,
      ) ?? makeAnonymousName("namespace", node.startPosition.row + 1);
    const { name: cleanName, parentName } = extractQualifiedName(name);
    const parentKey = parentName ?? currentScope()?.key ?? null;
    const key = buildScopeKey(parentKey, cleanName);
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name: cleanName,
      kind: "namespace",
      signature,
      startLine,
      endLine,
      exported: true,
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName: parentKey ?? undefined,
    });

    pushScope({ kind: "namespace", name: cleanName, key });
    const body =
      node.childForFieldName("body") ??
      node.namedChildren.find((child) => child.type === "declaration_list");
    const children = body ? body.namedChildren : node.namedChildren;
    for (const child of children) {
      visit(child);
    }
    popScope();
  };

  const handleClass = (
    node: Parser.SyntaxNode,
    kind: "class" | "struct",
    templatePrefix?: string,
  ): void => {
    const signature = formatSignature(node, content, templatePrefix);
    const name =
      extractSpecifierName(
        node,
        content,
        new RegExp(`\\b${kind}\\s+([A-Za-z_][\\w:]*)`),
      ) ?? makeAnonymousName(kind, node.startPosition.row + 1);
    const { name: cleanName, parentName } = extractQualifiedName(name);
    const parentKey = parentName ?? currentScope()?.key ?? null;
    const key = buildScopeKey(parentKey, cleanName);
    classKeys.add(key);
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name: cleanName,
      kind,
      signature,
      startLine,
      endLine,
      exported: true,
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName: parentKey ?? undefined,
    });

    const access: AccessLevel = kind === "struct" ? "public" : "private";
    pushScope({ kind, name: cleanName, key, access });

    const body =
      node.childForFieldName("body") ??
      node.namedChildren.find((child) =>
        ["field_declaration_list", "declaration_list"].includes(child.type),
      );
    const children = body ? body.namedChildren : node.namedChildren;
    for (const child of children) {
      visit(child);
    }
    popScope();
  };

  const handleEnum = (node: Parser.SyntaxNode, templatePrefix?: string): void => {
    const signature = formatSignature(node, content, templatePrefix);
    const name =
      extractSpecifierName(
        node,
        content,
        /\benum(?:\s+(?:class|struct))?\s+([A-Za-z_][\w:]*)/,
      ) ?? makeAnonymousName("enum", node.startPosition.row + 1);
    const { name: cleanName, parentName } = extractQualifiedName(name);
    const parentKey = parentName ?? currentScope()?.key ?? null;
    const key = buildScopeKey(parentKey, cleanName);
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name: cleanName,
      kind: "enum",
      signature,
      startLine,
      endLine,
      exported: true,
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName: parentKey ?? undefined,
    });

    for (const enumerator of collectDescendants(node, "enumerator")) {
      const ident = findFirstDescendant(enumerator, ["identifier"]);
      if (!ident) continue;
      const enumName = normalizeWhitespace(getNodeText(ident, content));
      let enumSignature = normalizeWhitespace(getNodeText(enumerator, content));
      enumSignature = enumSignature.replace(/,\s*$/, "");
      const range = getLineRange(enumerator);
      addSymbol({
        name: enumName,
        kind: "enum_member",
        signature: enumSignature,
        startLine: range.startLine,
        endLine: range.endLine,
        exported: false,
        isDefault: false,
        isAsync: false,
        isStatic: false,
        isAbstract: false,
        parentName: key,
      });
    }
  };

  const handleTypedef = (node: Parser.SyntaxNode, templatePrefix?: string): void => {
    const signature = formatSignature(node, content, templatePrefix);
    const name =
      extractTypedefName(node, content) ??
      extractNameFromSignature(signature, /\btypedef\b[\s\S]*?([A-Za-z_][\w:]*)/);
    if (!name) return;
    const { name: cleanName, parentName } = extractQualifiedName(name);
    const parentKey = parentName ?? currentScope()?.key ?? null;
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name: cleanName,
      kind: "type",
      signature,
      startLine,
      endLine,
      exported: true,
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName: parentKey ?? undefined,
    });
  };

  const handleAlias = (node: Parser.SyntaxNode, templatePrefix?: string): void => {
    const signature = formatSignature(node, content, templatePrefix);
    const name = extractAliasName(node, content);
    if (!name) return;
    const { name: cleanName, parentName } = extractQualifiedName(name);
    const parentKey = parentName ?? currentScope()?.key ?? null;
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name: cleanName,
      kind: "type",
      signature,
      startLine,
      endLine,
      exported: true,
      isDefault: false,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      parentName: parentKey ?? undefined,
    });
  };

  const handleFunction = (
    node: Parser.SyntaxNode,
    templatePrefix?: string,
  ): void => {
    const signature = formatSignature(node, content, templatePrefix);
    const rawName = extractFunctionName(node, content);
    if (!rawName) return;
    const { name, parentName: qualifiedParent } = extractQualifiedName(rawName);
    const scope = currentScope();
    let parentName = qualifiedParent ?? scope?.key;
    if (
      qualifiedParent &&
      scope?.kind === "namespace" &&
      !qualifiedParent.includes("::")
    ) {
      parentName = `${scope.key}::${qualifiedParent}`;
    }
    const classScope = currentClassScope();
    const classKey = parentName && classKeys.has(parentName) ? parentName : classScope?.key;
    const className = classKey ? classKey.split("::").pop() ?? classKey : undefined;

    let kind: SymbolEntry["kind"] = "function";
    if (classKey && parentName === classKey) {
      if (className && name === className) {
        kind = "constructor";
      } else if (className && name === `~${className}`) {
        kind = "destructor";
      } else {
        kind = "method";
      }
    }

    const access = classScope?.access;
    const exported = parentName && classScope ? access === "public" : true;
    const { startLine, endLine } = getLineRange(node);

    addSymbol({
      name,
      kind,
      signature,
      startLine,
      endLine,
      exported,
      isDefault: false,
      isAsync: false,
      isStatic: isStaticSignature(signature),
      isAbstract: false,
      parentName: parentName ?? undefined,
    });
  };

  const handleField = (node: Parser.SyntaxNode): void => {
    const classScope = currentClassScope();
    if (!classScope) return;

    const names = collectFieldNames(node, content);
    if (names.length === 0) return;
    const signature = formatSignature(node, content);
    const { startLine, endLine } = getLineRange(node);
    const exported = classScope.access === "public";

    for (const name of names) {
      addSymbol({
        name,
        kind: "property",
        signature,
        startLine,
        endLine,
        exported,
        isDefault: false,
        isAsync: false,
        isStatic: isStaticSignature(signature),
        isAbstract: false,
        parentName: classScope.key,
      });
    }
  };

  const handleAccessSpecifier = (node: Parser.SyntaxNode): void => {
    const classScope = currentClassScope();
    if (!classScope) return;
    let text = normalizeWhitespace(getNodeText(node, content));
    text = text.replace(":", "");
    if (text.startsWith("public")) classScope.access = "public";
    if (text.startsWith("protected")) classScope.access = "protected";
    if (text.startsWith("private")) classScope.access = "private";
  };

  const isFunctionDeclaration = (node: Parser.SyntaxNode): boolean => {
    return !!findDescendantOfType(node, "function_declarator");
  };

  const visit = (node: Parser.SyntaxNode, templatePrefix?: string): void => {
    switch (node.type) {
      case "template_declaration": {
        const decl =
          node.childForFieldName("declaration") ??
          node.childForFieldName("definition") ??
          node.namedChildren.find((child) =>
            [
              "function_definition",
              "declaration",
              "class_specifier",
              "struct_specifier",
              "enum_specifier",
              "type_definition",
              "alias_declaration",
              "namespace_definition",
            ].includes(child.type),
          );
        if (decl) {
          const prefix = normalizeWhitespace(
            content.slice(node.startIndex, decl.startIndex),
          );
          visit(decl, prefix || undefined);
          return;
        }
        break;
      }
      case "namespace_definition":
        handleNamespace(node, templatePrefix);
        return;
      case "class_specifier":
        handleClass(node, "class", templatePrefix);
        return;
      case "struct_specifier":
        handleClass(node, "struct", templatePrefix);
        return;
      case "enum_specifier":
        handleEnum(node, templatePrefix);
        return;
      case "type_definition":
        handleTypedef(node, templatePrefix);
        return;
      case "alias_declaration":
        handleAlias(node, templatePrefix);
        return;
      case "function_definition":
        handleFunction(node, templatePrefix);
        return;
      case "declaration":
        if (isFunctionDeclaration(node)) {
          handleFunction(node, templatePrefix);
        }
        return;
      case "field_declaration":
        if (isFunctionDeclaration(node)) {
          handleFunction(node, templatePrefix);
        } else {
          handleField(node);
        }
        return;
      case "access_specifier":
        handleAccessSpecifier(node);
        return;
      default:
        break;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  };

  visit(tree.rootNode);

  return { symbols, includes };
}
