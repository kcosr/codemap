// Integration test for Phase 2 resolved imports
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
  renderDependencyTree,
} from "../src/deps/tree.js";

function createComplexProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-complex-"));
  fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "utils"), { recursive: true });

  // tsconfig.json with paths
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@lib/*": ["src/lib/*"],
            "@utils/*": ["src/utils/*"],
          },
        },
      },
      null,
      2,
    ),
  );

  // Core types
  fs.writeFileSync(
    path.join(dir, "src", "types.ts"),
    `export type User = { id: number; name: string };
export type Config = { debug: boolean };`,
  );

  // Utils with relative imports
  fs.writeFileSync(
    path.join(dir, "src", "utils", "index.ts"),
    `export * from './helpers';
export * from './format';`,
  );
  fs.writeFileSync(
    path.join(dir, "src", "utils", "helpers.ts"),
    `import type { User } from "../types";
export function getUserName(u: User) { return u.name; }`,
  );
  fs.writeFileSync(
    path.join(dir, "src", "utils", "format.ts"),
    `export function formatDate(d: Date) { return d.toISOString(); }`,
  );

  // Lib with path mappings
  fs.writeFileSync(
    path.join(dir, "src", "lib", "db.ts"),
    `import type { User } from "../types";
import { getUserName } from "@utils/helpers";
export async function saveUser(u: User) {
  console.log(getUserName(u));
}`,
  );
  fs.writeFileSync(
    path.join(dir, "src", "lib", "api.ts"),
    `import { saveUser } from "./db";
import type { User, Config } from "../types";
export async function createUser(name: string) {
  const u: User = { id: 1, name };
  await saveUser(u);
  return u;
}`,
  );

  // Entry point with mixed imports
  fs.writeFileSync(
    path.join(dir, "src", "index.ts"),
    `import { createUser } from "@lib/api";
import * as utils from "@utils/index";
import type { User } from "./types";
import fs from "node:fs";
import React from "react";

async function main() {
  const user = await createUser("test");
  console.log(utils);
}

export { main };`,
  );

  // Dynamic import and require test
  fs.writeFileSync(
    path.join(dir, "src", "dynamic.ts"),
    `const lazy = import("./lib/db");
const req = require("./utils/format");
export const dynamicModule = lazy;`,
  );

  return dir;
}

describe("Phase 2 Integration Tests", () => {
  it("resolves path mappings and relative imports correctly", () => {
    const dir = createComplexProject();

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

      // Check resolved imports for index.ts
      const indexImports = db.getResolvedImports("src/index.ts");
      
      // @lib/api should resolve via paths
      const apiImport = indexImports.find(i => i.source === "@lib/api");
      expect(apiImport).toBeDefined();
      expect(apiImport?.resolved_path).toBe("src/lib/api.ts");
      expect(apiImport?.resolution_method).toBe("paths");

      // @utils/index should resolve via paths
      const utilsImport = indexImports.find(i => i.source === "@utils/index");
      expect(utilsImport).toBeDefined();
      expect(utilsImport?.resolved_path).toBe("src/utils/index.ts");

      // ./types should resolve via relative
      const typesImport = indexImports.find(i => i.source === "./types");
      expect(typesImport).toBeDefined();
      expect(typesImport?.resolved_path).toBe("src/types.ts");
      expect(typesImport?.resolution_method).toBe("relative");

      // node:fs should be builtin
      const fsImport = indexImports.find(i => i.source === "node:fs");
      expect(fsImport).toBeDefined();
      expect(fsImport?.is_builtin).toBe(1);
      expect(fsImport?.is_external).toBe(1);

      // react should be external
      const reactImport = indexImports.find(i => i.source === "react");
      expect(reactImport).toBeDefined();
      expect(reactImport?.is_external).toBe(1);
      expect(reactImport?.package_name).toBe("react");

      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds dependency trees correctly", () => {
    const dir = createComplexProject();

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

      // Forward tree from index.ts
      const tree = buildDependencyTree(db, "src/index.ts", 10);
      expect(tree.name).toBe("src/index.ts");
      
      const childNames = tree.children.map(c => c.name);
      expect(childNames).toContain("src/lib/api.ts");
      expect(childNames).toContain("src/utils/index.ts");
      expect(childNames).toContain("src/types.ts");

      // Check transitive dependencies
      const apiNode = tree.children.find(c => c.name === "src/lib/api.ts");
      expect(apiNode).toBeDefined();
      const apiChildren = apiNode!.children.map(c => c.name);
      expect(apiChildren).toContain("src/lib/db.ts");
      expect(apiChildren).toContain("src/types.ts");

      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds reverse dependency trees correctly", () => {
    const dir = createComplexProject();

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

      // Reverse tree from types.ts - should show what depends on it
      const reverse = buildReverseDependencyTree(db, "src/types.ts", 5);
      expect(reverse.name).toBe("src/types.ts");

      const dependents = reverse.children.map(c => c.name);
      expect(dependents).toContain("src/index.ts");
      expect(dependents).toContain("src/lib/api.ts");
      expect(dependents).toContain("src/lib/db.ts");
      expect(dependents).toContain("src/utils/helpers.ts");

      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles dynamic imports and require correctly", () => {
    const dir = createComplexProject();

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

      const dynamicImports = db.getResolvedImports("src/dynamic.ts");
      
      // Dynamic import should resolve
      const dynImport = dynamicImports.find(i => i.kind === "dynamic_import");
      expect(dynImport).toBeDefined();
      expect(dynImport?.source).toBe("./lib/db");
      expect(dynImport?.resolved_path).toBe("src/lib/db.ts");

      // Require should resolve
      const reqImport = dynamicImports.find(i => i.kind === "require");
      expect(reqImport).toBeDefined();
      expect(reqImport?.source).toBe("./utils/format");
      expect(reqImport?.resolved_path).toBe("src/utils/format.ts");

      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists external packages correctly", () => {
    const dir = createComplexProject();

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
      const external = db.listExternalPackages();
      expect(external).toContain("react");
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
