import { Node, SourceFile, SyntaxKind } from "ts-morph";
import type { ImportKind, ImportSpec } from "../types.js";

function getSpan(node: Node): { start: number; end: number } {
  return { start: node.getStart(), end: node.getEnd() };
}

function getLiteralText(node: Node): string | null {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  return null;
}

function uniqueStrings(values: string[]): string[] {
  if (values.length <= 1) return values;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function makeSpec(
  kind: ImportKind,
  source: string,
  importedNames: string[],
  isTypeOnly: boolean,
  span: { start: number; end: number },
  isLiteral: boolean,
): ImportSpec {
  return {
    source,
    importedNames: uniqueStrings(importedNames),
    kind,
    isTypeOnly,
    span,
    isLiteral,
  };
}

export function extractImportSpecs(sourceFile: SourceFile): ImportSpec[] {
  const specs: ImportSpec[] = [];

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const source = importDecl.getModuleSpecifierValue();
    const importedNames: string[] = [];

    if (importDecl.getDefaultImport()) {
      importedNames.push("default");
    }

    if (importDecl.getNamespaceImport()) {
      importedNames.push("*");
    }

    for (const named of importDecl.getNamedImports()) {
      importedNames.push(named.getName());
    }

    const kind: ImportKind = importedNames.length === 0 ? "side_effect" : "import";

    specs.push(
      makeSpec(
        kind,
        source,
        importedNames,
        importDecl.isTypeOnly(),
        getSpan(importDecl),
        true,
      ),
    );
  }

  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const source = exportDecl.getModuleSpecifierValue();
    if (!source) continue;

    const importedNames: string[] = [];
    if (exportDecl.isNamespaceExport()) {
      importedNames.push("*");
    } else if (exportDecl.hasNamedExports()) {
      for (const named of exportDecl.getNamedExports()) {
        importedNames.push(named.getName());
      }
    }

    specs.push(
      makeSpec(
        "export_from",
        source,
        importedNames,
        exportDecl.isTypeOnly(),
        getSpan(exportDecl),
        true,
      ),
    );
  }

  for (const importEquals of sourceFile.getDescendantsOfKind(
    SyntaxKind.ImportEqualsDeclaration,
  )) {
    const moduleRef = importEquals.getModuleReference();
    if (!Node.isExternalModuleReference(moduleRef)) continue;

    const expr = moduleRef.getExpression();
    if (!expr) continue;
    const literal = getLiteralText(expr);
    const source = literal ?? expr.getText();

    specs.push(
      makeSpec(
        "require",
        source,
        [],
        importEquals.isTypeOnly(),
        getSpan(importEquals),
        literal !== null,
      ),
    );
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    let kind: ImportKind | null = null;

    if (expr.getKind() === SyntaxKind.ImportKeyword) {
      kind = "dynamic_import";
    } else if (Node.isIdentifier(expr) && expr.getText() === "require") {
      kind = "require";
    }

    if (!kind) continue;

    const args = call.getArguments();
    const arg = args.length > 0 ? args[0] : undefined;
    if (!arg) continue;

    const literal = getLiteralText(arg);
    const source = literal ?? arg.getText();

    specs.push(
      makeSpec(
        kind,
        source,
        [],
        false,
        getSpan(call),
        literal !== null,
      ),
    );
  }

  return specs;
}
