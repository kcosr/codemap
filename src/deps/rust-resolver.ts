import path from "node:path";
import type { ResolvedImport } from "../types.js";
import type { UseStatement } from "../symbols-rust.js";

export type RustResolverContext = {
  repoRoot: string;
  fileIndex?: Set<string>;
  crateRoot?: string | null;
};

export function createRustResolverContext(
  repoRoot: string,
  fileIndex?: Set<string>,
): RustResolverContext {
  const candidates = ["src/lib.rs", "src/main.rs", "lib.rs", "main.rs"];
  let crateRoot: string | null = null;
  if (fileIndex) {
    for (const candidate of candidates) {
      if (fileIndex.has(candidate)) {
        crateRoot = candidate;
        break;
      }
    }
  }
  return { repoRoot, fileIndex, crateRoot };
}

function resolveModuleFile(
  baseDir: string,
  segments: string[],
  fileIndex?: Set<string>,
): string | null {
  if (!fileIndex) return null;
  if (!baseDir) return null;
  const base = path.posix.join(baseDir, ...segments);
  const candidates = segments.length === 0
    ? [path.posix.join(baseDir, "mod.rs"), `${baseDir}.rs`]
    : [`${base}.rs`, path.posix.join(base, "mod.rs")];
  for (const candidate of candidates) {
    if (fileIndex.has(candidate)) return candidate;
  }
  return null;
}

function isBuiltinCrate(name: string): boolean {
  return name === "std" || name === "core" || name === "alloc";
}

function guessImportedNames(use: UseStatement): string[] {
  if (use.isGlob) return ["*"];
  if (use.aliases.length > 0) return use.aliases;
  const parts = use.source.split("::").filter(Boolean);
  const last = parts.at(-1);
  return last ? [last] : [];
}

export function resolveUseStatements(
  importerPath: string,
  uses: UseStatement[],
  ctx: RustResolverContext,
): ResolvedImport[] {
  const imports: ResolvedImport[] = [];
  const fileIndex = ctx.fileIndex;
  const importerDir = path.posix.dirname(importerPath);
  const importerBase = path.posix.basename(importerPath, ".rs");
  const isModFile = path.posix.basename(importerPath) === "mod.rs";
  const moduleDir = isModFile
    ? importerDir
    : path.posix.join(importerDir, importerBase);
  const crateRootDir = ctx.crateRoot
    ? path.posix.dirname(ctx.crateRoot)
    : null;

  for (const use of uses) {
    const importedNames = guessImportedNames(use);
    const parts = use.source.split("::").filter(Boolean);
    if (parts.length === 0) continue;

    let resolvedPath: string | null = null;
    let isExternal = false;
    let isBuiltin = false;
    let packageName: string | undefined;
    let resolutionMethod: ResolvedImport["resolutionMethod"];
    let unresolvedReason: string | undefined;

    if (parts[0] === "crate" || parts[0] === "self" || parts[0] === "super") {
      let baseDir = moduleDir;
      let idx = 0;
      if (parts[0] === "crate") {
        if (!crateRootDir) {
          unresolvedReason = "rust:crate-root-missing";
          baseDir = "";
        } else {
          baseDir = crateRootDir;
        }
        idx = 1;
      } else if (parts[0] === "self") {
        baseDir = moduleDir;
        idx = 1;
      } else {
        baseDir = moduleDir;
        while (parts[idx] === "super") {
          baseDir = path.posix.dirname(baseDir);
          idx += 1;
        }
      }

      const remaining = parts.slice(idx);
      if (parts[0] === "self" && remaining.length === 0) {
        resolvedPath = importerPath;
      } else {
        resolvedPath = resolveModuleFile(baseDir, remaining, fileIndex);
      }

      resolutionMethod = "relative";
      if (!resolvedPath && !unresolvedReason) {
        unresolvedReason = "rust:unresolved";
      }
    } else {
      isExternal = true;
      packageName = parts[0];
      isBuiltin = isBuiltinCrate(packageName);
    }

    imports.push({
      source: use.source,
      resolvedPath,
      importedNames,
      kind: "import",
      isTypeOnly: false,
      isExternal,
      isBuiltin,
      packageName,
      resolutionMethod,
      unresolvedReason,
    });
  }

  return imports;
}
