import {
  Project,
  Node,
  SourceFile,
  FunctionDeclaration,
  MethodDeclaration,
  ConstructorDeclaration,
  GetAccessorDeclaration,
  SetAccessorDeclaration,
  ArrowFunction,
  FunctionExpression,
  VariableDeclaration,
  ClassDeclaration,
  InterfaceDeclaration,
  TypeAliasDeclaration,
  EnumDeclaration,
  PropertyDeclaration,
  ts,
} from "ts-morph";
import type { SymbolEntry } from "./types.js";

let project: Project | null = null;
let virtualCounter = 0;

function getProject(): Project {
  if (!project) {
    project = new Project({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        strict: false,
        skipLibCheck: true,
        noEmit: true,
      },
      useInMemoryFileSystem: true,
      skipLoadingLibFiles: true,
    });
  }
  return project;
}

function cleanupSignature(sig: string): string {
  return sig.replace(/import\([^)]+\)\./g, "");
}

function extractJsDoc(node: Node, includeComments: boolean): string | undefined {
  if (!includeComments) return undefined;

  const jsDocs = Node.isJSDocable(node) ? node.getJsDocs() : [];
  if (jsDocs.length === 0) return undefined;

  const parts: string[] = [];
  for (const doc of jsDocs) {
    const comment = doc.getComment();
    if (!comment) continue;
    if (typeof comment === "string") {
      parts.push(comment);
    } else {
      parts.push(
        comment
          .filter((c): c is NonNullable<typeof c> => c !== undefined)
          .map((c) => c.getText())
          .join(""),
      );
    }
  }

  return parts.length > 0 ? parts.join("\n").trim() : undefined;
}

function getFunctionSignature(
  node:
    | FunctionDeclaration
    | MethodDeclaration
    | ConstructorDeclaration
    | GetAccessorDeclaration
    | SetAccessorDeclaration
    | ArrowFunction
    | FunctionExpression,
): string {
  if (Node.isConstructorDeclaration(node)) {
    const params = node
      .getParameters()
      .map((p) => p.getText())
      .join(", ");
    return cleanupSignature(`constructor(${params})`);
  }

  if (Node.isGetAccessorDeclaration(node)) {
    const returnType = node.getReturnType().getText();
    return cleanupSignature(`get ${node.getName()}(): ${returnType}`);
  }

  if (Node.isSetAccessorDeclaration(node)) {
    const params = node
      .getParameters()
      .map((p) => p.getText())
      .join(", ");
    return cleanupSignature(`set ${node.getName()}(${params})`);
  }

  const name =
    Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)
      ? node.getName() ?? "anonymous"
      : "anonymous";

  const typeParams =
    Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)
      ? node
          .getTypeParameters()
          .map((p) => p.getText())
          .join(", ")
      : "";
  const typeParamsStr = typeParams ? `<${typeParams}>` : "";

  const params = node
    .getParameters()
    .map((p) => p.getText())
    .join(", ");

  let returnType = "";
  try {
    const retType = node.getReturnType();
    returnType = retType ? `: ${retType.getText()}` : "";
  } catch {
    returnType = "";
  }

  const asyncPrefix = node.isAsync?.() ? "async " : "";
  const generatorPrefix =
    Node.isFunctionDeclaration(node) && node.isGenerator() ? "*" : "";

  return cleanupSignature(
    `${asyncPrefix}${generatorPrefix}${name}${typeParamsStr}(${params})${returnType}`,
  );
}

function getVariableSignature(varDecl: VariableDeclaration): string | undefined {
  const init = varDecl.getInitializer();

  if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
    const params = init
      .getParameters()
      .map((p) => p.getText())
      .join(", ");
    let returnStr = "";
    try {
      const retType = init.getReturnType();
      returnStr = retType ? `: ${retType.getText()}` : "";
    } catch {
      returnStr = "";
    }
    const asyncPrefix = init.isAsync() ? "async " : "";
    return cleanupSignature(`${asyncPrefix}(${params})${returnStr}`);
  }

  const typeNode = varDecl.getTypeNode();
  if (typeNode) return cleanupSignature(typeNode.getText());

  let typeText = "";
  try {
    typeText = varDecl.getType().getText();
  } catch {
    typeText = "";
  }
  if (typeText.length > 100) return undefined;
  if (!typeText) return undefined;
  return cleanupSignature(typeText);
}

