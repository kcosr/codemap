import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { generateSourceMap } from "../src/sourceMap.js";
import { openCache } from "../src/cache/db.js";
import {
  buildDependencyTree,
  buildReverseDependencyTree,
  findCircularDependencies,
} from "../src/deps/tree.js";

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-deps-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "src", "a.ts"),
    `import "./b";\nexport const a = 1;\n`,
  );
  fs.writeFileSync(
    path.join(dir, "src", "b.ts"),
    `import "./c";\nexport const b = 2;\n`,
  );
  fs.writeFileSync(
    path.join(dir, "src", "c.ts"),
    `import "./a";\nexport const c = 3;\n`,
  );
  fs.writeFileSync(path.join(dir, "src", "d.ts"), "export const d = 4;\n");

  return dir;
}

describe("dependency graph helpers", () => {
  it("builds dependency trees and detects cycles", () => {
    const dir = createTempProject();

    generateSourceMap({
      repoRoot: dir,
      includeComments: true,
      includeImports: true,
      includeHeadings: false,
      includeCodeBlocks: false,
      includeStats: false,
      exportedOnly: false,
      output: "text",
    });

    const db = openCache(dir);
    const tree = buildDependencyTree(db, "src/a.ts", 5);
    const childNames = tree.children.map((c) => c.name);
    expect(childNames).toContain("src/b.ts");

    const bNode = tree.children.find((c) => c.name === "src/b.ts");
    const cNode = bNode?.children.find((c) => c.name === "src/c.ts");
    const aNode = cNode?.children.find((c) => c.name === "src/a.ts");
    expect(aNode?.circular).toBe(true);

    const reverse = buildReverseDependencyTree(db, "src/c.ts", 5);
    const reverseNames = reverse.children.map((c) => c.name);
    expect(reverseNames).toContain("src/b.ts");

    const cycles = findCircularDependencies(db);
    const hasCycle = cycles.some(
      (cycle) =>
        cycle.includes("src/a.ts") &&
        cycle.includes("src/b.ts") &&
        cycle.includes("src/c.ts"),
    );
    expect(hasCycle).toBe(true);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
