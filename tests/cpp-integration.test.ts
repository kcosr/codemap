import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { generateSourceMap } from "../src/sourceMap.js";
import { openCache } from "../src/cache/db.js";
import { buildDependencyTree } from "../src/deps/tree.js";

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-cpp-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "src", "foo.hpp"),
    `#pragma once\nstruct Foo { int value; };\n`,
  );
  fs.writeFileSync(
    path.join(dir, "src", "foo.cpp"),
    `#include <vector>\n#include \"foo.hpp\"\n\nint main() { return 0; }\n`,
  );

  return dir;
}

describe("C++ dependency integration", () => {
  it("resolves local includes and records system includes", () => {
    const dir = createTempProject();

    generateSourceMap({
      repoRoot: dir,
      includeComments: false,
      includeImports: true,
      includeHeadings: false,
      includeCodeBlocks: false,
      includeStats: false,
      exportedOnly: false,
      output: "text",
    });

    const db = openCache(dir);
    const tree = buildDependencyTree(db, "src/foo.cpp", 5);
    const childNames = tree.children.map((c) => c.name);
    expect(childNames).toContain("src/foo.hpp");
    expect(tree.children.some((c) => c.name === "vector" && c.kind === "builtin"))
      .toBe(true);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