function getTypeSignature(node: TypeAliasDeclaration): string {
  const typeParams = node
    .getTypeParameters()
    .map((p) => p.getText())
    .join(", ");
  const typeParamsStr = typeParams ? `<${typeParams}>` : "";
  const typeText = node.getTypeNode()?.getText() ?? "";
  const maxLen = 200;
  const truncated =
    typeText.length > maxLen ? `${typeText.slice(0, maxLen)}...` : typeText;
  return cleanupSignature(`${node.getName()}${typeParamsStr} = ${truncated}`);
}

function getInterfaceSignature(node: InterfaceDeclaration): string {
  const typeParams = node
    .getTypeParameters()
    .map((p) => p.getText())
    .join(", ");
  const typeParamsStr = typeParams ? `<${typeParams}>` : "";
  const extendsClause = node
    .getExtends()
    .map((e) => e.getText())
    .join(", ");
  const extendsStr = extendsClause ? ` extends ${extendsClause}` : "";
  return cleanupSignature(`${node.getName()}${typeParamsStr}${extendsStr}`);
}

function getClassSignature(node: ClassDeclaration): string {
  const name = node.getName() ?? "anonymous";
  const typeParams = node
    .getTypeParameters()
    .map((p) => p.getText())
    .join(", ");
  const typeParamsStr = typeParams ? `<${typeParams}>` : "";
  const extendsClause = node.getExtends()?.getText();
  const extendsStr = extendsClause ? ` extends ${extendsClause}` : "";
  const implementsClause = node
    .getImplements()
    .map((i) => i.getText())
    .join(", ");
  const implementsStr = implementsClause ? ` implements ${implementsClause}` : "";
  return cleanupSignature(`${name}${typeParamsStr}${extendsStr}${implementsStr}`);
}

function getEnumSignature(node: EnumDeclaration): string {
  const members = node.getMembers().map((m) => m.getName());
  if (members.length <= 5) {
    return `${node.getName()} { ${members.join(", ")} }`;
  }
  return `${node.getName()} { ${members.slice(0, 5).join(", ")}, ... }`;
}

function getPropertySignature(node: PropertyDeclaration): string {
  const name = node.getName();
  const optional = node.hasQuestionToken() ? "?" : "";
  const typeNode = node.getTypeNode();
  const typeStr = typeNode ? `: ${typeNode.getText()}` : "";
  return `${name}${optional}${typeStr}`;
}

function isVariableExported(varDecl: VariableDeclaration): boolean {
  const statement = varDecl.getVariableStatement();
  return statement?.isExported() ?? false;
}

function isVariableDefaultExport(varDecl: VariableDeclaration): boolean {
  const statement = varDecl.getVariableStatement();
  return statement?.isDefaultExport() ?? false;
}

function isVariableAsync(varDecl: VariableDeclaration): boolean {
  const init = varDecl.getInitializer();
  if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
    return init.isAsync();
  }
  return false;
}

