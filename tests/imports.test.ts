import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { extractFileSymbolsDetailed } from "../src/symbols.js";
import { discoverFiles } from "../src/fileDiscovery.js";
import { createResolverContext, resolveImports } from "../src/deps/resolver.js";

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-imports-"));
  fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@lib/*": ["src/lib/*"],
          },
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(dir, "src", "utils.ts"), "export const utils = 1;");
  fs.writeFileSync(
    path.join(dir, "src", "lib", "helper.ts"),
    "export const helper = 1;",
  );
  fs.writeFileSync(path.join(dir, "src", "types.ts"), "export type Foo = string;");
  fs.writeFileSync(path.join(dir, "src", "dyn.ts"), "export const dyn = 1;");
  fs.writeFileSync(path.join(dir, "src", "req.ts"), "export const req = 1;");

  fs.writeFileSync(
    path.join(dir, "src", "index.ts"),
    `
import defaultExport, { named as alias } from "./utils";
import * as ns from "./utils";
import "./side-effect";
import type { Foo } from "./types";
export { helper as helperAlias } from "@lib/helper";
export * from "./types";
import "node:fs";
import React from "react";
const moduleName = "./dyn";
const dyn = import(moduleName);
const req = require("./req");
`,
  );

  return dir;
}

describe("extractFileSymbolsDetailed", () => {
  it("captures import specs for common import forms", () => {
    const content = `
import defaultExport, { named as alias } from "./local";
import * as ns from "./ns";
import "./side";
import type { TypeOnly } from "./types";
export { foo, bar as baz } from "./re";
export * from "./star";
const dyn = import("./dyn");
const req = require("./req");
`;
    const result = extractFileSymbolsDetailed("src/example.ts", content);
    const specs = result.importSpecs;

    const local = specs.find(
      (s) => s.source === "./local" && s.kind === "import",
    );
    expect(local?.importedNames).toEqual(expect.arrayContaining(["default", "named"]));

    const nsImport = specs.find(
      (s) => s.source === "./ns" && s.kind === "import",
    );
    expect(nsImport?.importedNames).toContain("*");

    const sideEffect = specs.find(
      (s) => s.source === "./side" && s.kind === "side_effect",
    );
    expect(sideEffect?.importedNames).toEqual([]);

    const typeOnly = specs.find(
      (s) => s.source === "./types" && s.kind === "import",
    );
    expect(typeOnly?.isTypeOnly).toBe(true);

    const exportFrom = specs.find(
      (s) => s.source === "./re" && s.kind === "export_from",
    );
    expect(exportFrom?.importedNames).toEqual(
      expect.arrayContaining(["foo", "bar"]),
    );

    const exportStar = specs.find(
      (s) => s.source === "./star" && s.kind === "export_from",
    );
    expect(exportStar?.importedNames).toContain("*");

    const dyn = specs.find(
      (s) => s.source === "./dyn" && s.kind === "dynamic_import",
    );
    expect(dyn).toBeDefined();

    const req = specs.find(
      (s) => s.source === "./req" && s.kind === "require",
    );
    expect(req).toBeDefined();
  });
});

describe("resolveImports", () => {
  it("resolves relative, paths, and external imports", () => {
    const dir = createTempProject();
    const entryPath = "src/index.ts";
    const content = fs.readFileSync(path.join(dir, entryPath), "utf-8");
    const { importSpecs } = extractFileSymbolsDetailed(entryPath, content);
    const fileIndex = new Set(discoverFiles({ repoRoot: dir }));
    const ctx = createResolverContext(dir, fileIndex, { useTsconfig: true });

    const resolved = resolveImports(entryPath, importSpecs, ctx);

    const relative = resolved.find((r) => r.source === "./utils");
    expect(relative?.resolvedPath).toBe("src/utils.ts");
    expect(relative?.resolutionMethod).toBe("relative");

    const mapped = resolved.find((r) => r.source === "@lib/helper");
    expect(mapped?.resolvedPath).toBe("src/lib/helper.ts");
    expect(mapped?.resolutionMethod).toBe("paths");

    const builtin = resolved.find((r) => r.source === "node:fs");
    expect(builtin?.isExternal).toBe(true);
    expect(builtin?.isBuiltin).toBe(true);

    const external = resolved.find((r) => r.source === "react");
    expect(external?.isExternal).toBe(true);
    expect(external?.packageName).toBe("react");

    const nonLiteral = resolved.find(
      (r) => r.kind === "dynamic_import" && r.source === "moduleName",
    );
    expect(nonLiteral?.unresolvedReason).toBe("non_literal");

    const req = resolved.find((r) => r.kind === "require" && r.source === "./req");
    expect(req?.resolvedPath).toBe("src/req.ts");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
