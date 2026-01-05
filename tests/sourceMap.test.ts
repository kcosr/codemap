import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { generateSourceMap } from "../src/sourceMap.js";

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "src", "example.ts"),
    `export function greet(name: string): string {\n  return "hi " + name;\n}\n`,
  );

  fs.writeFileSync(
    path.join(dir, "README.md"),
    `# Project\n\n\`\`\`js\nconsole.log("hi");\n\`\`\`\n`,
  );

  fs.writeFileSync(path.join(dir, "notes.txt"), "plain text\n");

  return dir;
}

describe("generateSourceMap", () => {
  it("generates entries and stats", () => {
    const dir = createTempProject();

    const result = generateSourceMap({
      repoRoot: dir,
      includeComments: true,
      includeImports: true,
      includeHeadings: true,
      includeCodeBlocks: true,
      includeStats: true,
      exportedOnly: false,
      output: "text",
    });

    expect(result.stats).not.toBeNull();

    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/example.ts");
    expect(paths).toContain("README.md");
    expect(paths).toContain("notes.txt");

    const tsEntry = result.files.find((f) => f.path === "src/example.ts");
    expect(tsEntry?.language).toBe("typescript");
    expect(tsEntry?.symbols.length).toBeGreaterThan(0);

    const mdEntry = result.files.find((f) => f.path === "README.md");
    expect(mdEntry?.language).toBe("markdown");
    expect(mdEntry?.headings?.length).toBe(1);
    expect(mdEntry?.codeBlocks?.length).toBe(1);

    const otherEntry = result.files.find((f) => f.path === "notes.txt");
    expect(otherEntry?.language).toBe("other");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("respects content flags", () => {
    const dir = createTempProject();

    const result = generateSourceMap({
      repoRoot: dir,
      includeComments: false,
      includeImports: false,
      includeHeadings: false,
      includeCodeBlocks: false,
      includeStats: false,
      exportedOnly: false,
      output: "text",
    });

    expect(result.stats).toBeNull();

    const mdEntry = result.files.find((f) => f.path === "README.md");
    expect(mdEntry?.headings).toBeUndefined();
    expect(mdEntry?.codeBlocks).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