function extractSymbols(
  sourceFile: SourceFile,
  opts: { includeComments: boolean },
): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];

  for (const func of sourceFile.getFunctions()) {
    symbols.push({
      name: func.getName() ?? "default",
      kind: "function",
      signature: getFunctionSignature(func),
      startLine: func.getStartLineNumber(),
      endLine: func.getEndLineNumber(),
      exported: func.isExported() || func.isDefaultExport(),
      isDefault: func.isDefaultExport(),
      isAsync: func.isAsync(),
      isStatic: false,
      isAbstract: false,
      comment: extractJsDoc(func, opts.includeComments),
    });
  }

  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName() ?? "default";
    symbols.push({
      name: className,
      kind: "class",
      signature: getClassSignature(cls),
      startLine: cls.getStartLineNumber(),
      endLine: cls.getEndLineNumber(),
      exported: cls.isExported() || cls.isDefaultExport(),
      isDefault: cls.isDefaultExport(),
      isAsync: false,
      isStatic: false,
      isAbstract: cls.isAbstract(),
      comment: extractJsDoc(cls, opts.includeComments),
    });

    for (const ctor of cls.getConstructors()) {
      symbols.push({
        name: "constructor",
        kind: "constructor",
        signature: getFunctionSignature(ctor),
        startLine: ctor.getStartLineNumber(),
        endLine: ctor.getEndLineNumber(),
        exported: false,
        isDefault: false,
        isAsync: false,
        isStatic: false,
        isAbstract: false,
        parentName: className,
        comment: extractJsDoc(ctor, opts.includeComments),
      });
    }

    for (const method of cls.getMethods()) {
      symbols.push({
        name: method.getName(),
        kind: "method",
        signature: getFunctionSignature(method),
        startLine: method.getStartLineNumber(),
        endLine: method.getEndLineNumber(),
        exported: false,
        isDefault: false,
        isAsync: method.isAsync(),
        isStatic: method.isStatic(),
        isAbstract: method.isAbstract(),
        parentName: className,
        comment: extractJsDoc(method, opts.includeComments),
      });
    }

    for (const prop of cls.getProperties()) {
      symbols.push({
        name: prop.getName(),
        kind: "property",
        signature: getPropertySignature(prop),
        startLine: prop.getStartLineNumber(),
        endLine: prop.getEndLineNumber(),
        exported: false,
        isDefault: false,
        isAsync: false,
        isStatic: prop.isStatic(),
        isAbstract: prop.isAbstract(),
        parentName: className,
        comment: extractJsDoc(prop, opts.includeComments),
      });
    }

    for (const getter of cls.getGetAccessors()) {
      symbols.push({
        name: getter.getName(),
        kind: "getter",
        signature: getFunctionSignature(getter),
        startLine: getter.getStartLineNumber(),
        endLine: getter.getEndLineNumber(),
        exported: false,
        isDefault: false,
        isAsync: false,
        isStatic: getter.isStatic(),
        isAbstract: getter.isAbstract(),
        parentName: className,
        comment: extractJsDoc(getter, opts.includeComments),
      });
    }

    for (const setter of cls.getSetAccessors()) {
      symbols.push({
        name: setter.getName(),
        kind: "setter",
        signature: getFunctionSignature(setter),
        startLine: setter.getStartLineNumber(),
        endLine: setter.getEndLineNumber(),
        exported: false,
        isDefault: false,
        isAsync: false,
        isStatic: setter.isStatic(),
        isAbstract: setter.isAbstract(),
        parentName: className,
        comment: extractJsDoc(setter, opts.includeComments),
      });
    }
  }

  for (const iface of sourceFile.getInterfaces()) {
    symbols.push({
      name: iface.getName(),
      kind: "interface",
      signature: getInterfaceSignature(iface),
      startLine: iface.getStartLineNumber(),
      endLine: iface.getEndLineNumber(),
      exported: iface.isExported() || iface.isDefaultExport(),
      isDefault: iface.isDefaultExport(),
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      comment: extractJsDoc(iface, opts.includeComments),
    });
  }

  for (const typeAlias of sourceFile.getTypeAliases()) {
    symbols.push({
      name: typeAlias.getName(),
      kind: "type",
      signature: getTypeSignature(typeAlias),
      startLine: typeAlias.getStartLineNumber(),
      endLine: typeAlias.getEndLineNumber(),
      exported: typeAlias.isExported() || typeAlias.isDefaultExport(),
      isDefault: typeAlias.isDefaultExport(),
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      comment: extractJsDoc(typeAlias, opts.includeComments),
    });
  }

  for (const enumDecl of sourceFile.getEnums()) {
    const enumName = enumDecl.getName();
    symbols.push({
      name: enumName,
      kind: "enum",
      signature: getEnumSignature(enumDecl),
      startLine: enumDecl.getStartLineNumber(),
      endLine: enumDecl.getEndLineNumber(),
      exported: enumDecl.isExported() || enumDecl.isDefaultExport(),
      isDefault: enumDecl.isDefaultExport(),
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      comment: extractJsDoc(enumDecl, opts.includeComments),
    });

    for (const member of enumDecl.getMembers()) {
      const value = member.getValue();
      const valueStr = value !== undefined ? ` = ${JSON.stringify(value)}` : "";
      symbols.push({
        name: member.getName(),
        kind: "enum_member",
        signature: `${member.getName()}${valueStr}`,
        startLine: member.getStartLineNumber(),
        endLine: member.getEndLineNumber(),
        exported: false,
        isDefault: false,
        isAsync: false,
        isStatic: false,
        isAbstract: false,
        parentName: enumName,
        comment: extractJsDoc(member, opts.includeComments),
      });
    }
  }

  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const varDecl of varStatement.getDeclarations()) {
      const signature = getVariableSignature(varDecl) ?? varDecl.getName();
      symbols.push({
        name: varDecl.getName(),
        kind: "variable",
        signature,
        startLine: varDecl.getStartLineNumber(),
        endLine: varDecl.getEndLineNumber(),
        exported: isVariableExported(varDecl),
        isDefault: isVariableDefaultExport(varDecl),
        isAsync: isVariableAsync(varDecl),
        isStatic: false,
        isAbstract: false,
        comment: extractJsDoc(varStatement, opts.includeComments),
      });
    }
  }

  return symbols;
}

