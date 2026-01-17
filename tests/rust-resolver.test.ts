import { describe, it, expect } from "vitest";
import {
  createRustResolverContext,
  resolveUseStatements,
} from "../src/deps/rust-resolver.js";
import type { UseStatement } from "../src/symbols-rust.js";

describe("resolveUseStatements (Rust)", () => {
  const fileIndex = new Set([
    "src/lib.rs",
    "src/foo/mod.rs",
    "src/foo/bar.rs",
    "src/foo/baz/mod.rs",
    "src/qux.rs",
  ]);
  const ctx = createRustResolverContext("/repo", fileIndex);

  it("resolves crate and external use paths", () => {
    const uses: UseStatement[] = [
      { source: "crate::foo::bar", kind: "use", isGlob: false, aliases: [], line: 1 },
      { source: "crate::foo::baz", kind: "use", isGlob: false, aliases: [], line: 2 },
      { source: "crate::qux", kind: "use", isGlob: false, aliases: [], line: 3 },
      { source: "std::collections::HashMap", kind: "use", isGlob: false, aliases: [], line: 4 },
    ];

    const resolved = resolveUseStatements("src/lib.rs", uses, ctx);

    expect(resolved.find((r) => r.source === "crate::foo::bar")?.resolvedPath).toBe(
      "src/foo/bar.rs",
    );
    expect(resolved.find((r) => r.source === "crate::foo::baz")?.resolvedPath).toBe(
      "src/foo/baz/mod.rs",
    );
    expect(resolved.find((r) => r.source === "crate::qux")?.resolvedPath).toBe(
      "src/qux.rs",
    );

    const stdImport = resolved.find(
      (r) => r.source === "std::collections::HashMap",
    );
    expect(stdImport?.isExternal).toBe(true);
    expect(stdImport?.isBuiltin).toBe(true);
    expect(stdImport?.packageName).toBe("std");
  });

  it("resolves self and super paths", () => {
    const uses: UseStatement[] = [
      { source: "self::bar", kind: "use", isGlob: false, aliases: [], line: 1 },
      { source: "super::qux", kind: "use", isGlob: false, aliases: [], line: 2 },
    ];

    const resolved = resolveUseStatements("src/foo/mod.rs", uses, ctx);

    expect(resolved.find((r) => r.source === "self::bar")?.resolvedPath).toBe(
      "src/foo/bar.rs",
    );
    expect(resolved.find((r) => r.source === "super::qux")?.resolvedPath).toBe(
      "src/qux.rs",
    );
  });
});
