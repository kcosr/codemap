import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { generateSourceMap } from "../src/sourceMap.js";
import { openCache } from "../src/cache/db.js";

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-anno-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "src", "example.ts"),
    `export function greet(name: string): string {\n  return "hi " + name;\n}\n`,
  );

  return dir;
}

describe("annotations", () => {
  it("includes file and symbol annotations by default", () => {
    const dir = createTempProject();

    const first = generateSourceMap({
      repoRoot: dir,
      includeComments: true,
      includeImports: true,
      includeHeadings: true,
      includeCodeBlocks: true,
      includeStats: false,
      exportedOnly: false,
      output: "text",
    });

    const entry = first.files.find((f) => f.path === "src/example.ts");
    const symbol = entry?.symbols.find((s) => s.name === "greet");
    expect(entry).toBeDefined();
    expect(symbol).toBeDefined();

    const db = openCache(dir);
    db.setFileAnnotation("src/example.ts", "Core file note");
    db.setSymbolAnnotation(
      {
        path: "src/example.ts",
        symbolName: "greet",
        symbolKind: "function",
        parentName: null,
        signature: symbol?.signature ?? "",
      },
      "Greet note",
    );
    db.addFileAnnotationTags("src/example.ts", [
      { key: "category", value: "command" },
    ]);
    db.addSymbolAnnotationTags(
      {
        path: "src/example.ts",
        symbolName: "greet",
        symbolKind: "function",
        parentName: null,
        signature: symbol?.signature ?? "",
      },
      [{ key: "category", value: "command" }],
    );
    db.close();

    const second = generateSourceMap({
      repoRoot: dir,
      includeComments: true,
      includeImports: true,
      includeHeadings: true,
      includeCodeBlocks: true,
      includeStats: false,
      exportedOnly: false,
      output: "text",
    });

    const entry2 = second.files.find((f) => f.path === "src/example.ts");
    const symbol2 = entry2?.symbols.find((s) => s.name === "greet");

    expect(entry2?.annotation).toBe("Core file note");
    expect(entry2?.tags?.category).toContain("command");
    expect(symbol2?.annotation).toBe("Greet note");
    expect(symbol2?.tags?.category).toContain("command");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("excludes annotations when includeAnnotations is false", () => {
    const dir = createTempProject();

    // First pass to index
    generateSourceMap({
      repoRoot: dir,
      includeComments: true,
      includeImports: true,
      includeHeadings: true,
      includeCodeBlocks: true,
      includeStats: false,
      includeAnnotations: true,
      exportedOnly: false,
      output: "text",
    });

    // Add annotations
    const db = openCache(dir);
    db.setFileAnnotation("src/example.ts", "File note");
    db.setSymbolAnnotation(
      {
        path: "src/example.ts",
        symbolName: "greet",
        symbolKind: "function",
        parentName: null,
        signature: null,
      },
      "Symbol note",
    );
    db.addFileAnnotationTags("src/example.ts", [
      { key: "category", value: "command" },
    ]);
    db.addSymbolAnnotationTags(
      {
        path: "src/example.ts",
        symbolName: "greet",
        symbolKind: "function",
        parentName: null,
        signature: null,
      },
      [{ key: "category", value: "command" }],
    );
    db.close();

    // With annotations (default)
    const withAnnotations = generateSourceMap({
      repoRoot: dir,
      includeComments: true,
      includeImports: true,
      includeHeadings: true,
      includeCodeBlocks: true,
      includeStats: false,
      includeAnnotations: true,
      exportedOnly: false,
      output: "text",
    });

    const entry1 = withAnnotations.files.find((f) => f.path === "src/example.ts");
    expect(entry1?.annotation).toBe("File note");
    expect(entry1?.tags?.category).toContain("command");
    expect(entry1?.symbols.find((s) => s.name === "greet")?.annotation).toBe("Symbol note");
    expect(entry1?.symbols.find((s) => s.name === "greet")?.tags?.category).toContain("command");

    // Without annotations
    const withoutAnnotations = generateSourceMap({
      repoRoot: dir,
      includeComments: true,
      includeImports: true,
      includeHeadings: true,
      includeCodeBlocks: true,
      includeStats: false,
      includeAnnotations: false,
      exportedOnly: false,
      output: "text",
    });

    const entry2 = withoutAnnotations.files.find((f) => f.path === "src/example.ts");
    expect(entry2?.annotation).toBeUndefined();
    expect(entry2?.tags).toBeUndefined();
    expect(entry2?.symbols.find((s) => s.name === "greet")?.annotation).toBeUndefined();
    expect(entry2?.symbols.find((s) => s.name === "greet")?.tags).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("validates file exists before saving annotation", () => {
    const dir = createTempProject();

    // Index the project first
    generateSourceMap({
      repoRoot: dir,
      includeComments: true,
      includeImports: true,
      includeHeadings: true,
      includeCodeBlocks: true,
      includeStats: false,
      includeAnnotations: true,
      exportedOnly: false,
      output: "text",
    });

    const db = openCache(dir);
    
    // Valid file should work
    expect(() => {
      const fileRow = db.getFile("src/example.ts");
      if (!fileRow) throw new Error("File not found");
      db.setFileAnnotation("src/example.ts", "Valid note");
    }).not.toThrow();

    // Check file doesn't exist in cache
    const nonExistent = db.getFile("nonexistent.ts");
    expect(nonExistent).toBeUndefined();

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("validates symbol exists before saving annotation", () => {
    const dir = createTempProject();

    // Index the project first
    generateSourceMap({
      repoRoot: dir,
      includeComments: true,
      includeImports: true,
      includeHeadings: true,
      includeCodeBlocks: true,
      includeStats: false,
      includeAnnotations: true,
      exportedOnly: false,
      output: "text",
    });

    const db = openCache(dir);
    
    // Valid symbol should exist
    const validSymbols = db.findSymbols("src/example.ts", "greet", "function", null);
    expect(validSymbols.length).toBeGreaterThan(0);

    // Invalid symbol should not exist
    const invalidSymbols = db.findSymbols("src/example.ts", "nonexistent", "function", null);
    expect(invalidSymbols.length).toBe(0);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("clearFiles preserves annotations, clearAnnotations removes them", () => {
    const dir = createTempProject();

    // Index
    generateSourceMap({
      repoRoot: dir,
      includeComments: true,
      includeImports: true,
      includeHeadings: true,
      includeCodeBlocks: true,
      includeStats: false,
      includeAnnotations: true,
      exportedOnly: false,
      output: "text",
    });

    const db = openCache(dir);

    // Add annotations
    db.setFileAnnotation("src/example.ts", "File note");
    db.setSymbolAnnotation(
      {
        path: "src/example.ts",
        symbolName: "greet",
        symbolKind: "function",
        parentName: null,
        signature: null,
      },
      "Symbol note",
    );
    db.addFileAnnotationTags("src/example.ts", [
      { key: "category", value: "command" },
    ]);
    db.addSymbolAnnotationTags(
      {
        path: "src/example.ts",
        symbolName: "greet",
        symbolKind: "function",
        parentName: null,
        signature: null,
      },
      [{ key: "category", value: "command" }],
    );

    // Verify annotations exist
    expect(db.getFileAnnotation("src/example.ts")).toBe("File note");
    expect(
      db.getSymbolAnnotation({
        path: "src/example.ts",
        symbolName: "greet",
        symbolKind: "function",
        parentName: null,
        signature: null,
      }),
    ).toBe("Symbol note");
    expect(db.getFileAnnotationTags("src/example.ts").category).toContain("command");
    expect(
      db.getSymbolAnnotationTagsMap("src/example.ts")
        .get("greet\u0000function\u0000\u0000")?.category,
    ).toContain("command");

    // Clear files - annotations should remain
    db.clearFiles();
    expect(db.getFileAnnotation("src/example.ts")).toBe("File note");
    expect(
      db.getSymbolAnnotation({
        path: "src/example.ts",
        symbolName: "greet",
        symbolKind: "function",
        parentName: null,
        signature: null,
      }),
    ).toBe("Symbol note");

    // Clear annotations - now they should be gone
    db.clearAnnotations();
    expect(db.getFileAnnotation("src/example.ts")).toBeNull();
    expect(db.getFileAnnotationTags("src/example.ts")).toEqual({});
    expect(
      db.getSymbolAnnotation({
        path: "src/example.ts",
        symbolName: "greet",
        symbolKind: "function",
        parentName: null,
        signature: null,
      }),
    ).toBeNull();
    expect(
      db.getSymbolAnnotationTagsMap("src/example.ts").get("greet\u0000function\u0000\u0000"),
    ).toBeUndefined();

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
