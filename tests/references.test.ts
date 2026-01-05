import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { generateSourceMap } from "../src/sourceMap.js";

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-refs-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          strict: false,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(dir, "src", "a.ts"),
    [
      "export function foo(): void {}",
      "export class Bar {}",
      "export interface IFoo {}",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(dir, "src", "b.ts"),
    [
      "import { foo, Bar, IFoo } from './a';",
      "export class Baz extends Bar implements IFoo {",
      "  method() {",
      "    foo();",
      "    new Bar();",
      "  }",
      "}",
    ].join("\n"),
  );

  return dir;
}

function createScopedProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-refs-scope-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          strict: false,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(dir, "src", "hidden.ts"),
    "export function hidden(): void {}\n",
  );

  fs.writeFileSync(
    path.join(dir, "src", "entry.ts"),
    [
      "import { hidden } from './hidden';",
      "export function run(): void {",
      "  hidden();",
      "}",
    ].join("\n"),
  );

  return dir;
}

describe("reference extraction", () => {
  it("captures structural references across files", () => {
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
      includeRefs: true,
      refsMode: "structural",
      refsDirection: "both",
      maxRefs: 50,
    });

    const aEntry = result.files.find((f) => f.path === "src/a.ts");
    const bEntry = result.files.find((f) => f.path === "src/b.ts");

    const fooSymbol = aEntry?.symbols.find((s) => s.name === "foo");
    const barSymbol = aEntry?.symbols.find((s) => s.name === "Bar");
    const iFooSymbol = aEntry?.symbols.find((s) => s.name === "IFoo");
    const bazSymbol = bEntry?.symbols.find((s) => s.name === "Baz");

    expect(fooSymbol?.incomingRefs?.items.some((item) =>
      item.refKind === "call" && item.refPath === "src/b.ts")).toBe(true);
    expect(barSymbol?.incomingRefs?.byKind.extends).toBeGreaterThan(0);
    expect(iFooSymbol?.incomingRefs?.byKind.implements).toBeGreaterThan(0);
    expect(bazSymbol?.outgoingRefs?.byKind.extends).toBeGreaterThan(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats refs to non-indexed files as external", () => {
    const dir = createScopedProject();

    const result = generateSourceMap({
      repoRoot: dir,
      patterns: ["src/entry.ts"],
      includeComments: false,
      includeImports: false,
      includeHeadings: false,
      includeCodeBlocks: false,
      includeStats: false,
      exportedOnly: false,
      output: "text",
      includeRefs: true,
      refsMode: "structural",
      refsDirection: "out",
      maxRefs: 50,
    });

    const entry = result.files.find((f) => f.path === "src/entry.ts");
    const runSymbol = entry?.symbols.find((s) => s.name === "run");
    const callRefs = runSymbol?.outgoingRefs?.items ?? [];
    const hasExternalCall = callRefs.some((item) =>
      item.refKind === "call" &&
      item.symbolName === "hidden" &&
      item.symbolPath === null
    );

    expect(hasExternalCall).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
