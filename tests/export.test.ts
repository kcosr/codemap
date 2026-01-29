import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { generateSourceMap } from "../src/sourceMap.js";
import { openCache } from "../src/cache/db.js";
import { buildAnnotationIndex } from "../src/export.js";

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-export-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "src", "a.ts"),
    `export function a(): string {\n  return "a";\n}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "src", "b.ts"),
    `export function b(): string {\n  return "b";\n}\n`,
  );

  return dir;
}

describe("annotation export", () => {
  it("exports only annotated files by default", () => {
    const dir = createTempProject();

    generateSourceMap({
      repoRoot: dir,
      includeComments: true,
      includeImports: true,
      includeHeadings: true,
      includeCodeBlocks: true,
      includeStats: false,
      exportedOnly: false,
      output: "text",
    });

    const db = openCache(dir);
    db.setFileAnnotation("src/a.ts", "Annotated A");

    const index = buildAnnotationIndex(db);
    expect(index.files.map((file) => file.path)).toEqual(["src/a.ts"]);

    const indexAll = buildAnnotationIndex(db, { includeAll: true });
    expect(indexAll.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