function collectExportNames(sourceFile: SourceFile): {
  exportedNames: Set<string>;
  defaultNames: Set<string>;
} {
  const exportedNames = new Set<string>();
  const defaultNames = new Set<string>();

  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    for (const decl of declarations) {
      if (decl.getSourceFile() !== sourceFile) continue;
      exportedNames.add(name);
    }
  }

  for (const exportDecl of sourceFile.getExportDeclarations()) {
    if (exportDecl.getModuleSpecifierValue()) continue;
    for (const named of exportDecl.getNamedExports()) {
      const localName = named.getName();
      exportedNames.add(localName);
      if (named.getAliasNode()?.getText() === "default") {
        defaultNames.add(localName);
      }
    }
  }

  for (const assign of sourceFile.getExportAssignments()) {
    const expr = assign.getExpression();
    if (Node.isIdentifier(expr)) {
      exportedNames.add(expr.getText());
      if (!assign.isExportEquals()) {
        defaultNames.add(expr.getText());
      }
    }
  }

  return { exportedNames, defaultNames };
}

function applyExportFlags(
  symbols: SymbolEntry[],
  exportedNames: Set<string>,
  defaultNames: Set<string>,
): void {
  for (const sym of symbols) {
    if (sym.parentName) continue;
    if (exportedNames.has(sym.name)) {
      sym.exported = true;
    }
    if (defaultNames.has(sym.name)) {
      sym.isDefault = true;
      sym.exported = true;
    }
  }
}

function extractImports(sourceFile: SourceFile): string[] {
  const modules: string[] = [];
  const seen = new Set<string>();

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpec = importDecl.getModuleSpecifierValue();
    if (!seen.has(moduleSpec)) {
      seen.add(moduleSpec);
      modules.push(moduleSpec);
    }
  }

  return modules;
}

export function extractFileSymbols(
  filePath: string,
  content: string,
  opts?: { includeComments?: boolean },
): { symbols: SymbolEntry[]; imports: string[] } {
  const proj = getProject();
  const vpath = `virtual_${virtualCounter++}_${filePath.replace(/\\/g, "/")}`;
  const sourceFile = proj.createSourceFile(vpath, content, { overwrite: true });

  try {
    const includeComments = opts?.includeComments !== false;
    const rawSymbols = extractSymbols(sourceFile, { includeComments });
    const { exportedNames, defaultNames } = collectExportNames(sourceFile);
    applyExportFlags(rawSymbols, exportedNames, defaultNames);
    const imports = extractImports(sourceFile);
    return { symbols: rawSymbols, imports };
  } finally {
    proj.removeSourceFile(sourceFile);
  }
}

export function clearProjectCache(): void {
  project = null;
}
