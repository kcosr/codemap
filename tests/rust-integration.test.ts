import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { generateSourceMap } from "../src/sourceMap.js";
import { openCache } from "../src/cache/db.js";
import { buildDependencyTree } from "../src/deps/tree.js";

const isBun = typeof (globalThis as any).Bun !== "undefined";
const describeRust = isBun ? describe.skip : describe;

function createRustProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-rust-"));
  fs.mkdirSync(path.join(dir, "src", "foo"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "src", "lib.rs"),
    `pub mod foo;
pub mod utils;

use crate::foo::bar;
use crate::utils;
use std::collections::HashMap;

pub fn run() {
  let _ = bar::do_it();
  let _ = utils::helper();
  let _ = HashMap::<String, String>::new();
}
`,
  );

  fs.writeFileSync(
    path.join(dir, "src", "foo", "mod.rs"),
    `pub mod bar;

use self::bar;
use super::utils;

pub fn call() {
  let _ = bar::do_it();
  let _ = utils::helper();
}
`,
  );

  fs.writeFileSync(
    path.join(dir, "src", "foo", "bar.rs"),
    `pub fn do_it() -> i32 {
  1
}
`,
  );

  fs.writeFileSync(
    path.join(dir, "src", "utils.rs"),
    `pub fn helper() -> i32 {
  2
}
`,
  );

  return dir;
}

describeRust("Rust integration", () => {
  it("resolves use statements and builds dependency tree", () => {
    const dir = createRustProject();

    try {
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

      const libImports = db.getResolvedImports("src/lib.rs");
      const fooImports = db.getResolvedImports("src/foo/mod.rs");

      expect(
        libImports.find((i) => i.source === "crate::foo::bar")?.resolved_path,
      ).toBe("src/foo/bar.rs");
      expect(
        libImports.find((i) => i.source === "crate::utils")?.resolved_path,
      ).toBe("src/utils.rs");

      const stdImport = libImports.find(
        (i) => i.source === "std::collections::HashMap",
      );
      expect(stdImport?.is_external).toBe(1);
      expect(stdImport?.is_builtin).toBe(1);
      expect(stdImport?.package_name).toBe("std");

      expect(
        fooImports.find((i) => i.source === "self::bar")?.resolved_path,
      ).toBe("src/foo/bar.rs");
      expect(
        fooImports.find((i) => i.source === "super::utils")?.resolved_path,
      ).toBe("src/utils.rs");

      const tree = buildDependencyTree(db, "src/lib.rs", 5);
      const childNames = tree.children.map((c) => c.name);
      expect(childNames).toContain("src/foo/bar.rs");
      expect(childNames).toContain("src/utils.rs");

      const stdNode = tree.children.find((c) => c.name === "std");
      expect(stdNode?.kind).toBe("builtin");

      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
