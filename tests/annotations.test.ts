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
  it("includes file and symbol annotations from cache", () => {
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
    expect(symbol2?.annotation).toBe("Greet note");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
